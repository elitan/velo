import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Database, Loader2 } from 'lucide-react';
import {
  AppSidebar,
  BranchTreePanel,
} from '#web/components/control-plane';
import { orpc } from '#web/lib/api-client';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
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

  if (!dashboard.data) {
    return <LoadingPage message={dashboard.error ? 'Could not load dashboard.' : 'Loading dashboard...'} />;
  }

  const state = dashboard.data;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeProject="dashboard" />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between gap-4 lg:hidden">
              <div className="flex items-center gap-3">
                <div className="grid size-9 place-items-center rounded-md bg-primary text-primary-foreground">
                  <Database className="size-4" />
                </div>
                <div>
                  <div className="text-sm font-semibold leading-none">Velo</div>
                  <div className="mt-1 text-xs text-muted-foreground">Control plane</div>
                </div>
              </div>
            </div>

            <header className="pt-2">
              <h1 className="text-3xl font-semibold tracking-normal md:text-4xl">Branches</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Pick a database branch.
              </p>
            </header>

            <BranchTreePanel branches={state.branches} prodReady={Boolean(state.prodConnectionUrl)} />
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
