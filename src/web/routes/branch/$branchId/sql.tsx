import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { FormEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  Loader2,
  Play,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '#web/components/ui/button';
import { orpc, type ControlPlaneState } from '#web/lib/api-client';
import { getMutationErrorMessage } from '#web/lib/errors';
import {
  AppSidebar,
} from '#web/components/control-plane';
import { isProductionBranchId } from '#utils/prod-write-guard';

export const Route = createFileRoute('/branch/$branchId/sql')({
  component: SqlEditorPage,
});

function SqlEditorPage() {
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const runSql = useMutation(orpc.branches.sql.run.mutationOptions());
  const params = Route.useParams();
  const currentBranchIdRef = useRef(params.branchId);
  const highlightRef = useRef<HTMLPreElement>(null);
  const skipNextSaveRef = useRef(true);
  const [sql, setSql] = useState(function getInitialSql() {
    return readSavedSql(params.branchId);
  });
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(function syncCurrentBranch() {
    currentBranchIdRef.current = params.branchId;
    skipNextSaveRef.current = true;
    setSql(readSavedSql(params.branchId));
    setResult(null);
    setError(null);
  }, [params.branchId]);

  useEffect(function saveSqlDraft() {
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    window.localStorage.setItem(getSqlStorageKey(params.branchId), sql);
  }, [params.branchId, sql]);

  if (!dashboard.data) {
    return <SqlLoadingPage message={dashboard.error ? 'Could not load branch.' : 'Loading branch...'} />;
  }

  const state = dashboard.data;

  const branch = getBranchView(state, params.branchId);
  const isProduction = isProductionBranchId(params.branchId);
  const runDisabled = runSql.isPending
    || !sql.trim()
    || branch.status === 'missing';

  async function runCurrentSql() {
    if (runDisabled) {
      return;
    }

    const branchId = params.branchId;
    setError(null);

    try {
      const nextResult = await runSql.mutateAsync({
        branchId,
        sql,
      });

      if (currentBranchIdRef.current !== branchId) {
        return;
      }

      setResult(nextResult);
    } catch (caught: any) {
      if (currentBranchIdRef.current !== branchId) {
        return;
      }

      setError(getMutationErrorMessage(caught, 'SQL failed'));
      setResult(null);
    }
  }

  function handleRunSql(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runCurrentSql();
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen flex-col lg:grid lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeBranchPage="sql" selectedBranch={branch.id} />

        <section className="min-w-0 bg-background">
          <div className="grid min-h-screen grid-rows-[minmax(280px,44vh)_1fr]">
            <form className="flex min-h-0 flex-col border-b border-border" onSubmit={handleRunSql}>
              {isProduction ? (
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
                  <ShieldAlert className="size-4" />
                  <span className="font-medium">production database</span>
                </div>
              ) : null}

              <div className="relative min-h-0 flex-1 bg-background">
                <pre
                  ref={highlightRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-sm leading-6 text-foreground"
                >
                  {highlightSql(sql)}
                </pre>
                <textarea
                  className="absolute inset-0 h-full w-full resize-none rounded-none border-0 bg-transparent px-4 py-3 font-mono text-sm leading-6 text-transparent caret-foreground outline-none selection:bg-primary/30 focus-visible:ring-0"
                  value={sql}
                  spellCheck={false}
                  onChange={function updateSql(event) {
                    setSql(event.target.value);
                  }}
                  onScroll={function syncHighlightScroll(event) {
                    if (!highlightRef.current) {
                      return;
                    }

                    highlightRef.current.scrollTop = event.currentTarget.scrollTop;
                    highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
                  }}
                  onKeyDown={function runSqlShortcut(event) {
                    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) {
                      return;
                    }

                    event.preventDefault();
                    void runCurrentSql();
                  }}
                />
              </div>

              <div className="flex h-12 items-center border-t border-border px-4">
                <Button
                  type="submit"
                  size="sm"
                  className="h-8"
                  disabled={runDisabled}
                >
                  {runSql.isPending ? <Loader2 className="animate-spin" /> : <Play />}
                  Run
                </Button>
              </div>
            </form>

            <section className="min-h-0">
              {result ? (
                <div className="flex h-10 items-center border-b border-border px-4 font-mono text-xs text-muted-foreground">
                  {result.command} · {result.rowCount} rows · {formatDuration(result.durationMs)}
                </div>
              ) : null}
              <div className="min-h-0">
                {error ? (
                  <div className="m-4 border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-sm text-destructive">
                    {error}
                  </div>
                ) : null}
                {!error && result ? <SqlResultTable result={result} /> : null}
              </div>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}

function readSavedSql(branchId: string): string {
  if (typeof window === 'undefined') {
    return getDefaultSql();
  }

  return window.localStorage.getItem(getSqlStorageKey(branchId)) || getDefaultSql();
}

function getSqlStorageKey(branchId: string): string {
  return `velo.sql.${branchId}`;
}

function getDefaultSql(): string {
  return 'select * from velo_local_notes limit 20;';
}

const SQL_KEYWORDS = new Set([
  'all',
  'alter',
  'and',
  'as',
  'asc',
  'begin',
  'between',
  'by',
  'case',
  'commit',
  'create',
  'delete',
  'desc',
  'distinct',
  'drop',
  'else',
  'end',
  'false',
  'from',
  'group',
  'having',
  'in',
  'insert',
  'into',
  'is',
  'join',
  'left',
  'like',
  'limit',
  'not',
  'null',
  'offset',
  'on',
  'or',
  'order',
  'returning',
  'right',
  'rollback',
  'select',
  'set',
  'table',
  'then',
  'true',
  'union',
  'update',
  'values',
  'when',
  'where',
  'with',
]);

function highlightSql(value: string): ReactNode[] {
  const parts = value.match(/(--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\b\d+(?:\.\d+)?\b|\b[a-zA-Z_][a-zA-Z0-9_]*\b|\s+|.)/g) || [''];

  return parts.map(function renderSqlPart(part, index) {
    return (
      <span key={index} className={getSqlTokenClass(part)}>
        {part}
      </span>
    );
  });
}

function getSqlTokenClass(part: string): string {
  const lower = part.toLowerCase();

  if (part.startsWith('--') || part.startsWith('/*')) {
    return 'text-muted-foreground';
  }

  if (part.startsWith("'") || part.startsWith('"')) {
    return 'text-emerald-300';
  }

  if (/^\d/.test(part)) {
    return 'text-amber-300';
  }

  if (SQL_KEYWORDS.has(lower)) {
    return 'font-semibold text-sky-300';
  }

  if (/^[*(),.;=<>+-]$/.test(part)) {
    return 'text-foreground';
  }

  return 'text-foreground';
}

interface SqlResult {
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
  rowCount: number;
  command: string;
  durationMs: number;
  timeoutMs: number;
}

function SqlResultTable(props: { result: SqlResult }) {
  if (props.result.columns.length === 0) {
    return (
      <div className="m-4 font-mono text-sm text-muted-foreground">
        Query completed.
      </div>
    );
  }

  return (
    <div className="overflow-auto">
      <table className="w-full min-w-max border-collapse text-left font-mono text-xs">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            {props.result.columns.map(function renderColumn(column) {
              return (
                <th key={column} className="border-b border-r border-border px-2 py-1.5 font-medium last:border-r-0">
                  {column}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {props.result.rows.map(function renderRow(row, rowIndex) {
            return (
              <tr key={rowIndex} className="border-b border-border last:border-b-0 odd:bg-background even:bg-muted/20">
                {props.result.columns.map(function renderCell(column) {
                  return (
                    <td key={column} className="max-w-80 truncate border-r border-border px-2 py-1.5 last:border-r-0">
                      {formatCell(row[column])}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  return String(value);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }

  return `${(durationMs / 1000).toFixed(2)} s`;
}

function SqlLoadingPage(props: { message: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">
      {props.message}
    </main>
  );
}

function getBranchView(state: ControlPlaneState, branchId: string) {
  if (branchId === 'production') {
    return {
      id: 'production',
      name: 'production',
      badge: 'Production',
      status: state.prodConnectionUrl ? 'ready' : 'pending',
    };
  }

  const branch = state.branches.find(function findBranch(item) {
    return item.slug === branchId;
  });

  return {
    id: branch?.slug || branchId,
    name: branch?.displayName || branchId,
    badge: 'Development',
    status: branch?.status || 'missing',
  };
}
