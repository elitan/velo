import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  Activity,
  ArchiveRestore,
  Database,
  GitBranch,
  Loader2,
  Play,
  RefreshCw,
} from 'lucide-react';
import { Badge } from '#web/components/ui/badge';
import { Button, buttonVariants } from '#web/components/ui/button';
import {
  AppSidebar,
  BranchesPanel,
  MetricCard,
  ProductionSummaryPanel,
  SetupPanel,
  StatusBadge,
  SystemPanel,
  type ServerRole,
} from '#web/components/control-plane';
import { orpc } from '#web/lib/api-client';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const queryClient = useQueryClient();
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const startBootstrap = useMutation(orpc.bootstrap.start.mutationOptions({ onSuccess: refreshDashboard }));
  const createBranch = useMutation(orpc.branches.create.mutationOptions({ onSuccess: refreshDashboard }));
  const deleteBranch = useMutation(orpc.branches.delete.mutationOptions({ onSuccess: refreshDashboard }));
  const createReplicaBase = useMutation(orpc.replicaBase.create.mutationOptions({ onSuccess: refreshDashboard }));
  const busy = getBusyKey();
  const activeJobs = dashboard.data?.jobs.filter(function isActive(job) {
    return job.status === 'queued' || job.status === 'running';
  }).length ?? 0;

  useEffect(function pollActiveJobs() {
    if (activeJobs === 0) {
      return;
    }

    const interval = window.setInterval(function refreshActiveJobs() {
      void dashboard.refetch();
    }, 2000);

    return function clearPoll() {
      window.clearInterval(interval);
    };
  }, [activeJobs, dashboard]);

  async function refreshDashboard() {
    await queryClient.invalidateQueries({ queryKey: orpc.dashboard.retrieve.key() });
  }

  function getBusyKey(): string | null {
    if (startBootstrap.isPending) {
      return `bootstrap-${startBootstrap.variables?.target || 'dev'}`;
    }

    if (createBranch.isPending) {
      return 'create-branch';
    }

    if (deleteBranch.isPending) {
      return `delete-branch-${deleteBranch.variables?.id}`;
    }

    if (createReplicaBase.isPending) {
      return 'create-replica';
    }

    return null;
  }

  if (!dashboard.data) {
    return <LoadingPage message={dashboard.error ? 'Could not load dashboard.' : 'Loading dashboard...'} />;
  }

  const state = dashboard.data;

  async function handleBootstrap(kind: ServerRole) {
    await startBootstrap.mutateAsync({ target: kind });
  }

  async function handleCreateBranch(formData: FormData) {
    const name = String(formData.get('name') || '');
    await createBranch.mutateAsync({ name });
  }

  async function handleDeleteBranch(id: number, name: string) {
    if (!window.confirm(`Delete branch "${name}"?`)) {
      return;
    }

    await deleteBranch.mutateAsync({ id });
  }

  async function handleCreateReplica() {
    await createReplicaBase.mutateAsync(undefined);
  }

  const prodServer = state.servers.find(function findProd(server) {
    return server.role === 'prod';
  });
  const devServer = state.servers.find(function findDev(server) {
    return server.role === 'dev';
  });
  const doneSteps = state.setupSteps.filter(function countDone(step) {
    return step.status === 'done';
  }).length;
  const setupComplete = doneSteps === state.setupSteps.length;
  const backupsStep = state.setupSteps.find(function findBackupsStep(step) {
    return step.key === 'backups';
  });
  const dashboardTitle = setupComplete ? 'Production ready. Branching is live.' : 'Finish setup to start branching.';

  const backupMode = state.backup.enabled ? 'S3/R2' : 'local';

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeProject="dashboard" />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between gap-4 lg:hidden">
              <div className="flex items-center gap-3">
                <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
                  <Database className="size-4" />
                </div>
                <div>
                  <div className="text-sm font-semibold leading-none">Velo</div>
                  <div className="mt-1 text-xs text-muted-foreground">Control plane</div>
                </div>
              </div>
              <StatusBadge status={setupComplete ? 'done' : activeJobs > 0 ? 'running' : 'pending'} />
            </div>

            <header id="overview" className="scroll-mt-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Overview</Badge>
                  <Badge variant={setupComplete ? 'success' : 'warning'}>
                    {setupComplete ? 'ready' : 'setup needed'}
                  </Badge>
                </div>
                <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">
                  {dashboardTitle}
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Create dev databases, copy connection strings, and confirm production is protected.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <a className={buttonVariants()} href="#branches">
                  <GitBranch />
                  New branch
                </a>
                <Button
                  variant="outline"
                  onClick={function refreshPage() {
                    void dashboard.refetch();
                  }}
                >
                  <RefreshCw />
                  Refresh
                </Button>
                <Button
                  onClick={function createReplicaClick() {
                    void handleCreateReplica();
                  }}
                  disabled={busy === 'create-replica' || !prodServer}
                >
                  {busy === 'create-replica' ? <Loader2 className="animate-spin" /> : <Play />}
                  Sync replica
                </Button>
              </div>
            </header>

            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard title="Production" value={state.prodConnectionUrl ? 'Ready' : 'Pending'} detail={prodServer?.host || 'no host'} icon={Database} tone="emerald" />
              <MetricCard title="Backups" value={backupMode} detail={backupsStep?.status || 'pending'} icon={ArchiveRestore} tone="blue" />
              <MetricCard title="Branches" value={String(state.branches.length)} detail="ready to use" icon={GitBranch} tone="violet" />
              <MetricCard title="Active work" value={String(activeJobs)} detail="running jobs" icon={Activity} tone="amber" />
            </section>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_390px]">
              <div id="branches" className="scroll-mt-6">
                <BranchesPanel
                  branches={state.branches}
                  busy={busy}
                  onCreate={handleCreateBranch}
                  onDelete={handleDeleteBranch}
                />
              </div>

              <div className="grid content-start gap-6">
                <ProductionSummaryPanel
                  connectionUrl={state.prodConnectionUrl}
                  serverHost={prodServer?.host || null}
                  backupStatus={backupsStep?.status || 'pending'}
                  backupMessage={backupsStep?.message || null}
                  backupMode={backupMode}
                />
                <SystemPanel
                  setupDone={doneSteps}
                  setupTotal={state.setupSteps.length}
                  healthyServers={state.servers.filter(function countOk(server) {
                    return server.status === 'ok';
                  }).length}
                  totalServers={state.servers.length}
                  backupMode={backupMode}
                  activeJobs={activeJobs}
                />
              </div>
            </div>

            {!setupComplete ? (
              <SetupPanel
                steps={state.setupSteps}
                busy={busy}
                prodServerReady={Boolean(prodServer)}
                onBootstrap={handleBootstrap}
                onCreateReplica={handleCreateReplica}
              />
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}

function LoadingPage(props: Readonly<{ message: string }>) {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 text-foreground">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="animate-spin" />
        {props.message}
      </div>
    </main>
  );
}
