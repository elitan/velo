import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { useEffect, useState } from 'react';
import { Activity, Database, GitBranch, HardDrive, RefreshCw, Settings2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import {
  createBranchAction,
  createReplicaBaseAction,
  deleteBranchAction,
  getSetupState,
  runDevBootstrapAction,
} from '../lib/actions';
import {
  BranchesPanel,
  JobsPanel,
  MetricCard,
  NavItem,
  SetupPanel,
  StatusBadge,
  type ServerRole,
} from './index';

export const Route = createFileRoute('/dev')({
  loader: function loader() {
    return getSetupState();
  },
  component: DevPage,
});

function DevPage() {
  const state = Route.useLoaderData();
  const router = useRouter();
  const runDevBootstrap = useServerFn(runDevBootstrapAction);
  const createReplicaBase = useServerFn(createReplicaBaseAction);
  const createBranch = useServerFn(createBranchAction);
  const deleteBranch = useServerFn(deleteBranchAction);
  const prodServer = state.servers.find(function findProd(server) {
    return server.role === 'prod';
  });
  const devServer = state.servers.find(function findDev(server) {
    return server.role === 'dev';
  });
  const replicaStep = state.setupSteps.find(function findReplicaStep(step) {
    return step.key === 'replica';
  });
  const activeJobs = state.jobs.filter(function isActive(job) {
    return job.status === 'queued' || job.status === 'running';
  }).length;
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(function pollActiveJobs() {
    if (activeJobs === 0) {
      return;
    }

    const interval = window.setInterval(function refreshActiveJobs() {
      void router.invalidate();
    }, 2000);

    return function clearPoll() {
      window.clearInterval(interval);
    };
  }, [activeJobs, router]);

  async function runBusy(key: string, task: () => Promise<void>) {
    setBusy(key);
    try {
      await task();
      await router.invalidate();
    } finally {
      setBusy(null);
    }
  }

  async function handleBootstrap(kind: ServerRole) {
    await runBusy(`bootstrap-${kind}`, async function bootstrapDev() {
      if (kind === 'dev') {
        await runDevBootstrap();
      }
    });
  }

  async function handleCreateReplica() {
    await runBusy('create-replica', async function createReplica() {
      await createReplicaBase();
    });
  }

  async function handleCreateBranch(formData: FormData) {
    const name = String(formData.get('name') || '');
    await runBusy('create-branch', async function createBranchForm() {
      await createBranch({ data: { name } });
    });
  }

  async function handleDeleteBranch(id: number, name: string) {
    if (!window.confirm(`Delete branch "${name}"?`)) {
      return;
    }

    await runBusy(`delete-branch-${id}`, async function deleteBranchClick() {
      await deleteBranch({ data: { id } });
    });
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[244px_1fr]">
        <aside className="hidden bg-sidebar px-5 py-5 text-sidebar-foreground lg:block lg:border-r">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Database className="size-4" />
            </div>
            <div>
              <div className="text-sm font-semibold leading-none">Velo</div>
              <div className="mt-1 text-xs text-muted-foreground">Control plane</div>
            </div>
          </div>
          <div className="mt-7 grid gap-1 text-sm">
            <NavItem icon={Activity} label="Overview" href="/" />
            <NavItem icon={Database} label="Production" href="/prod" />
            <NavItem icon={GitBranch} label="Development" href="/dev" active />
            <NavItem icon={Settings2} label="Settings" href="/settings" />
          </div>
        </aside>

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Development</Badge>
                  <StatusBadge status={replicaStep?.status || 'pending'} />
                </div>
                <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">Development branches</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Fast writable clones from the dev replica. Safe to create and delete.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={function refreshPage() { void router.invalidate(); }}>
                  <RefreshCw />
                  Refresh
                </Button>
                <Button onClick={function createReplicaClick() { void handleCreateReplica(); }} disabled={busy === 'create-replica' || !prodServer}>
                  <GitBranch />
                  Sync replica
                </Button>
              </div>
            </header>

            <section className="grid gap-3 sm:grid-cols-3">
              <MetricCard title="Replica" value={replicaStep?.status || 'pending'} detail={replicaStep?.message || 'waiting'} icon={RefreshCw} tone="blue" />
              <MetricCard title="Branches" value={String(state.branches.length)} detail="dev databases" icon={GitBranch} tone="violet" />
              <MetricCard title="Dev host" value={devServer?.status || 'unknown'} detail={devServer?.host || 'no host'} icon={HardDrive} tone="emerald" />
            </section>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_390px]">
              <div className="grid min-w-0 gap-6">
                <BranchesPanel branches={state.branches} busy={busy} onCreate={handleCreateBranch} onDelete={handleDeleteBranch} />
                <SetupPanel
                  steps={state.setupSteps}
                  busy={busy}
                  prodServerReady={Boolean(prodServer)}
                  onBootstrap={handleBootstrap}
                  onCreateReplica={handleCreateReplica}
                />
              </div>
              <div className="grid content-start gap-6">
                <JobsPanel jobs={state.jobs} activeJobs={activeJobs} />
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
