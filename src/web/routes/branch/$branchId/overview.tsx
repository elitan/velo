import { createFileRoute } from '@tanstack/react-router';
import { Badge } from '../../../components/ui/badge';
import { getSetupState } from '../../../lib/actions';
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
  const branch = getBranchView(state, params.branchId);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeBranchPage="overview" selectedBranch={branch.id} />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <header>
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{branch.badge}</Badge>
                  <StatusBadge status={branch.status} />
                </div>
                <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">Branch overview</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Current branch: {branch.id}</p>
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
      badge: 'Production',
      status: state.prodConnectionUrl ? 'ready' : 'pending',
      connectionUrl: state.prodConnectionUrl,
    };
  }

  const branch = state.branches.find(function findBranch(item) {
    return item.name === branchId;
  });

  return {
    id: branch?.name || branchId,
    name: branch?.name || branchId,
    badge: 'Development',
    status: branch?.status || 'missing',
    connectionUrl: branch?.connectionUrl || null,
  };
}
