import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { useEffect, useState } from 'react';
import { ArchiveRestore, GitBranch, RefreshCw } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import {
  createReplicaBaseAction,
  getSetupState,
  runProdBootstrapAction,
} from '../../../lib/actions';
import {
  AppSidebar,
  BranchOverviewPanel,
  StatusBadge,
} from '../../index';

export const Route = createFileRoute('/branch/$branchId/overview')({
  loader: function loader() {
    return getSetupState();
  },
  component: BranchOverviewPage,
});

function BranchOverviewPage() {
  const state = Route.useLoaderData();
  const params = Route.useParams();
  const router = useRouter();
  const runProdBootstrap = useServerFn(runProdBootstrapAction);
  const createReplicaBase = useServerFn(createReplicaBaseAction);
  const branch = getBranchView(state, params.branchId);
  const prodServer = state.servers.find(function findProd(server) {
    return server.role === 'prod';
  });
  const activeJobs = state.jobs.filter(function isActive(job) {
    return job.status === 'queued' || job.status === 'running';
  }).length;
  const activeProdSetup = state.jobs.some(function isActiveProdSetup(job) {
    return job.type === 'prod-bootstrap' && (job.status === 'queued' || job.status === 'running');
  });
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

  async function handlePrimaryAction() {
    if (branch.kind === 'prod') {
      await runBusy('bootstrap-prod', async function bootstrapProd() {
        await runProdBootstrap();
      });
      return;
    }

    await runBusy('create-replica', async function createReplica() {
      await createReplicaBase();
    });
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeBranchPage="overview" selectedBranch={branch.id} />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{branch.badge}</Badge>
                  <StatusBadge status={branch.status} />
                </div>
                <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">{branch.title}</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{branch.description}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={function refreshPage() { void router.invalidate(); }}>
                  <RefreshCw />
                  Refresh
                </Button>
                <Button onClick={function primaryActionClick() { void handlePrimaryAction(); }} disabled={branch.kind === 'prod' ? busy === 'bootstrap-prod' || activeProdSetup || !prodServer : busy === 'create-replica' || !prodServer}>
                  {branch.kind === 'prod' ? <ArchiveRestore /> : <GitBranch />}
                  {branch.kind === 'prod' && activeProdSetup ? 'Setup running' : branch.primaryAction}
                </Button>
              </div>
            </header>

            <BranchOverviewPanel
              title={`${branch.name} database`}
              connectionLabel={`${branch.name} connection string`}
              connectionUrl={branch.connectionUrl}
            />
          </div>
        </section>
      </div>
    </main>
  );
}

function getBranchView(state: Awaited<ReturnType<typeof getSetupState>>, branchId: string) {
  if (branchId === 'prod') {
    return {
      id: 'prod',
      name: 'Production',
      kind: 'prod' as const,
      badge: 'Production',
      status: state.prodConnectionUrl ? 'ready' : 'pending',
      title: 'Production database',
      description: 'Stable Postgres, connection string, backups, and PITR.',
      primaryAction: 'Setup backups',
      connectionUrl: state.prodConnectionUrl,
    };
  }

  const branch = state.branches.find(function findBranch(item) {
    return item.name === branchId;
  });

  return {
    id: branch?.name || branchId,
    name: branch?.name || branchId,
    kind: 'dev' as const,
    badge: 'Development',
    status: branch?.status || 'missing',
    title: branch ? `${branch.name} database` : 'Branch not found',
    description: 'Writable database branch on the dev server.',
    primaryAction: 'Sync replica',
    connectionUrl: branch?.connectionUrl || null,
  };
}
