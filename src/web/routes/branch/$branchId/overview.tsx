import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  ChevronDown,
  GitBranch,
  Loader2,
  Pencil,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { Badge } from '#web/components/ui/badge';
import { Button } from '#web/components/ui/button';
import { orpc, type ControlPlaneState } from '#web/lib/api-client';
import {
  AppSidebar,
  BranchOverviewPanel,
  StatusBadge,
} from '#web/components/control-plane';

export const Route = createFileRoute('/branch/$branchId/overview')({
  component: BranchOverviewPage,
});

function BranchOverviewPage() {
  const queryClient = useQueryClient();
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const createBranch = useMutation(orpc.branches.create.mutationOptions({ onSuccess: refreshDashboard }));
  const deleteBranch = useMutation(orpc.branches.delete.mutationOptions({ onSuccess: refreshDashboard }));
  const resetBranch = useMutation(orpc.branches.reset.mutationOptions({ onSuccess: refreshDashboard }));
  const params = Route.useParams();
  const busy = getBusyKey();
  const [menuOpen, setMenuOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
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

  if (!dashboard.data) {
    return <BranchLoadingPage message={dashboard.error ? 'Could not load branch.' : 'Loading branch...'} />;
  }

  const state = dashboard.data;
  const branch = getBranchView(state, params.branchId);

  function getBusyKey(): string | null {
    if (createBranch.isPending) {
      return 'create-child';
    }

    if (resetBranch.isPending) {
      return 'reset';
    }

    if (deleteBranch.isPending) {
      return 'delete';
    }

    return null;
  }

  async function handleCreateChild() {
    const name = window.prompt('Child branch name', `${branch.id}-child`);

    if (!name) {
      return;
    }

    setMessage(null);
    await createBranch.mutateAsync({ name, parentBranchId: branch.rowId });
    setMessage(`Creating child branch ${name} from ${branch.name}.`);
    setMenuOpen(false);
  }

  async function handleResetFromParent() {
    if (!branch.rowId) {
      return;
    }

    if (!window.confirm(`Reset ${branch.name} from parent ${branch.parentName}? This replaces the branch data.`)) {
      return;
    }

    setMessage(null);
    await resetBranch.mutateAsync({ id: branch.rowId! });
    setMessage(`Resetting ${branch.name} from ${branch.parentName}.`);
    setMenuOpen(false);
  }

  async function handleDelete() {
    if (!branch.rowId) {
      return;
    }

    if (!window.confirm(`Delete branch "${branch.name}"?`)) {
      return;
    }

    setMessage(null);
    await deleteBranch.mutateAsync({ id: branch.rowId! });
    window.location.href = `/branch/${encodeURIComponent(branch.parentSlug || 'prod')}/overview`;
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
                <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">Branch overview</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Current branch: {branch.name}
                  {branch.parentName ? ` · Parent: ${branch.parentName}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  onClick={function createChildClick() {
                    void handleCreateChild();
                  }}
                  disabled={busy === 'create-child'}
                >
                  {busy === 'create-child' ? <Loader2 className="animate-spin" /> : <GitBranch />}
                  Create child branch
                </Button>
                <div className="relative">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={function toggleMenu() {
                      setMenuOpen(!menuOpen);
                    }}
                  >
                    More
                    <ChevronDown />
                  </Button>
                  {menuOpen ? (
                    <div className="absolute right-0 z-10 mt-2 w-52 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg">
                      <MenuButton
                        icon={RotateCcw}
                        label="Reset from parent"
                        disabled={branch.id === 'prod' || !branch.parentName || busy === 'reset'}
                        onClick={function resetClick() {
                          void handleResetFromParent();
                        }}
                      />
                      <MenuButton
                        icon={Pencil}
                        label="Edit name"
                        disabled
                        onClick={function editClick() {}}
                      />
                      <MenuButton
                        icon={Trash2}
                        label="Delete"
                        danger
                        disabled={branch.id === 'prod' || busy === 'delete'}
                        onClick={function deleteClick() {
                          void handleDelete();
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </header>

            {message ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                {message}
              </div>
            ) : null}

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

function getBranchView(state: ControlPlaneState, branchId: string) {
  if (branchId === 'prod') {
    return {
      id: 'prod',
      name: 'Production',
      rowId: null,
      slug: 'prod',
      parentBranchId: null,
      parentName: null,
      parentSlug: null,
      badge: 'Production',
      status: state.prodConnectionUrl ? 'ready' : 'pending',
      connectionUrl: state.prodConnectionUrl,
    };
  }

  const branch = state.branches.find(function findBranch(item) {
    return item.slug === branchId;
  });

  return {
    id: branch?.slug || branchId,
    slug: branch?.slug || branchId,
    name: branch?.displayName || branchId,
    rowId: branch?.id || null,
    parentBranchId: branch?.parentBranchId || null,
    parentName: branch?.parentName || 'prod',
    parentSlug: branch?.parentSlug || 'prod',
    badge: 'Development',
    status: branch?.status || 'missing',
    connectionUrl: branch?.connectionUrl || null,
  };
}

function BranchLoadingPage(props: Readonly<{ message: string }>) {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 text-foreground">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="animate-spin" />
        {props.message}
      </div>
    </main>
  );
}

function MenuButton(props: {
  icon: typeof GitBranch;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;

  return (
    <button
      type="button"
      className={[
        'flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-sm',
        props.danger ? 'text-destructive hover:bg-destructive/10' : 'hover:bg-accent hover:text-accent-foreground',
        props.disabled ? 'cursor-not-allowed opacity-50 hover:bg-transparent' : '',
      ].join(' ')}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon className="size-4" />
      {props.label}
    </button>
  );
}
