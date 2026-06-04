import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#web/components/ui/alert-dialog';
import { Button } from '#web/components/ui/button';
import { Checkbox } from '#web/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#web/components/ui/dialog';
import { Input } from '#web/components/ui/input';
import { Label } from '#web/components/ui/label';
import { isConfirmedProductionWrite, PRODUCTION_WRITE_CONFIRMATION } from '#utils/prod-write-guard';

export type RowEditorMode = 'insert' | 'edit';

export interface TableActionTarget {
  branchId: string;
  database: string;
  schema: string;
  table: string;
}

export interface RowDraftField {
  column: string;
  type: string;
  value: string;
  isNull: boolean;
  enabled: boolean;
}

export interface RowEditorState {
  mode: RowEditorMode;
  target: TableActionTarget;
  rowId: string | null;
  fields: RowDraftField[];
}

export interface DeleteRowState {
  target: TableActionTarget;
  rowId: string;
  label: string;
}

interface RowEditorDialogProps {
  editor: RowEditorState | null;
  selectedLabel: string;
  isProduction: boolean;
  saving: boolean;
  onClose: () => void;
  onChangeField: (column: string, patch: Partial<RowDraftField>) => void;
  onSave: (productionWriteConfirmation: string) => void;
}

export function RowEditorDialog(props: RowEditorDialogProps) {
  const [productionWriteConfirmation, setProductionWriteConfirmation] = useState('');
  const editorKey = getEditorKey(props.editor);
  const productionWriteLocked = props.isProduction && !isConfirmedProductionWrite(productionWriteConfirmation);

  useEffect(function resetProductionWriteConfirmation() {
    setProductionWriteConfirmation('');
  }, [editorKey]);

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!props.editor) {
      return;
    }

    if (productionWriteLocked) {
      toast.error(`Type "${PRODUCTION_WRITE_CONFIRMATION}" to edit production rows.`);
      return;
    }

    props.onSave(productionWriteConfirmation);
  }

  return (
    <Dialog open={props.editor !== null} onOpenChange={function handleEditorOpenChange(open) {
      if (!open) {
        props.onClose();
      }
    }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{props.editor?.mode === 'insert' ? 'Add row' : 'Edit row'}</DialogTitle>
          <DialogDescription>
            {props.editor ? `${props.editor.target.schema}.${props.editor.target.table}` : props.selectedLabel}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={handleSave}>
          {props.editor ? (
            <RowFieldsEditor
              fields={props.editor.fields}
              mode={props.editor.mode}
              disabled={props.saving}
              onChangeField={props.onChangeField}
            />
          ) : null}

          {props.isProduction ? (
            <ProductionWriteConfirmationField
              value={productionWriteConfirmation}
              disabled={props.saving}
              onChange={setProductionWriteConfirmation}
            />
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={props.saving} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={props.saving || !props.editor || productionWriteLocked}>
              {props.saving ? <Loader2 className="animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface DeleteRowDialogProps {
  rowToDelete: DeleteRowState | null;
  isProduction: boolean;
  deleting: boolean;
  onClose: () => void;
  onDelete: (productionWriteConfirmation: string) => void;
}

export function DeleteRowDialog(props: DeleteRowDialogProps) {
  const [productionWriteConfirmation, setProductionWriteConfirmation] = useState('');
  const deleteKey = getDeleteKey(props.rowToDelete);
  const productionWriteLocked = props.isProduction && !isConfirmedProductionWrite(productionWriteConfirmation);

  useEffect(function resetProductionWriteConfirmation() {
    setProductionWriteConfirmation('');
  }, [deleteKey]);

  function handleDelete() {
    if (!props.rowToDelete) {
      return;
    }

    if (productionWriteLocked) {
      toast.error(`Type "${PRODUCTION_WRITE_CONFIRMATION}" to delete production rows.`);
      return;
    }

    props.onDelete(productionWriteConfirmation);
  }

  return (
    <AlertDialog open={props.rowToDelete !== null} onOpenChange={function handleDeleteOpenChange(open) {
      if (!open) {
        props.onClose();
      }
    }}>
      <AlertDialogContent
        onKeyDown={function handleDeleteDialogKeyDown(event) {
          if (event.key !== 'Enter' || props.deleting) {
            return;
          }

          event.preventDefault();
          handleDelete();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete row?</AlertDialogTitle>
          <AlertDialogDescription>
            {props.rowToDelete ? `Delete ${props.rowToDelete.label} from ${props.rowToDelete.target.schema}.${props.rowToDelete.target.table}.` : null}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {props.isProduction ? (
          <ProductionWriteConfirmationField
            value={productionWriteConfirmation}
            disabled={props.deleting}
            onChange={setProductionWriteConfirmation}
          />
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={props.deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            autoFocus
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={props.deleting || productionWriteLocked}
            onClick={function deleteConfirmed(event) {
              event.preventDefault();
              handleDelete();
            }}
          >
            {props.deleting ? <Loader2 className="animate-spin" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface ProductionWriteConfirmationFieldProps {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

function ProductionWriteConfirmationField(props: ProductionWriteConfirmationFieldProps) {
  return (
    <div className="grid gap-2">
      <Label htmlFor="production-write-confirmation">
        Type <ConfirmationCode value={PRODUCTION_WRITE_CONFIRMATION} />
      </Label>
      <Input
        id="production-write-confirmation"
        value={props.value}
        disabled={props.disabled}
        onChange={function updateProductionWriteConfirmation(event) {
          props.onChange(event.target.value);
        }}
        className="font-mono"
        autoComplete="off"
      />
    </div>
  );
}

function ConfirmationCode(props: { value: string }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{props.value}</code>;
}

interface RowFieldsEditorProps {
  fields: RowDraftField[];
  mode: RowEditorMode;
  disabled: boolean;
  onChangeField: (column: string, patch: Partial<RowDraftField>) => void;
}

function RowFieldsEditor(props: RowFieldsEditorProps) {
  return (
    <div className="grid gap-2">
      {props.fields.map(function renderField(field) {
        const valueDisabled = props.disabled || field.isNull || !field.enabled;

        return (
          <div
            key={field.column}
            className="grid gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0 md:grid-cols-[minmax(140px,1fr)_minmax(180px,2fr)_auto_auto]"
          >
            <div className="flex min-w-0 items-center gap-2">
              {props.mode === 'insert' ? (
                <Checkbox
                  checked={field.enabled}
                  disabled={props.disabled}
                  onCheckedChange={function toggleEnabled(checked) {
                    props.onChangeField(field.column, { enabled: checked === true });
                  }}
                  aria-label={`Include ${field.column}`}
                />
              ) : null}
              <div className="min-w-0">
                <div className="truncate font-mono text-xs font-medium">{field.column}</div>
                <div className="truncate text-[11px] text-muted-foreground">{field.type}</div>
              </div>
            </div>

            <Input
              value={field.value}
              disabled={valueDisabled}
              className="h-8 font-mono text-xs"
              onChange={function updateValue(event) {
                props.onChangeField(field.column, { value: event.target.value });
              }}
            />

            <Label className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-2 text-xs text-muted-foreground">
              <Checkbox
                checked={field.isNull}
                disabled={props.disabled || !field.enabled}
                onCheckedChange={function toggleNull(checked) {
                  props.onChangeField(field.column, { isNull: checked === true });
                }}
              />
              null
            </Label>
          </div>
        );
      })}
    </div>
  );
}

function getEditorKey(editor: RowEditorState | null): string {
  if (!editor) {
    return 'closed';
  }

  return [
    editor.mode,
    editor.target.branchId,
    editor.target.database,
    editor.target.schema,
    editor.target.table,
    editor.rowId || 'insert',
  ].join(':');
}

function getDeleteKey(rowToDelete: DeleteRowState | null): string {
  if (!rowToDelete) {
    return 'closed';
  }

  return [
    rowToDelete.target.branchId,
    rowToDelete.target.database,
    rowToDelete.target.schema,
    rowToDelete.target.table,
    rowToDelete.rowId,
  ].join(':');
}
