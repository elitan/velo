import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Table2,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { AppSidebar } from '#web/components/control-plane';
import { Button } from '#web/components/ui/button';
import { Input } from '#web/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#web/components/ui/select';
import { orpc } from '#web/lib/api-client';
import { getMutationErrorMessage } from '#web/lib/errors';
import { cn } from '#lib/utils';
import { isProductionBranchId } from '#utils/prod-write-guard';
import {
  DeleteRowDialog,
  RowEditorDialog,
  type DeleteRowState,
  type RowDraftField,
  type RowEditorState,
  type TableActionTarget,
} from './-table-row-dialogs';

export const Route = createFileRoute('/branch/$branchId/tables')({
  component: BranchTablesPage,
});

const TABLE_ROW_ID_COLUMN = '__velo_ctid';

function BranchTablesPage() {
  const params = Route.useParams();
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const [selected, setSelected] = useState<TableKey | null>(null);
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<RowEditorState | null>(null);
  const [rowToDelete, setRowToDelete] = useState<DeleteRowState | null>(null);
  const metadata = useQuery({
    ...orpc.tables.browse.queryOptions({
      input: {
        branchId: params.branchId,
        database: selected?.database,
        schema: selected?.schema,
      },
    }),
    enabled: Boolean(dashboard.data),
  });
  const selectedDatabase = metadata.data?.selectedDatabase || selected?.database || 'postgres';
  const selectedSchema = metadata.data?.selectedSchema || selected?.schema || 'public';
  const selectedTable = selected?.name || metadata.data?.selectedTable?.name || '';
  const rows = useQuery({
    ...orpc.tables.rows.queryOptions({
      input: {
        branchId: params.branchId,
        database: selectedDatabase,
        schema: selectedSchema,
        table: selectedTable,
        offset: selected?.offset,
      },
    }),
    enabled: Boolean(dashboard.data) && Boolean(selectedTable),
    placeholderData: function keepRowsVisible(previousData) {
      return previousData;
    },
  });
  const insertRow = useMutation(orpc.tables.insert.mutationOptions({
    onSuccess: refreshAfterMutation,
  }));
  const updateRow = useMutation(orpc.tables.update.mutationOptions({
    onSuccess: refreshAfterMutation,
  }));
  const deleteRow = useMutation(orpc.tables.delete.mutationOptions({
    onSuccess: refreshAfterMutation,
  }));

  useEffect(function resetBranchScopedState() {
    setSelected(null);
    setSearch('');
    setEditor(null);
    setRowToDelete(null);
  }, [params.branchId]);

  useEffect(function setInitialTable() {
    if (selected || !metadata.data?.selectedTable) {
      return;
    }

    setSelected({
      database: metadata.data.selectedDatabase,
      schema: metadata.data.selectedTable.schema,
      name: metadata.data.selectedTable.name,
      offset: 0,
    });
  }, [selected, metadata.data]);

  const branches = dashboard.data?.branches || [];
  const filteredTables = useMemo(function filterTables() {
    const term = search.trim().toLowerCase();

    if (!term) {
      return metadata.data?.tables || [];
    }

    return (metadata.data?.tables || []).filter(function tableMatches(table) {
      return table.name.toLowerCase().includes(term);
    });
  }, [search, metadata.data?.tables]);

  function selectDatabase(database: string) {
    setSearch('');
    setSelected({ database, schema: 'public', offset: 0 });
  }

  function selectSchema(schema: string) {
    setSearch('');
    setSelected({
      database: metadata.data?.selectedDatabase || selected?.database,
      schema,
      offset: 0,
    });
  }

  function selectPage(offset: number) {
    setSelected({
      database: selectedDatabase,
      schema: selectedSchema,
      name: selectedTable,
      offset,
    });
  }

  function refreshAfterMutation() {
    void rows.refetch();
  }

  function getCurrentRowsTarget(): TableActionTarget | null {
    if (!rows.data || !rowDataMatches(rows.data, params.branchId, selectedDatabase, selectedSchema, selectedTable)) {
      return null;
    }

    return {
      branchId: rows.data.branchId,
      database: rows.data.database,
      schema: rows.data.schema,
      table: rows.data.table,
    };
  }

  function openAddRow() {
    const target = getCurrentRowsTarget();

    if (!rows.data || !target) {
      return;
    }

    setEditor({
      mode: 'insert',
      target,
      rowId: null,
      fields: createInsertDraft(rows.data.columns),
    });
  }

  function openEditRow(row: Record<string, unknown>) {
    const target = getCurrentRowsTarget();

    if (!rows.data || !target) {
      return;
    }

    setEditor({
      mode: 'edit',
      target,
      rowId: formatCell(row[TABLE_ROW_ID_COLUMN]),
      fields: createEditDraft(rows.data.columns, row),
    });
  }

  function openDeleteRow(row: Record<string, unknown>) {
    const target = getCurrentRowsTarget();

    if (!rows.data || !target) {
      return;
    }

    setRowToDelete({
      target,
      rowId: formatCell(row[TABLE_ROW_ID_COLUMN]),
      label: createDeleteLabel(row, rows.data.columns),
    });
  }

  function closeEditor() {
    if (insertRow.isPending || updateRow.isPending) {
      return;
    }

    setEditor(null);
  }

  function closeDeleteDialog() {
    if (deleteRow.isPending) {
      return;
    }

    setRowToDelete(null);
  }

  async function confirmDeleteRow(productionWriteConfirmation: string) {
    if (!rowToDelete) {
      return;
    }

    if (rowToDelete.target.branchId !== params.branchId) {
      toast.error('Branch changed. Reopen this row from the current branch.');
      return;
    }

    try {
      await deleteRow.mutateAsync({
        branchId: rowToDelete.target.branchId,
        database: rowToDelete.target.database,
        schema: rowToDelete.target.schema,
        table: rowToDelete.target.table,
        rowId: rowToDelete.rowId,
        productionWriteConfirmation: isProduction ? productionWriteConfirmation : undefined,
      });
      setRowToDelete(null);
      toast.success('Row deleted.');
    } catch (caught: any) {
      toast.error(getMutationErrorMessage(caught, 'Could not delete row'));
    }
  }

  function updateDraftField(column: string, patch: Partial<RowDraftField>) {
    setEditor(function updateCurrentEditor(current) {
      if (!current) {
        return current;
      }

      return {
        ...current,
        fields: current.fields.map(function updateField(field) {
          if (field.column !== column) {
            return field;
          }

          return {
            ...field,
            ...patch,
          };
        }),
      };
    });
  }

  async function saveEditor(productionWriteConfirmation: string) {
    if (!editor) {
      return;
    }

    if (editor.target.branchId !== params.branchId) {
      toast.error('Branch changed. Reopen this row from the current branch.');
      return;
    }

    const values = buildEditorValues(editor);

    try {
      if (editor.mode === 'insert') {
        await insertRow.mutateAsync({
          branchId: editor.target.branchId,
          database: editor.target.database,
          schema: editor.target.schema,
          table: editor.target.table,
          values,
          productionWriteConfirmation: isProduction ? productionWriteConfirmation : undefined,
        });
      } else if (editor.rowId) {
        await updateRow.mutateAsync({
          branchId: editor.target.branchId,
          database: editor.target.database,
          schema: editor.target.schema,
          table: editor.target.table,
          rowId: editor.rowId,
          values,
          productionWriteConfirmation: isProduction ? productionWriteConfirmation : undefined,
        });
      }

      setEditor(null);
      toast.success(editor.mode === 'insert' ? 'Row added.' : 'Row saved.');
    } catch (caught: any) {
      toast.error(getMutationErrorMessage(caught, 'Could not save row'));
    }
  }

  const rowOffset = rows.data?.rowOffset || selected?.offset || 0;
  const rowLimit = rows.data?.rowLimit || 50;
  const rowEnd = rows.data ? Math.min(rows.data.rowOffset + rows.data.rowLimit, rows.data.rowCount) : rowOffset + rowLimit;
  const canPageBack = rowOffset > 0;
  const canPageForward = rows.data ? rowOffset + rowLimit < rows.data.rowCount : false;
  const saving = insertRow.isPending || updateRow.isPending;
  const deleting = deleteRow.isPending;
  const rowsReady = Boolean(rows.data && rowDataMatches(rows.data, params.branchId, selectedDatabase, selectedSchema, selectedTable));
  const isProduction = isProductionBranchId(params.branchId);
  const tableActionsDisabled = !rowsReady;
  const contentGridRows = isProduction ? 'grid-rows-[auto_auto_1fr]' : 'grid-rows-[auto_1fr]';

  return (
    <>
      <main className="min-h-screen bg-background text-foreground">
        <div className="flex min-h-screen flex-col lg:grid lg:grid-cols-[244px_1fr]">
          <AppSidebar branches={branches} activeBranchPage="tables" selectedBranch={params.branchId} />

          <section className="min-h-screen min-w-0">
          <div className="grid min-h-screen lg:grid-cols-[280px_1fr]">
            <aside className="grid min-h-0 grid-rows-[auto_auto_1fr] border-r border-border bg-muted/20">
              <div className="border-b border-border p-4">
                <Select value={selectedDatabase} onValueChange={selectDatabase}>
                  <SelectTrigger className="h-10 w-full bg-background font-medium">
                    <Database className="size-4 text-muted-foreground" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" className="min-w-(--radix-select-trigger-width)">
                    <SelectGroup>
                      {(metadata.data?.databases || [metadata.data?.selectedDatabase || selected?.database || 'postgres']).map(function renderDatabase(database) {
                        return (
                          <SelectItem key={database} value={database}>
                            {database}
                          </SelectItem>
                        );
                      })}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>

              <div className="border-b border-border p-4">
                <Select value={selectedSchema} onValueChange={selectSchema}>
                  <SelectTrigger className="h-10 w-full bg-background font-medium">
                    <Table2 className="size-4 text-muted-foreground" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" className="min-w-(--radix-select-trigger-width)">
                    <SelectGroup>
                      {(metadata.data?.schemas || [metadata.data?.selectedSchema || selected?.schema || 'public']).map(function renderSchema(schema) {
                        return (
                          <SelectItem key={schema} value={schema}>
                            {schema}
                          </SelectItem>
                        );
                      })}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="mt-3 flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={function updateSearch(event) {
                        setSearch(event.target.value);
                      }}
                      className="pl-9"
                      placeholder="Search..."
                    />
                  </div>
                </div>
              </div>

              <div className="min-h-0 overflow-auto p-3">
                {metadata.isLoading ? (
                  <EmptySideLabel label="Loading tables..." />
                ) : filteredTables.length === 0 ? (
                  <EmptySideLabel label={search.trim() ? 'No matching tables' : 'No tables'} />
                ) : (
                  <div className="grid gap-1">
                    {filteredTables.map(function renderTable(table) {
                      const active = selectedSchema === table.schema && selectedTable === table.name;

                      return (
                        <button
                          key={`${table.schema}.${table.name}`}
                          type="button"
                          className={cn(
                            'flex h-9 min-w-0 items-center gap-2 rounded-md px-3 text-left text-sm text-muted-foreground hover:bg-background hover:text-foreground',
                            active && 'bg-background font-medium text-foreground shadow-sm'
                          )}
                          onClick={function selectTable() {
                            setSelected({
                              database: metadata.data?.selectedDatabase || selected?.database,
                              schema: table.schema,
                              name: table.name,
                              offset: 0,
                            });
                          }}
                        >
                          <Table2 className="size-4 shrink-0" />
                          <span className="truncate">{table.name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </aside>

            <div className={cn('grid min-h-0', contentGridRows)}>
              {isProduction ? (
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
                  <ShieldAlert className="size-4" />
                  <span className="font-medium">production database</span>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center justify-end gap-2 border-b border-border px-3 py-2">
                <div className="text-xs text-muted-foreground">
                  {rows.data ? `${rows.data.rowLimit} rows · ${rows.data.elapsedMs}ms` : 'Loading...'}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={tableActionsDisabled || !rows.data || rows.data.columns.length === 0}
                  onClick={openAddRow}
                >
                  <Plus className="size-3.5" />
                  Add row
                </Button>
                <div className="flex h-8 overflow-hidden rounded-md border border-input bg-background">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-none border-r border-border"
                    disabled={!canPageBack}
                    onClick={function pageBack() {
                      selectPage(Math.max(0, rowOffset - rowLimit));
                    }}
                  >
                    <ChevronLeft className="size-3.5" />
                  </Button>
                  <div className="grid h-8 w-11 place-items-center border-r border-border font-mono text-xs">
                    {rowOffset}
                  </div>
                  <div className="grid h-8 w-11 place-items-center border-r border-border font-mono text-xs">
                    {rowEnd}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-none"
                    disabled={!canPageForward}
                    onClick={function pageForward() {
                      selectPage(rowOffset + rowLimit);
                    }}
                  >
                    <ChevronRight className="size-3.5" />
                  </Button>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Refresh rows"
                  className="size-8"
                  onClick={function refreshRows() {
                    void rows.refetch();
                  }}
                >
                  <RefreshCw className="size-3.5" />
                </Button>
              </div>

              <TableGrid
                data={rows.data}
                loading={rows.isLoading}
                error={rows.error}
                actionsDisabled={tableActionsDisabled}
                onEditRow={openEditRow}
                onDeleteRow={openDeleteRow}
              />
            </div>
          </div>
          </section>
        </div>
      </main>

      <RowEditorDialog
        editor={editor}
        selectedLabel={`${selectedSchema}.${selectedTable}`}
        isProduction={isProduction}
        saving={saving}
        onClose={closeEditor}
        onChangeField={updateDraftField}
        onSave={saveEditor}
      />

      <DeleteRowDialog
        rowToDelete={rowToDelete}
        isProduction={isProduction}
        deleting={deleting}
        onClose={closeDeleteDialog}
        onDelete={confirmDeleteRow}
      />
    </>
  );
}

interface TableKey {
  database?: string;
  schema: string;
  name?: string;
  offset?: number;
}

interface TableGridProps {
  data: Awaited<ReturnType<typeof orpc.tables.rows.call>> | undefined;
  loading: boolean;
  error: Error | null;
  actionsDisabled: boolean;
  onEditRow: (row: Record<string, unknown>) => void;
  onDeleteRow: (row: Record<string, unknown>) => void;
}

function TableGrid(props: TableGridProps) {
  if (props.loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading rows...</div>;
  }

  if (props.error) {
    return <div className="p-6 text-sm text-destructive">{props.error.message}</div>;
  }

  if (!props.data) {
    return <div className="p-6 text-sm text-muted-foreground">No table selected.</div>;
  }

  const data = props.data;

  return (
    <div className="min-h-0 overflow-auto">
      <table className="min-w-full border-separate border-spacing-0 text-sm">
        <thead className="sticky top-0 z-10 bg-background">
          <tr>
            <th className="h-9 w-10 border-b border-r border-border px-3 text-left font-medium text-muted-foreground" />
            {data.columns.map(function renderColumn(column) {
              return (
                <th
                  key={column.name}
                  className="h-9 min-w-48 border-b border-r border-border px-3 text-left font-medium text-muted-foreground"
                  title={`${column.name} ${column.type}`}
                >
                  <span className="block max-w-64 truncate">
                    {column.name} <span className="font-normal">{column.type}</span>
                  </span>
                </th>
              );
            })}
            <th className="sticky right-0 z-20 h-9 w-20 border-b border-l border-r border-border bg-background px-3 text-left font-medium text-muted-foreground" />
          </tr>
        </thead>
        <tbody>
          {props.data.rows.length === 0 ? (
            <tr>
              <td className="p-6 text-sm text-muted-foreground" colSpan={data.columns.length + 2}>
                No rows.
              </td>
            </tr>
          ) : (
            data.rows.map(function renderRow(row, index) {
              return (
                <tr key={index} className="group hover:bg-muted/40">
                  <td className="h-9 border-b border-r border-border px-3 font-mono text-xs text-muted-foreground">
                    {data.rowOffset + index + 1}
                  </td>
                  {data.columns.map(function renderCell(column) {
                    return (
                      <td
                        key={column.name}
                        className="h-9 max-w-72 border-b border-r border-border px-3 font-mono text-xs"
                        title={formatCell(row[column.name])}
                      >
                        <span className="block truncate">{formatCell(row[column.name])}</span>
                      </td>
                    );
                  })}
                  <td className="sticky right-0 h-9 border-b border-l border-r border-border bg-background px-2 group-hover:bg-muted">
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 hover:bg-accent"
                        aria-label="Edit row"
                        disabled={props.actionsDisabled}
                        onClick={function editRow() {
                          props.onEditRow(row);
                        }}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 hover:bg-accent"
                        aria-label="Delete row"
                        disabled={props.actionsDisabled}
                        onClick={function deleteRow() {
                          props.onDeleteRow(row);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function createInsertDraft(columns: Array<{ name: string; type: string; nullable: boolean; defaultValue: string | null }>): RowDraftField[] {
  return columns.map(function createField(column) {
    return {
      column: column.name,
      type: column.type,
      value: '',
      isNull: column.nullable && column.defaultValue === null,
      enabled: column.defaultValue === null,
    };
  });
}

function createEditDraft(columns: Array<{ name: string; type: string }>, row: Record<string, unknown>): RowDraftField[] {
  return columns.map(function createField(column) {
    const value = row[column.name];
    const isNull = value === null;

    return {
      column: column.name,
      type: column.type,
      value: isNull ? '' : formatCell(value),
      isNull,
      enabled: true,
    };
  });
}

function createDeleteLabel(row: Record<string, unknown>, columns: Array<{ name: string }>): string {
  const firstColumn = columns[0]?.name;

  if (!firstColumn) {
    return `row ${formatCell(row[TABLE_ROW_ID_COLUMN])}`;
  }

  const firstValue = formatCell(row[firstColumn]);
  return `${firstColumn} ${firstValue}`;
}

function rowDataMatches(
  data: Awaited<ReturnType<typeof orpc.tables.rows.call>>,
  branchId: string,
  database: string,
  schema: string,
  table: string
): boolean {
  return data.branchId === branchId
    && data.database === database
    && data.schema === schema
    && data.table === table;
}

function buildEditorValues(editor: RowEditorState): Record<string, string | null> {
  return Object.fromEntries(
    editor.fields
      .filter(function keepField(field) {
        return field.enabled;
      })
      .map(function mapField(field) {
        return [field.column, field.isNull ? null : field.value];
      })
  );
}

function EmptySideLabel(props: { label: string }) {
  return <div className="px-3 py-2 text-sm text-muted-foreground">{props.label}</div>;
}

function formatCell(value: unknown): string {
  if (value === null) {
    return 'NULL';
  }

  if (value === undefined) {
    return '';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}
