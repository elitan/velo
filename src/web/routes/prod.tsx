import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { useEffect, useState } from 'react';
import { Activity, ArchiveRestore, Database, GitBranch, RefreshCw, Settings2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import {
  getSetupState,
  runProdBootstrapAction,
} from '../lib/actions';
import {
  MetricCard,
  NavItem,
  ProductionPanel,
  StatusBadge,
} from './index';

export const Route = createFileRoute('/prod')({
  loader: function loader() {
    return getSetupState();
  },
  component: ProdPage,
});

function ProdPage() {
  const state = Route.useLoaderData();
  const router = useRouter();
  const runProdBootstrap = useServerFn(runProdBootstrapAction);
  const prodServer = state.servers.find(function findProd(server) {
    return server.role === 'prod';
  });
  const backupsStep = state.setupSteps.find(function findBackupsStep(step) {
    return step.key === 'backups';
  });
  const prodStep = state.setupSteps.find(function findProdStep(step) {
    return step.key === 'prod-setup';
  });
  const activeJobs = state.jobs.filter(function isActive(job) {
    return job.status === 'queued' || job.status === 'running';
  }).length;
  const backupMode = state.backup.enabled ? 'S3/R2' : 'local';
  const [busy, setBusy] = useState<string | null>(null);

  async function runBusy(key: string, task: () => Promise<void>) {
    setBusy(key);
    try {
      await task();
      await router.invalidate();
    } finally {
      setBusy(null);
    }
  }

  async function handleSetupProd() {
    await runBusy('bootstrap-prod', async function bootstrapProd() {
      await runProdBootstrap();
    });
  }

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
            <NavItem icon={Database} label="Production" href="/prod" active />
            <NavItem icon={GitBranch} label="Development" href="/dev" />
            <NavItem icon={Settings2} label="Settings" href="/settings" />
          </div>
        </aside>

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Production</Badge>
                  <StatusBadge status={state.prodConnectionUrl ? 'ready' : 'pending'} />
                </div>
                <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">Production database</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Stable Postgres, connection string, backups, and PITR.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={function refreshPage() { void router.invalidate(); }}>
                  <RefreshCw />
                  Refresh
                </Button>
                <Button onClick={function setupProdClick() { void handleSetupProd(); }} disabled={busy === 'bootstrap-prod' || !prodServer}>
                  <ArchiveRestore />
                  Setup backups
                </Button>
              </div>
            </header>

            <section className="grid gap-3 sm:grid-cols-3">
              <MetricCard title="Database" value={state.prodConnectionUrl ? 'Ready' : 'Pending'} detail={prodServer?.host || 'no host'} icon={Database} tone="emerald" />
              <MetricCard title="Backups" value={backupMode} detail={backupsStep?.status || 'pending'} icon={ArchiveRestore} tone="blue" />
              <MetricCard title="Prod setup" value={prodStep?.status || 'pending'} detail={prodStep?.message || 'waiting'} icon={Activity} tone="amber" />
            </section>

            <ProductionPanel
              connectionUrl={state.prodConnectionUrl}
              backup={state.backup}
              serverHost={prodServer?.host || null}
              backupStatus={backupsStep?.status || 'pending'}
              backupMessage={backupsStep?.message || null}
            />
          </div>
        </section>
      </div>
    </main>
  );
}
