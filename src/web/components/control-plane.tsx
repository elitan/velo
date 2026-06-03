import type { FormEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  Activity,
  AlertTriangle,
  ArchiveRestore,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Code2,
  Copy,
  Database,
  Eye,
  GitBranch,
  LayoutDashboard,
  Loader2,
  LogOut,
  Menu,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '#lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#web/components/ui/alert-dialog';
import { Badge, type BadgeProps } from '#web/components/ui/badge';
import { Button, buttonVariants } from '#web/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#web/components/ui/card';
import { Checkbox } from '#web/components/ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#web/components/ui/dialog';
import { Input } from '#web/components/ui/input';
import { Label } from '#web/components/ui/label';
import { Separator } from '#web/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#web/components/ui/select';
import { logout } from '#web/lib/auth-client';

export type ServerRole = 'prod' | 'dev';

export interface ProductionSummaryPanelProps {
  connectionUrl: string | null;
  serverHost: string | null;
  backupMode: string;
  backupStatus: string;
  backupMessage: string | null;
}

export function ProductionSummaryPanel(props: ProductionSummaryPanelProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>Production</CardTitle>
          <CardDescription>Connection and backup health</CardDescription>
        </div>
        <StatusBadge status={props.connectionUrl ? 'ready' : 'pending'} />
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <Label>Connection string</Label>
            <Badge variant="secondary">{props.serverHost || 'no host'}</Badge>
          </div>
          <ConnectionString value={props.connectionUrl} />
        </div>
        <div className="grid gap-3 border-t border-border pt-4">
          <InfoCell label="Backup repo" value={props.backupMode} />
          <InfoCell label="Backup status" value={props.backupMessage || props.backupStatus} />
        </div>
        <Link className={cn(buttonVariants({ variant: 'outline' }), 'w-full')} to="/branch/$branchId/overview" params={{ branchId: 'production' }}>
          <Database />
          Open production
        </Link>
      </CardContent>
    </Card>
  );
}

export interface AppSidebarProps {
  branches: Array<{
    id: number;
    slug: string;
    displayName: string;
  }>;
  activeProject?: 'dashboard' | 'settings';
  activeBranchPage?: 'overview' | 'sql' | 'tables' | 'backup';
  selectedBranch?: string;
}

export function AppSidebar(props: AppSidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  function closeMobileMenu() {
    setMobileOpen(false);
  }

  return (
    <>
      <div className="sticky top-0 z-40 flex w-screen max-w-full items-center justify-between gap-4 border-b border-border bg-sidebar px-4 py-4 text-sidebar-foreground lg:hidden">
        <AppBrand />
        <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="icon-lg" aria-label="Open navigation">
              <Menu className="size-4" />
            </Button>
          </DialogTrigger>
          <DialogContent
            className="top-0 left-0 flex h-dvh max-w-72 translate-x-0 translate-y-0 flex-col rounded-none border-r border-sidebar-border bg-sidebar p-0 text-sidebar-foreground sm:max-w-72"
            showCloseButton={false}
          >
            <DialogTitle className="sr-only">Navigation</DialogTitle>
            <DialogDescription className="sr-only">
              Main navigation for Velo.
            </DialogDescription>
            <div className="flex items-center justify-between gap-3 border-b border-sidebar-border px-5 py-5">
              <AppBrand />
              <DialogClose asChild>
                <Button variant="ghost" size="icon" aria-label="Close navigation">
                  <X className="size-4" />
                </Button>
              </DialogClose>
            </div>
            <SidebarContent {...props} onNavigate={closeMobileMenu} className="flex-1 px-5 py-5" />
          </DialogContent>
        </Dialog>
      </div>

      <aside className="hidden min-h-screen bg-sidebar px-5 py-5 text-sidebar-foreground lg:block lg:border-r">
        <SidebarContent {...props} className="h-full" />
      </aside>
    </>
  );
}

function AppBrand() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-9 place-items-center rounded-md bg-primary text-primary-foreground">
        <Database className="size-4" />
      </div>
      <div>
        <div className="text-sm font-semibold leading-none">Velo</div>
        <div className="mt-1 text-xs text-muted-foreground">Control plane</div>
      </div>
    </div>
  );
}

