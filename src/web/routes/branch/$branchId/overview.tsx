import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useState } from 'react';
import {
  ChevronDown,
  Clock3,
  GitBranch,
  Loader2,
  Pencil,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#web/components/ui/alert-dialog';
import { Badge } from '#web/components/ui/badge';
import { Button } from '#web/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#web/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#web/components/ui/dropdown-menu';
import { Input } from '#web/components/ui/input';
import { Label } from '#web/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#web/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#web/components/ui/select';
import { orpc, type ControlPlaneState } from '#web/lib/api-client';
import {
  AppSidebar,
  BranchOverviewPanel,
  formatExpiry,
  StatusBadge,
} from '#web/components/control-plane';
import { getMutationErrorMessage } from '#web/lib/errors';

export const Route = createFileRoute('/branch/$branchId/overview')({
  component: BranchOverviewPage,
});

function BranchOverviewPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const createBranch = useMutation(orpc.branches.create.mutationOptions({ onSuccess: refreshDashboard }));
  const deleteBranch = useMutation(orpc.branches.delete.mutationOptions({ onSuccess: refreshDashboard }));
  const resetBranch = useMutation(orpc.branches.reset.mutationOptions({ onSuccess: refreshDashboard }));
  const updateExpiry = useMutation(orpc.branches.expiry.update.mutationOptions({ onSuccess: refreshDashboard }));
  const params = Route.useParams();
  const busy = getBusyKey();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [childBranchName, setChildBranchName] = useState('');
  const [childParentBranchSlug, setChildParentBranchSlug] = useState('production');
  const [childTtlHours, setChildTtlHours] = useState('none');
  const [confirmAction, setConfirmAction] = useState<'reset' | 'delete' | null>(null);

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

  function openCreateChildModal() {
    setChildBranchName('');
    setChildParentBranchSlug(branch.id !== 'production' ? branch.slug : 'production');
    setChildTtlHours('none');
    setCreateModalOpen(true);
  }

  async function handleCreateChild(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const name = childBranchName.trim();

    if (!name) {
      return;
    }

    let result;

    try {
      result = await createBranch.mutateAsync({
        name,
        parent: childParentBranchSlug,
        ttlHours: childTtlHours !== 'none' ? Number(childTtlHours) : null,
      });
      toast.success(`Created branch ${result.branch.name}.`);
      setCreateModalOpen(false);
    } catch (error: any) {
      toast.error(getMutationErrorMessage(error, 'Could not create branch.'));
      return;
    }

    await navigate({ to: '/branch/$branchId/overview', params: { branchId: result.branch.slug } });
  }

  async function handleResetFromParent() {
    if (!branch.rowId) {
      return;
    }

    try {
      await resetBranch.mutateAsync({ slug: branch.slug });
      toast.success(`Reset ${branch.name}.`);
    } catch (error: any) {
      toast.error(getMutationErrorMessage(error, 'Could not reset branch.'));
    }
  }

  async function handleDelete() {
    if (!branch.rowId) {
      return;
    }

    try {
      await deleteBranch.mutateAsync({ slug: branch.slug });
      toast.success(`Deleted ${branch.name}.`);
    } catch (error: any) {
      toast.error(getMutationErrorMessage(error, 'Could not delete branch.'));
      return;
    }

    await navigate({ to: '/branch/$branchId/overview', params: { branchId: branch.parentSlug || 'production' } });
  }

  function handleConfirmAction() {
    const action = confirmAction;
    setConfirmAction(null);

    if (action === 'reset') {
      void handleResetFromParent();
      return;
    }

    if (action === 'delete') {
      void handleDelete();
    }
  }

  async function handleExpiry(value: string) {
    if (!branch.rowId) {
      return;
    }

    const expiresAt = value === 'none' ? null : new Date(Date.now() + Number(value) * 60 * 60 * 1000).toISOString();
    try {
      await updateExpiry.mutateAsync({ slug: branch.slug, expiresAt });
      toast.success(expiresAt ? `Expiry set for ${branch.name}.` : `Expiry disabled for ${branch.name}.`);
    } catch (error: any) {
      toast.error(getMutationErrorMessage(error, 'Could not update expiry.'));
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen flex-col lg:grid lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeBranchPage="overview" selectedBranch={branch.id} />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[980px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <header className="flex flex-col gap-4 md:flex-row md:flex-wrap md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{branch.badge}</Badge>
                  <StatusBadge status={branch.status} />
                  {branch.id === 'production' ? <ProtectedBranchPopover /> : null}
                </div>
                <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">Branch overview</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Current branch: {branch.name}
                  {branch.parentName ? (
                    <>
                      {' · Parent: '}
                      <Link
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                        to="/branch/$branchId/overview"
                        params={{ branchId: branch.parentSlug || 'production' }}
                        onClick={function saveParentBranch() {
                          window.localStorage.setItem('velo.selectedBranch', branch.parentSlug || 'production');
                        }}
                      >
                        {branch.parentName}
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 md:ml-auto">
                <Button
                  type="button"
                  size="lg"
                  className="h-8"
                  onClick={function createChildClick() {
                    openCreateChildModal();
                  }}
                  disabled={busy === 'create-child'}
                >
                  {busy === 'create-child' ? <Loader2 className="animate-spin" /> : <GitBranch />}
                  Create child branch
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="lg" className="h-8">
                      More
                      <ChevronDown />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem
                      disabled={branch.id === 'production' || !branch.parentName || busy === 'reset'}
                      onSelect={function selectReset() {
                        setConfirmAction('reset');
                      }}
                    >
                      <RotateCcw />
                      Reset from parent
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled>
                      <Pencil />
                      Edit name
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={branch.id === 'production' || updateExpiry.isPending}
                      onSelect={function extendOneDay() {
                        void handleExpiry('24');
                      }}
                    >
                      <Clock3 />
                      Expire in 1 day
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={branch.id === 'production' || updateExpiry.isPending}
                      onSelect={function extendSevenDays() {
                        void handleExpiry('168');
                      }}
                    >
                      <Clock3 />
                      Expire in 7 days
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={branch.id === 'production' || updateExpiry.isPending}
                      onSelect={function disableExpiry() {
                        void handleExpiry('none');
                      }}
                    >
                      <Clock3 />
                      Disable expiry
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={branch.id === 'production' || busy === 'delete'}
                      onSelect={function selectDelete() {
                        setConfirmAction('delete');
                      }}
                    >
                      <Trash2 />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </header>

            <BranchOverviewPanel
              title="Database"
              connectionLabel="Connection string"
              connectionUrl={branch.connectionUrl}
            />

            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <p className="text-sm font-medium">Expiry</p>
              <p className="mt-1 text-sm text-muted-foreground">{branch.id === 'production' ? 'production never expires' : formatExpiry(branch.expiresAt)}</p>
            </div>
          </div>
        </section>
      </div>

      <Dialog open={createModalOpen} onOpenChange={setCreateModalOpen}>
        <DialogContent>
          <form
            onSubmit={function submitCreateChild(event) {
              void handleCreateChild(event);
            }}
          >
            <DialogHeader>
              <DialogTitle>Create child branch</DialogTitle>
              <DialogDescription>From {branch.name}</DialogDescription>
            </DialogHeader>

            <div className="mt-5 grid gap-2">
              <Label>Parent branch</Label>
              <Select value={childParentBranchSlug} onValueChange={setChildParentBranchSlug}>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="production">production</SelectItem>
                  {state.branches.map(function renderParentOption(item) {
                    return (
                      <SelectItem key={item.id} value={item.slug}>
                        {item.displayName}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            <div className="mt-4 grid gap-2">
              <Label htmlFor="child-branch-name">Branch name</Label>
              <Input
                id="child-branch-name"
                value={childBranchName}
                placeholder="new-branch-name"
                autoFocus
                onChange={function updateChildBranchName(event) {
                  setChildBranchName(event.target.value);
                }}
              />
            </div>

            <div className="mt-4 grid gap-2">
              <Label>Expiry</Label>
              <Select value={childTtlHours} onValueChange={setChildTtlHours}>
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
                disabled={busy === 'create-child'}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy === 'create-child' || !childBranchName.trim()}>
                {busy === 'create-child' ? <Loader2 className="animate-spin" /> : <GitBranch />}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={function changeConfirmOpen(open) {
          if (!open) {
            setConfirmAction(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction === 'delete' ? 'Delete branch?' : 'Reset branch?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === 'delete'
                ? `Delete branch "${branch.name}"?`
                : `Reset ${branch.name} from parent ${branch.parentName}? This replaces the branch data.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === 'reset' || busy === 'delete'}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirmAction === 'delete' ? 'destructive' : 'default'}
              disabled={busy === 'reset' || busy === 'delete'}
              onClick={handleConfirmAction}
            >
              {confirmAction === 'delete' ? 'Delete' : 'Reset'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function ProtectedBranchPopover() {
  const [open, setOpen] = useState(false);

  function openPopover() {
    setOpen(true);
  }

  function closePopover() {
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          aria-label="Production protection"
          title="Production protection"
          onMouseEnter={openPopover}
          onMouseLeave={closePopover}
          onFocus={openPopover}
          onBlur={closePopover}
        >
          <ShieldCheck className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 text-sm leading-6"
        onMouseEnter={openPopover}
        onMouseLeave={closePopover}
      >
        Production is protected. It cannot be deleted, reset, or expired. New branches get separate passwords. Restores keep existing branch credentials when replacing a branch. Backup and restore actions use production history.
      </PopoverContent>
    </Popover>
  );
}

function getBranchView(state: ControlPlaneState, branchId: string) {
  if (branchId === 'production') {
    return {
      id: 'production',
      name: 'production',
      rowId: null,
      slug: 'production',
      parentBranchId: null,
      parentName: null,
      parentSlug: null,
      badge: 'Production',
      status: state.prodConnectionUrl ? 'ready' : 'pending',
      connectionUrl: state.prodConnectionUrl,
      expiresAt: null,
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
    parentName: branch?.parentName || 'production',
    parentSlug: branch?.parentSlug || 'production',
    badge: 'Development',
    status: branch?.status || 'missing',
    connectionUrl: branch?.connectionUrl || null,
    expiresAt: branch?.expiresAt || null,
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
