import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { AlertTriangle, GitBranch, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#web/components/ui/select';
import {
  AppSidebar,
  BranchTreePanel,
} from '#web/components/control-plane';
import { orpc } from '#web/lib/api-client';
import { getReplicaBranchCreatePolicy, type ReplicaBranchCreatePolicy } from '#utils/replica-freshness-policy';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const createBranch = useMutation(orpc.branches.create.mutationOptions({ onSuccess: refreshDashboard }));
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [parentBranchId, setParentBranchId] = useState('production');
  const [ttlHours, setTtlHours] = useState('none');
  const [forceReplicaStale, setForceReplicaStale] = useState(false);
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
    return <LoadingPage message={dashboard.error ? 'Could not load dashboard.' : 'Loading dashboard...'} />;
  }

  const state = dashboard.data;

  function openCreateModal() {
    setBranchName('');
    setParentBranchId('production');
    setTtlHours('none');
    setForceReplicaStale(false);
    void dashboard.refetch();
    setCreateModalOpen(true);
  }

  async function handleCreateBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const name = branchName.trim();

    if (!name) {
      return;
    }

    let result;

    try {
      result = await createBranch.mutateAsync({
        name,
        parentBranchId: parentBranchId !== 'production' ? Number(parentBranchId) : null,
        ttlHours: ttlHours !== 'none' ? Number(ttlHours) : null,
        forceReplicaStale,
      });
      if (result.replicaWarning) {
        toast.warning(result.replicaWarning);
      } else {
        toast.info(`Creating branch ${name}.`);
      }
      setCreateModalOpen(false);
    } catch (error: any) {
      toast.error(error?.message || 'Could not create branch.');
      return;
    }

    if (result.branchSlug) {
      await navigate({ to: '/branch/$branchId/overview', params: { branchId: result.branchSlug } });
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen flex-col lg:grid lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeProject="dashboard" />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[980px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <header className="flex flex-col gap-4 pt-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h1 className="text-3xl font-semibold tracking-normal md:text-4xl">Branches</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Pick a database branch.
                </p>
              </div>
              <Button type="button" className="h-8 sm:mt-1" onClick={openCreateModal} disabled={createBranch.isPending}>
                {createBranch.isPending ? <Loader2 className="animate-spin" /> : <GitBranch />}
                Create branch
              </Button>
            </header>

            <BranchTreePanel branches={state.branches} prodReady={Boolean(state.prodConnectionUrl)} />
          </div>
        </section>
      </div>

      <Dialog open={createModalOpen} onOpenChange={setCreateModalOpen}>
        <DialogContent>
          <form
            onSubmit={function submitCreateBranch(event) {
              void handleCreateBranch(event);
            }}
          >
            <DialogHeader>
              <DialogTitle>Create branch</DialogTitle>
              <DialogDescription>From production by default.</DialogDescription>
            </DialogHeader>

            <div className="mt-5 grid gap-2">
              <Label>Parent branch</Label>
              <Select
                value={parentBranchId}
                onValueChange={function changeParentBranch(value) {
                  setParentBranchId(value);
                  setForceReplicaStale(false);
                }}
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="production">production</SelectItem>
                  {state.branches.map(function renderParentOption(branch) {
                    return (
                      <SelectItem key={branch.id} value={String(branch.id)}>
                        {branch.displayName}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {parentBranchId === 'production' && shouldShowReplicaFreshnessInfo(state.replicaFreshness) ? (
                <ReplicaFreshnessNotice
                  policy={getReplicaBranchCreatePolicy(state.replicaFreshness)}
                  forceReplicaStale={forceReplicaStale}
                  onForceReplicaStaleChange={setForceReplicaStale}
                />
              ) : null}
            </div>

            <div className="mt-4 grid gap-2">
              <Label htmlFor="branch-name">Branch name</Label>
              <Input
                id="branch-name"
                value={branchName}
                placeholder="new-branch-name"
                autoFocus
                onChange={function updateBranchName(event) {
                  setBranchName(event.target.value);
                }}
              />
            </div>

            <div className="mt-4 grid gap-2">
              <Label>Expiry</Label>
              <Select value={ttlHours} onValueChange={setTtlHours}>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">no expiry</SelectItem>
                  <SelectItem value="1">1h</SelectItem>
                  <SelectItem value="24">1 day</SelectItem>
                  <SelectItem value="168">7 days</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <DialogFooter className="mt-6">
              <Button
                type="button"
                variant="outline"
                onClick={function closeCreateModal() {
                  setCreateModalOpen(false);
                }}
                disabled={createBranch.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createBranch.isPending || !branchName.trim() || isBlockedReplicaCreate(state.replicaFreshness, parentBranchId, forceReplicaStale)}>
                {createBranch.isPending ? <Loader2 className="animate-spin" /> : <GitBranch />}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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

function ReplicaFreshnessNotice(props: Readonly<{
  policy: ReplicaBranchCreatePolicy;
  forceReplicaStale: boolean;
  onForceReplicaStaleChange: (value: boolean) => void;
}>) {
  if (props.policy.status === 'allow') {
    if (props.policy.lagMs === null) {
      return null;
    }

    return (
      <p className="text-xs text-muted-foreground">
        {formatReplicaFreshnessInfo({ lagMs: props.policy.lagMs })}
      </p>
    );
  }

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
      <div className="flex gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <p>{formatReplicaPolicyMessage(props.policy)}</p>
      </div>
      {props.policy.status === 'block' ? (
        <label className="mt-3 flex items-center gap-2">
          <Checkbox
            checked={props.forceReplicaStale}
            onCheckedChange={function changeForceReplicaStale(checked) {
              props.onForceReplicaStaleChange(checked === true);
            }}
          />
          Create from stale replica
        </label>
      ) : null}
    </div>
  );
}

function shouldShowReplicaFreshnessInfo(freshness: Readonly<{ lagMs: number | null }> | null | undefined): freshness is Readonly<{ lagMs: number }> {
  return freshness?.lagMs !== null && freshness?.lagMs !== undefined;
}

function formatReplicaFreshnessInfo(freshness: Readonly<{ lagMs: number }>): string {
  return `New branch will use production state from about ${formatDuration(freshness.lagMs)} ago.`;
}

function formatReplicaPolicyMessage(policy: ReplicaBranchCreatePolicy): string {
  if (policy.status === 'warn') {
    return `Dev replica is ${formatDuration(policy.lagMs ?? 0)} behind production. Branch may start stale.`;
  }

  return `Dev replica is ${formatDuration(policy.lagMs ?? 0)} behind production. Create from stale replica to continue.`;
}

function isBlockedReplicaCreate(
  freshness: Readonly<{ lagMs: number | null }> | null | undefined,
  parentBranchId: string,
  forceReplicaStale: boolean
): boolean {
  if (parentBranchId !== 'production') {
    return false;
  }

  return getReplicaBranchCreatePolicy(freshness).status === 'block' && !forceReplicaStale;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);

  return `${hours}h`;
}
