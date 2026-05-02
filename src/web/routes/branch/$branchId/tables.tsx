import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Database,
  RefreshCw,
  Search,
  Table2,
} from 'lucide-react';
import { AppSidebar } from '#web/components/control-plane';
import { Badge } from '#web/components/ui/badge';
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
import { cn } from '#lib/utils';

export const Route = createFileRoute('/branch/$branchId/tables')({
  component: BranchTablesPage,
});

function BranchTablesPage() {
  const params = Route.useParams();
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const [selected, setSelected] = useState<TableKey | null>(null);
  const [search, setSearch] = useState('');
  const metadata = useQuery(orpc.tables.browse.queryOptions({
    input: {
      branchId: params.branchId,
      database: selected?.database,
      schema: selected?.schema,
    },
  }));
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
    enabled: Boolean(selectedTable),
    placeholderData: function keepRowsVisible(previousData) {
      return previousData;
    },
  });

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
      return `${table.schema}.${table.name}`.toLowerCase().includes(term);
    });
  }, [search, metadata.data?.tables]);

  function selectDatabase(database: string) {
    setSelected({ database, schema: 'public', offset: 0 });
  }

  function selectSchema(schema: string) {
    setSelected({
      database: metadata.data?.selectedDatabase || selected?.database,
      schema,
      offset: 0,
    });
  }

  function selectPage(offset: number) {
    setSelected({
      database: metadata.data?.selectedDatabase || selected?.database,
      schema: metadata.data?.selectedSchema || selected?.schema || 'public',
      name: metadata.data?.selectedTable?.name || selected?.name,
      offset,
    });
  }

  const rowOffset = rows.data?.rowOffset || selected?.offset || 0;
  const rowLimit = rows.data?.rowLimit || 50;
  const rowEnd = rows.data ? Math.min(rows.data.rowOffset + rows.data.rowLimit, rows.data.rowCount) : rowOffset + rowLimit;
  const canPageBack = rowOffset > 0;
  const canPageForward = rows.data ? rowOffset + rowLimit < rows.data.rowCount : false;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={branches} activeBranchPage="tables" selectedBranch={params.branchId} />

        <section className="grid min-h-screen min-w-0 grid-rows-[auto_1fr]">
          <header className="border-b border-border px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Tables</Badge>
                  <Badge variant="secondary">read only</Badge>
                </div>
                <h1 className="mt-2 text-2xl font-semibold tracking-normal">Tables</h1>
                <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <span>{params.branchId}</span>
                  <span>/</span>
                  <span>{metadata.data?.selectedTable ? metadata.data.selectedTable.name : 'no table'}</span>
                </div>
              </div>
            </div>
          </header>

          <div className="grid min-h-0 lg:grid-cols-[280px_1fr]">
            <aside className="grid min-h-0 grid-rows-[auto_auto_1fr] border-r border-border bg-muted/20">
              <div className="border-b border-border p-4">
                <Select value={metadata.data?.selectedDatabase || selected?.database || 'postgres'} onValueChange={selectDatabase}>
                  <SelectTrigger className="h-10 w-full bg-background font-medium">
                    <Database className="size-4 text-muted-foreground" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
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
                <Select value={metadata.data?.selectedSchema || selected?.schema || 'public'} onValueChange={selectSchema}>
                  <SelectTrigger className="h-10 w-full bg-background font-medium">
                    <Table2 className="size-4 text-muted-foreground" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
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
                  <EmptySideLabel label="No tables" />
                ) : (
                  <div className="grid gap-1">
                    {filteredTables.map(function renderTable(table) {
                      const active = metadata.data?.selectedTable?.schema === table.schema
                        && metadata.data.selectedTable.name === table.name;

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

            <div className="grid min-h-0 grid-rows-[auto_1fr]">
              <div className="flex flex-wrap items-center justify-end gap-2 border-b border-border px-3 py-2">
                <div className="text-xs text-muted-foreground">
                  {rows.data ? `${rows.data.rowLimit} rows · ${rows.data.elapsedMs}ms` : 'Loading...'}
                </div>
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

              <TableGrid data={rows.data} loading={rows.isLoading} error={rows.error} />
            </div>
          </div>
        </section>
      </div>
    </main>
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
          </tr>
        </thead>
        <tbody>
          {props.data.rows.length === 0 ? (
            <tr>
              <td className="p-6 text-sm text-muted-foreground" colSpan={data.columns.length + 1}>
                No rows.
              </td>
            </tr>
          ) : (
            data.rows.map(function renderRow(row, index) {
              return (
                <tr key={index} className="hover:bg-muted/40">
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
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
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
