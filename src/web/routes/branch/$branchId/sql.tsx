import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  Database,
  Loader2,
  Play,
  Terminal,
} from 'lucide-react';
import { Button } from '#web/components/ui/button';
import { Textarea } from '#web/components/ui/textarea';
import { orpc, type ControlPlaneState } from '#web/lib/api-client';
import {
  AppSidebar,
} from '#web/components/control-plane';
import { isSetupComplete, OnboardingWizard } from '#web/components/onboarding-wizard';

export const Route = createFileRoute('/branch/$branchId/sql')({
  component: SqlEditorPage,
});

function SqlEditorPage() {
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const runSql = useMutation(orpc.branches.sql.run.mutationOptions());
  const params = Route.useParams();
  const currentBranchIdRef = useRef(params.branchId);
  const [sql, setSql] = useState('select * from velo_local_notes limit 20;');
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(function syncCurrentBranch() {
    currentBranchIdRef.current = params.branchId;
    setResult(null);
    setError(null);
  }, [params.branchId]);

  if (!dashboard.data) {
    return <SqlLoadingPage message={dashboard.error ? 'Could not load branch.' : 'Loading branch...'} />;
  }

  const state = dashboard.data;

  if (!isSetupComplete(state)) {
    return <OnboardingWizard />;
  }

  const branch = getBranchView(state, params.branchId);

  async function runCurrentSql() {
    if (runSql.isPending || !sql.trim() || branch.status === 'missing') {
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

      setError(getErrorMessage(caught, 'SQL failed'));
      setResult(null);
    }
  }

  function handleRunSql(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runCurrentSql();
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeBranchPage="sql" selectedBranch={branch.id} />

        <section className="min-w-0 bg-background">
          <div className="grid min-h-screen grid-rows-[minmax(280px,42vh)_1fr]">
            <form className="min-h-0 border-b border-border" onSubmit={handleRunSql}>
              <div className="flex h-12 items-center justify-between gap-3 border-b border-border px-4">
                <div className="flex items-center gap-3">
                  <div className="grid size-7 place-items-center rounded-sm border border-border bg-muted text-muted-foreground">
                    <Terminal className="size-4" />
                  </div>
                  <div className="font-mono text-sm font-medium">query.sql</div>
                </div>
                <Button
                  type="submit"
                  size="sm"
                  className="h-8"
                  disabled={runSql.isPending || !sql.trim() || branch.status === 'missing'}
                >
                  {runSql.isPending ? <Loader2 className="animate-spin" /> : <Play />}
                  Run
                </Button>
              </div>

              <Textarea
                className="h-[calc(100%-3rem)] min-h-0 resize-none rounded-none border-0 !bg-background px-4 py-3 font-mono text-sm leading-6 shadow-none focus-visible:ring-0"
                value={sql}
                onChange={function updateSql(event) {
                  setSql(event.target.value);
                }}
                onKeyDown={function runSqlShortcut(event) {
                  if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) {
                    return;
                  }

                  event.preventDefault();
                  void runCurrentSql();
                }}
              />
            </form>

            <section className="min-h-0">
              <div className="flex h-12 items-center justify-between gap-3 border-b border-border px-4">
                <div className="flex items-center gap-3">
                  <div className="grid size-7 place-items-center rounded-sm border border-border bg-muted text-muted-foreground">
                    <Database className="size-4" />
                  </div>
                  <div className="font-mono text-sm font-medium">stdout</div>
                </div>
                {result ? (
                  <div className="font-mono text-xs text-muted-foreground">
                    {result.command} · {result.rowCount} rows · {formatDuration(result.durationMs)}
                  </div>
                ) : null}
              </div>
              <div className="min-h-0">
                {error ? (
                  <div className="m-4 border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-sm text-destructive">
                    {error}
                  </div>
                ) : null}
                {!error && result ? <SqlResultTable result={result} /> : null}
                {!error && !result ? (
                  <div className="px-4 py-10 font-mono text-sm text-muted-foreground">
                    <span className="text-foreground">$</span> run query to print rows
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
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

function getErrorMessage(error: any, fallback: string): string {
  return error?.data?.message || error?.json?.data?.message || error?.message || fallback;
}

function SqlLoadingPage(props: { message: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">
      {props.message}
    </main>
  );
}

function getBranchView(state: ControlPlaneState, branchId: string) {
  if (branchId === 'prod') {
    return {
      id: 'prod',
      name: 'prod',
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