interface SidebarContentProps extends AppSidebarProps {
  className?: string;
  onNavigate?: () => void;
}

function SidebarContent(props: SidebarContentProps) {
  const navigate = useNavigate();
  const [savedBranch, setSavedBranch] = useState(function getInitialBranch() {
    return props.selectedBranch || 'production';
  });
  const selectedBranch = props.selectedBranch || getSelectedBranch(savedBranch, props.branches);
  const selectedBranchParam = encodeURIComponent(selectedBranch);
  const overviewHref = `/branch/${selectedBranchParam}/overview`;
  const sqlHref = `/branch/${selectedBranchParam}/sql`;
  const tablesHref = `/branch/${selectedBranchParam}/tables`;
  const backupHref = `/branch/${selectedBranchParam}/backup-restore`;
  const selectedBranchIsPending = selectedBranch !== 'production' && !branchExists(selectedBranch, props.branches);

  useEffect(function saveSelectedBranch() {
    if (!props.selectedBranch) {
      return;
    }

    setSavedBranch(props.selectedBranch);
    window.localStorage.setItem('velo.selectedBranch', props.selectedBranch);
  }, [props.selectedBranch]);

  useEffect(function loadSavedBranch() {
    if (props.selectedBranch) {
      return;
    }

    setSavedBranch(window.localStorage.getItem('velo.selectedBranch') || 'production');
  }, [props.selectedBranch]);

  function changeBranch(value: string) {
    setSavedBranch(value);
    window.localStorage.setItem('velo.selectedBranch', value);
    props.onNavigate?.();
    void navigate({ to: '/branch/$branchId/overview', params: { branchId: value } });
  }

  async function handleLogout() {
    await logout();
    window.location.assign('/login');
  }

  return (
    <div className={cn('flex flex-col', props.className)}>
      <div className="hidden lg:block">
        <AppBrand />
      </div>

      <SidebarSection label="Project" className="mt-8">
        <NavItem icon={LayoutDashboard} label="Dashboard" href="/" active={props.activeProject === 'dashboard'} onNavigate={props.onNavigate} />
        <NavItem icon={Settings2} label="Settings" href="/settings" active={props.activeProject === 'settings'} onNavigate={props.onNavigate} />
      </SidebarSection>

      <SidebarSection label="Branch" className="mt-8">
        <label className="sr-only" htmlFor="branch-select">Branch</label>
        <Select value={selectedBranch} onValueChange={changeBranch}>
          <SelectTrigger id="branch-select" className="h-10 w-full bg-background font-medium">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="production">production</SelectItem>
              {selectedBranchIsPending ? (
                <SelectItem value={selectedBranch}>{selectedBranch}</SelectItem>
              ) : null}
              {props.branches.map(function renderBranchOption(branch) {
                return (
                  <SelectItem key={branch.id} value={branch.slug}>
                    {branch.displayName}
                  </SelectItem>
                );
              })}
            </SelectGroup>
          </SelectContent>
        </Select>
        <div className="mt-3 grid gap-1">
          <NavItem icon={LayoutDashboard} label="Overview" href={overviewHref} active={props.activeBranchPage === 'overview'} onNavigate={props.onNavigate} />
          <NavItem icon={Code2} label="SQL editor" href={sqlHref} active={props.activeBranchPage === 'sql'} onNavigate={props.onNavigate} />
          <NavItem icon={Table2} label="Tables" href={tablesHref} active={props.activeBranchPage === 'tables'} onNavigate={props.onNavigate} />
          <NavItem icon={ArchiveRestore} label="Backup & Restore" href={backupHref} active={props.activeBranchPage === 'backup'} onNavigate={props.onNavigate} />
        </div>
      </SidebarSection>

      <div className="mt-auto pt-8">
        <Button
          type="button"
          variant="ghost"
          className="h-9 w-full justify-start gap-2 px-3 text-sm font-normal text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          onClick={handleLogout}
        >
          <LogOut className="size-4" />
          Sign out
        </Button>
      </div>
    </div>
  );
}

function getSelectedBranch(selectedBranch: string, branches: AppSidebarProps['branches']): string {
  if (selectedBranch === 'production') {
    return selectedBranch;
  }

  return branchExists(selectedBranch, branches) ? selectedBranch : 'production';
}

function branchExists(selectedBranch: string, branches: AppSidebarProps['branches']): boolean {
  return branches.some(function hasBranch(branch) {
    return branch.slug === selectedBranch;
  });
}

interface SidebarSectionProps {
  label: string;
  className?: string;
  children: ReactNode;
}

function SidebarSection(props: SidebarSectionProps) {
  return (
    <div className={props.className}>
      <div className="mb-3 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {props.label}
      </div>
      <div className="grid gap-1 text-sm">{props.children}</div>
    </div>
  );
}

interface NavItemProps {
  icon: typeof Activity;
  label: string;
  href: string;
  active?: boolean;
  onNavigate?: () => void;
}

function NavItem(props: NavItemProps) {
  const Icon = props.icon;

  return (
    <Link
      to={props.href}
      onClick={props.onNavigate}
      className={cn(
        'flex h-9 items-center gap-2 rounded-md px-3 text-muted-foreground',
        'transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        props.active && 'bg-sidebar-accent text-sidebar-accent-foreground'
      )}
    >
      <Icon className="size-4" />
      <span>{props.label}</span>
    </Link>
  );
}

export interface MetricCardProps {
  title: string;
  value: string;
  detail: string;
  icon: typeof Activity;
  tone: 'emerald' | 'blue' | 'violet' | 'amber';
}

export function MetricCard(props: MetricCardProps) {
  const Icon = props.icon;
  const toneClass = {
    emerald: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20',
    blue: 'bg-sky-500/10 text-sky-300 ring-sky-500/20',
    violet: 'bg-violet-500/10 text-violet-300 ring-violet-500/20',
    amber: 'bg-amber-500/10 text-amber-300 ring-amber-500/20',
  }[props.tone];

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 p-4">
        <div>
          <p className="text-sm text-muted-foreground">{props.title}</p>
          <div className="mt-1 text-2xl font-semibold">{props.value}</div>
          <p className="mt-1 text-xs text-muted-foreground">{props.detail}</p>
        </div>
        <div className={cn('grid size-10 place-items-center rounded-md ring-1', toneClass)}>
          <Icon className="size-5" />
        </div>
      </CardContent>
    </Card>
  );
}

export interface BranchOverviewPanelProps {
  connectionUrl: string | null;
  title?: string;
  connectionLabel?: string;
}

export function BranchOverviewPanel(props: BranchOverviewPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title || 'Production database'}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-2">
          <Label>{props.connectionLabel || 'Production connection string'}</Label>
          <ConnectionString value={props.connectionUrl} />
        </div>
      </CardContent>
    </Card>
  );
}

interface InfoCellProps {
  label: string;
  value: string;
}

function InfoCell(props: InfoCellProps) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-muted-foreground">{props.label}</p>
      <p className="mt-1 truncate text-sm">{props.value}</p>
    </div>
  );
}

export interface BranchesPanelProps {
  branches: Array<{
    id: number;
    slug: string;
    displayName: string;
    status: string;
    port: number | null;
    connectionUrl: string | null;
    expiresAt: string | null;
  }>;
  busy: string | null;
  onDelete: (id: number, name: string) => Promise<void>;
}

interface BranchTreePanelProps {
  branches: Array<{
    id: number;
    slug: string;
    displayName: string;
    status: string;
    parentBranchId: number | null;
    parentName: string | null;
    parentSlug: string | null;
    expiresAt: string | null;
  }>;
  prodReady: boolean;
}

interface BranchTreeNode {
  branch: BranchTreePanelProps['branches'][number];
  children: BranchTreeNode[];
}

export function BranchTreePanel(props: BranchTreePanelProps) {
  const tree = buildBranchTree(props.branches);

  return (
    <Card>
      <CardContent className="p-2">
        <Link
          className={cn(
            'flex min-h-14 items-center gap-3 rounded-md px-3 py-2',
            'transition-colors hover:bg-accent hover:text-accent-foreground'
          )}
          to="/branch/$branchId/overview"
          params={{ branchId: 'production' }}
          onClick={function saveProdBranch() {
            window.localStorage.setItem('velo.selectedBranch', 'production');
          }}
        >
          <div className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
            <Database className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate font-medium">production</p>
            </div>
          </div>
          <StatusBadge status={props.prodReady ? 'ready' : 'pending'} />
        </Link>

        {tree.length > 0 ? (
          <div className="ml-7 border-l border-border pl-4">
            {tree.map(function renderRoot(node) {
              return <BranchTreeItem key={node.branch.id} node={node} />;
            })}
          </div>
        ) : (
          <div className="ml-7 border-l border-border py-6 pl-4 text-sm text-muted-foreground">
            No dev branches yet.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BranchTreeItem(props: { node: BranchTreeNode }) {
  const branch = props.node.branch;
  const branchLine = formatBranchLine(branch.expiresAt);

  return (
    <div className="relative">
      <div className="absolute left-[-1rem] top-7 h-px w-4 bg-border" />
      <Link
        className={cn(
          'my-1 flex min-h-14 items-center gap-3 rounded-md px-3 py-2',
          'transition-colors hover:bg-accent hover:text-accent-foreground'
        )}
        to="/branch/$branchId/overview"
        params={{ branchId: branch.slug }}
        onClick={function saveBranch() {
          window.localStorage.setItem('velo.selectedBranch', branch.slug);
        }}
      >
        <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <GitBranch className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate font-medium">{branch.displayName}</p>
          </div>
          {branchLine ? <p className="mt-1 truncate text-xs text-muted-foreground">{branchLine}</p> : null}
        </div>
        <StatusBadge status={branch.status} />
      </Link>

      {props.node.children.length > 0 ? (
        <div className="ml-7 border-l border-border pl-4">
          {props.node.children.map(function renderChild(child) {
            return <BranchTreeItem key={child.branch.id} node={child} />;
          })}
        </div>
      ) : null}
    </div>
  );
}

function buildBranchTree(branches: BranchTreePanelProps['branches']): BranchTreeNode[] {
  const nodesById = new Map<number, BranchTreeNode>();
  const roots: BranchTreeNode[] = [];

  branches.forEach(function addNode(branch) {
    nodesById.set(branch.id, { branch, children: [] });
  });

  branches.forEach(function linkNode(branch) {
    const node = nodesById.get(branch.id);

    if (!node) {
      return;
    }

    if (!branch.parentBranchId) {
      roots.push(node);
      return;
    }

    const parent = nodesById.get(branch.parentBranchId);

    if (!parent) {
      roots.push(node);
      return;
    }

    parent.children.push(node);
  });

  sortBranchNodes(roots);

  return roots;
}

function sortBranchNodes(nodes: BranchTreeNode[]) {
  nodes.sort(function sortByName(first, second) {
    return first.branch.displayName.localeCompare(second.branch.displayName);
  });

  nodes.forEach(function sortChildren(node) {
    sortBranchNodes(node.children);
  });
}

export function BranchesPanel(props: BranchesPanelProps) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>Branches</CardTitle>
          <CardDescription>Writable ZFS clones from the dev base.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {props.branches.length === 0 ? (
          <EmptyState icon={GitBranch} title="No branches yet" detail="No writable branch clones found." />
        ) : (
          <div className="divide-y">
            {props.branches.map(function renderBranch(branch) {
              const isDeleting = props.busy === `delete-branch-${branch.id}`;

              async function deleteClick() {
                await props.onDelete(branch.id, branch.displayName);
              }

              return (
                <div className="grid gap-3 px-5 py-4 md:grid-cols-[1fr_120px_150px_80px_auto] md:items-center" key={branch.id}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <GitBranch className="size-4 text-muted-foreground" />
                      <p className="font-medium">{branch.displayName}</p>
                    </div>
                    <div className="mt-2 md:hidden">
                      <ConnectionString value={branch.connectionUrl} />
                    </div>
                  </div>
                  <StatusBadge status={branch.status} />
                  <div className="text-sm text-muted-foreground">{formatExpiry(branch.expiresAt)}</div>
                  <div className="text-sm text-muted-foreground">{branch.port || '-'}</div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        disabled={isDeleting}
                        title="Delete branch"
                      >
                        {isDeleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete branch?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Delete branch "{branch.displayName}"?
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-white hover:bg-destructive/90"
                          disabled={isDeleting}
                          onClick={function confirmDelete() {
                            void deleteClick();
                          }}
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  <div className="hidden md:col-span-5 md:block">
                    <ConnectionString value={branch.connectionUrl} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatBranchLine(expiresAt: string | null): string | null {
  const expiry = formatExpiry(expiresAt);

  if (expiry === 'no expiry') {
    return null;
  }

  return expiry;
}

export function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) {
    return 'no expiry';
  }

  const time = new Date(expiresAt).getTime();

  if (Number.isNaN(time)) {
    return 'invalid expiry';
  }

  const diffMs = time - Date.now();
  const suffix = diffMs < 0 ? 'expired' : 'expires';
  const absMs = Math.abs(diffMs);
  const hours = Math.ceil(absMs / (60 * 60 * 1000));

  if (hours < 48) {
    return `${suffix} in ${hours}h`;
  }

  return `${suffix} in ${Math.ceil(hours / 24)}d`;
}

export interface ServerPanelProps {
  title: string;
  role: ServerRole;
  server: {
    host: string;
    sshUser: string;
    sshKeyPath: string;
    status: string;
    statusMessage: string | null;
  } | undefined;
  allowedCidr?: string;
  busy: string | null;
  onSave: (formData: FormData) => Promise<void>;
  onCheck: (role: ServerRole) => Promise<void>;
}

export function ServerPanel(props: ServerPanelProps) {
  const isSaving = props.busy === `save-${props.role}`;
  const isChecking = props.busy === `check-${props.role}`;

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.onSave(new FormData(event.currentTarget));
  }

  async function clickCheck() {
    await props.onCheck(props.role);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>{props.title}</CardTitle>
          <CardDescription>{props.role === 'prod' ? 'Primary database host' : 'Branching host'}</CardDescription>
        </div>
        <StatusBadge status={props.server?.status || 'unknown'} />
      </CardHeader>
      <CardContent>
        <form onSubmit={submitForm} className="grid gap-4">
          <input type="hidden" name="role" value={props.role} />
          <Field label="Host">
            <Input name="host" defaultValue={props.server?.host || ''} placeholder="1.2.3.4" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            <Field label="SSH user">
              <Input name="sshUser" defaultValue={props.server?.sshUser || 'root'} placeholder="root" />
            </Field>
            <Field label="SSH key">
              <Input name="sshKeyPath" defaultValue={props.server?.sshKeyPath || '~/.ssh/id_ed25519'} />
            </Field>
          </div>
          {props.role === 'prod' ? (
            <Field label="Allowed CIDR">
              <Input name="allowedCidr" defaultValue={props.allowedCidr || ''} placeholder="203.0.113.10/32" />
            </Field>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" className="flex-1" disabled={isSaving}>
              {isSaving ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
              Save
            </Button>
            <Button type="button" variant="outline" onClick={clickCheck} disabled={isChecking || !props.server}>
              {isChecking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Check
            </Button>
          </div>
        </form>
        <p className="mt-4 line-clamp-3 text-xs leading-5 text-muted-foreground">
          {props.server?.statusMessage || 'Not checked yet.'}
        </p>
      </CardContent>
    </Card>
  );
}

export interface BackupPanelProps {
  backup: {
    enabled: boolean;
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretConfigured: boolean;
    path: string;
    pitrDays: number;
    fullBackupRetentionDays: number;
  };
  busy: boolean;
  onSave: (formData: FormData) => Promise<void>;
}

export function BackupPanel(props: BackupPanelProps) {
  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.onSave(new FormData(event.currentTarget));
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>Backups</CardTitle>
          <CardDescription>S3 storage, PITR, and retention</CardDescription>
        </div>
        <Badge variant={props.backup.enabled ? 'success' : 'secondary'}>
          {props.backup.enabled ? 'S3' : 'local'}
        </Badge>
      </CardHeader>
      <CardContent>
        <form onSubmit={submitForm} className="grid gap-4">
          <Label className="flex items-center gap-2">
            <Checkbox name="enabled" defaultChecked={props.backup.enabled} />
            Use S3 compatible storage
          </Label>
          <Field label="Endpoint">
            <Input name="endpoint" defaultValue={props.backup.endpoint} placeholder="https://account.r2.cloudflarestorage.com" />
          </Field>
          <Field label="Bucket">
            <Input name="bucket" defaultValue={props.backup.bucket} placeholder="velo-dev" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Region">
              <Input name="region" defaultValue={props.backup.region} placeholder="auto" />
            </Field>
            <Field label="Path">
              <Input name="path" defaultValue={props.backup.path} placeholder="/prod" />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="PITR days">
              <Input name="pitrDays" type="number" min={1} defaultValue={props.backup.pitrDays} />
            </Field>
            <Field label="Full backup retention days">
              <Input name="fullBackupRetentionDays" type="number" min={1} defaultValue={props.backup.fullBackupRetentionDays} />
            </Field>
          </div>
          <Field label="Access key">
            <Input name="accessKeyId" defaultValue={props.backup.accessKeyId} autoComplete="off" />
          </Field>
          <Field label="Secret key">
            <Input
              name="secretAccessKey"
              type="password"
              placeholder={props.backup.secretConfigured ? 'configured, leave blank to keep' : ''}
              autoComplete="off"
            />
          </Field>
          <Button type="submit" disabled={props.busy}>
            {props.busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            Save backups
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export interface JobsPanelProps {
  jobs: JobPanelRecord[];
  activeJobs: number;
  loading?: boolean;
  statusFilter: string;
  onStatusFilterChange: (status: string) => void;
  page: number;
  hasMore: boolean;
  selectedJob: JobPanelRecord | null;
  selectedJobOpen: boolean;
  selectedJobLoading: boolean;
  busyJobId: number | null;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onOpenJob: (jobId: number) => void;
  onCloseJob: () => void;
  onRetry: (jobId: number) => Promise<void>;
  onCancel: (jobId: number) => Promise<void>;
}

interface JobPanelRecord {
  id: number;
  type: string;
  status: string;
  input: unknown;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  updatedAt: string;
  durationMs: number | null;
  canRetry: boolean;
  canCancel: boolean;
  logs: Array<{
    id: number;
    level: 'info' | 'error';
    message: string;
    createdAt?: string;
  }>;
}

const JOB_STATUS_FILTERS = ['all', 'queued', 'running', 'done', 'error', 'cancelled'];

export function JobsPanel(props: JobsPanelProps) {
  return (
    <>
      <Card>
        <CardHeader className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <CardTitle>Jobs</CardTitle>
            <CardDescription>Background branch and maintenance activity</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={props.statusFilter} onValueChange={props.onStatusFilterChange}>
              <SelectTrigger className="h-9 w-36 bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {JOB_STATUS_FILTERS.map(function renderStatusFilter(status) {
                  return <SelectItem key={status} value={status}>{status}</SelectItem>;
                })}
              </SelectContent>
            </Select>
            <Badge variant={props.activeJobs > 0 ? 'info' : 'secondary'}>{props.activeJobs} active</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {props.loading ? (
            <EmptyState icon={Loader2} title="Loading jobs" detail="Fetching latest job history." compact />
          ) : props.jobs.length === 0 ? (
            <EmptyState icon={Clock3} title="No jobs yet" detail="Maintenance actions will appear here." compact />
          ) : (
            <div className="grid gap-3">
              {props.jobs.map(function renderJob(job) {
                const busy = props.busyJobId === job.id;

                return (
                  <div className="border-t border-border pt-3 first:border-t-0 first:pt-0" key={job.id}>
                    <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium">{job.type}</p>
                          <StatusBadge status={job.status} />
                        </div>
                        <p className="mt-2 truncate text-xs text-muted-foreground">
                          {job.error || `${formatJobDuration(job.durationMs)} · ${formatLastCheck(job.updatedAt)}`}
                        </p>
                      </div>
                      <JobActionButtons job={job} busy={busy} compact onOpen={props.onOpenJob} onRetry={props.onRetry} onCancel={props.onCancel} />
                    </div>
                    {job.logs.length > 0 ? (
                      <>
                        <Separator className="my-3" />
                        <div className="grid gap-1">
                          {job.logs.slice(0, 3).map(function renderLog(log) {
                            return (
                              <code
                                className={cn(
                                  'block truncate text-xs text-muted-foreground',
                                  log.level === 'error' && 'text-destructive'
                                )}
                                key={log.id}
                              >
                                {log.message}
                              </code>
                            );
                          })}
                        </div>
                      </>
                    ) : null}
                  </div>
                );
              })}
              <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                <Button type="button" variant="outline" size="sm" disabled={props.page === 0} onClick={props.onPreviousPage}>
                  <ChevronLeft />
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">Page {props.page + 1}</span>
                <Button type="button" variant="outline" size="sm" disabled={!props.hasMore} onClick={props.onNextPage}>
                  Next
                  <ChevronRight />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <JobDetailDialog
        job={props.selectedJob}
        open={props.selectedJobOpen}
        loading={props.selectedJobLoading}
        busy={props.selectedJob ? props.busyJobId === props.selectedJob.id : false}
        onClose={props.onCloseJob}
        onRetry={props.onRetry}
        onCancel={props.onCancel}
      />
    </>
  );
}

function JobDetailDialog(props: {
  job: JobPanelRecord | null;
  open: boolean;
  loading: boolean;
  busy: boolean;
  onClose: () => void;
  onRetry: (jobId: number) => Promise<void>;
  onCancel: (jobId: number) => Promise<void>;
}) {
  const job = props.job;

  return (
    <Dialog open={props.open} onOpenChange={function changeJobDialog(open) {
      if (!open) {
        props.onClose();
      }
    }}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-2xl">
        {props.loading || !job ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="animate-spin" />
            Loading job...
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{job.type}</DialogTitle>
              <DialogDescription>Job #{job.id}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 overflow-y-auto pr-1">
              <div className="grid gap-3 sm:grid-cols-3">
                <InfoCell label="Status" value={job.status} />
                <InfoCell label="Duration" value={formatJobDuration(job.durationMs)} />
                <InfoCell label="Attempts" value={`${job.attempts}/${job.maxAttempts}`} />
              </div>
              {job.error ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  {job.error}
                </div>
              ) : null}
              <div>
                <Label>Input</Label>
                <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                  {formatJobInput(job.input)}
                </pre>
              </div>
              <div>
                <Label>Logs</Label>
                <div className="mt-2 grid max-h-72 gap-1 overflow-auto rounded-md border border-border bg-muted/40 p-3">
                  {job.logs.length > 0 ? job.logs.map(function renderJobLog(log) {
                    return (
                      <code
                        className={cn('text-xs text-muted-foreground', log.level === 'error' && 'text-destructive')}
                        key={log.id}
                      >
                        {log.createdAt ? `${formatLastCheck(log.createdAt)} ` : ''}{log.message}
                      </code>
                    );
                  }) : (
                    <p className="text-xs text-muted-foreground">No logs.</p>
                  )}
                </div>
              </div>
            </div>
            <DialogFooter>
              <JobActionButtons job={job} busy={props.busy} onRetry={props.onRetry} onCancel={props.onCancel} />
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function JobActionButtons(props: {
  job: JobPanelRecord;
  busy: boolean;
  compact?: boolean;
  onOpen?: (jobId: number) => void;
  onRetry: (jobId: number) => Promise<void>;
  onCancel: (jobId: number) => Promise<void>;
}) {
  return (
    <div className="flex gap-2">
      {props.onOpen ? (
        <Button type="button" size="icon" variant="outline" title="View job" onClick={function openJob() {
          props.onOpen?.(props.job.id);
        }}>
          <Eye />
        </Button>
      ) : null}
      {props.job.canRetry ? (
        <Button
          type="button"
          size={props.compact ? 'icon' : 'default'}
          variant={props.compact ? 'outline' : 'default'}
          title="Retry job"
          disabled={props.busy}
          onClick={function retryJob() {
            void props.onRetry(props.job.id);
          }}
        >
          {props.busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          {props.compact ? null : 'Retry'}
        </Button>
      ) : null}
      {props.job.canCancel ? (
        <Button
          type="button"
          size={props.compact ? 'icon' : 'default'}
          variant="outline"
          title="Cancel job"
          disabled={props.busy}
          onClick={function cancelJob() {
            void props.onCancel(props.job.id);
          }}
        >
          {props.busy ? <Loader2 className="animate-spin" /> : <Ban />}
          {props.compact ? null : 'Cancel'}
        </Button>
      ) : null}
    </div>
  );
}

function formatJobDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return '-';
  }

  const seconds = Math.round(durationMs / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  return `${Math.round(minutes / 60)}h`;
}

function formatJobInput(input: unknown): string {
  if (input === undefined) {
    return 'none';
  }

  return JSON.stringify(input, null, 2);
}

function formatLastCheck(value: string | null | undefined): string {
  if (!value) {
    return 'never';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(0, Math.round(diffMs / 60000));

  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.round(hours / 24)}d ago`;
}

interface FieldProps {
  label: string;
  children: ReactNode;
}

function Field(props: FieldProps) {
  return (
    <div className="grid gap-2">
      <Label>{props.label}</Label>
      {props.children}
    </div>
  );
}

interface ConnectionStringProps {
  value: string | null;
}

function ConnectionString(props: ConnectionStringProps) {
  const [copied, setCopied] = useState(false);
  const value = props.value || '';

  async function copyValue() {
    if (!value) {
      return;
    }

    try {
      await copyToClipboard(value);
      setCopied(true);
      toast.success('Connection string copied.');
      window.setTimeout(function resetCopied() {
        setCopied(false);
      }, 1400);
    } catch (error) {
      toast.error('Could not copy connection string.');
    }
  }

  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
      <Button type="button" size="icon" variant="outline" onClick={copyValue} disabled={!value} title="Copy connection string">
        {copied ? <CheckCircle2 className="text-emerald-600" /> : <Copy />}
      </Button>
      <code className="min-w-0 truncate rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
        {value || 'not ready'}
      </code>
    </div>
  );
}

async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand('copy');
  document.body.removeChild(textArea);
}

interface EmptyStateProps {
  icon: typeof Activity;
  title: string;
  detail: string;
  compact?: boolean;
}

function EmptyState(props: EmptyStateProps) {
  const Icon = props.icon;

  return (
    <div className={cn('grid place-items-center px-5 text-center', props.compact ? 'py-6' : 'py-12')}>
      <div className="grid size-10 place-items-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <p className="mt-3 text-sm font-medium">{props.title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{props.detail}</p>
    </div>
  );
}

export function StatusBadge(props: { status: string }) {
  const variant = getStatusVariant(props.status);
  const Icon = getStatusIcon(props.status);
  const label = getStatusLabel(props.status);

  return (
    <Badge variant={variant} className="capitalize">
      <Icon className={cn('size-3', props.status === 'creating' && 'animate-spin')} />
      {label}
    </Badge>
  );
}

function getStatusVariant(status: string): BadgeProps['variant'] {
  if (status === 'ok' || status === 'done' || status === 'ready' || status === 'running') {
    return 'success';
  }

  if (status === 'creating') {
    return 'info';
  }

  if (status === 'stopped') {
    return 'warning';
  }

  if (status === 'error') {
    return 'destructive';
  }

  return 'warning';
}

function getStatusIcon(status: string) {
  if (status === 'ok' || status === 'done') {
    return CheckCircle2;
  }

  if (status === 'ready' || status === 'running') {
    return Activity;
  }

  if (status === 'creating') {
    return Loader2;
  }

  if (status === 'stopped') {
    return Clock3;
  }

  if (status === 'error') {
    return AlertTriangle;
  }

  return Clock3;
}

function getStatusLabel(status: string): string {
  if (status === 'ready') {
    return 'running';
  }

  return status;
}
