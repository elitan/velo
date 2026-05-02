import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ComponentType } from 'react';
import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  Code2,
  Database,
  GitBranch,
  GitCompareArrows,
  Info,
  Loader2,
  Search,
  Table2,
  X,
  Zap,
} from 'lucide-react';
import { Badge } from '#web/components/ui/badge';
import { Button } from '#web/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#web/components/ui/card';
import { Input } from '#web/components/ui/input';
import { Label } from '#web/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#web/components/ui/select';
import { orpc, type ControlPlaneState } from '#web/lib/api-client';
import {
  AppSidebar,
  StatusBadge,
} from '#web/components/control-plane';
import { isSetupComplete, OnboardingWizard } from '#web/components/onboarding-wizard';

export const Route = createFileRoute('/branch/$branchId/backup-restore')({
  component: BackupRestorePage,
});

function BackupRestorePage() {
  const queryClient = useQueryClient();
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const createPreviewBranch = useMutation(orpc.branches.preview.create.mutationOptions());
  const deletePreviewBranch = useMutation(orpc.branches.preview.delete.mutationOptions({ onSuccess: refreshDashboard }));
  const restoreBranch = useMutation(orpc.branches.restore.mutationOptions({ onSuccess: refreshDashboard }));
  const params = Route.useParams();
  const initialBackupOptions = dashboard.data ? getBackupOptions(dashboard.data.backupAvailability.backups) : [];
  const initialRestoreWindow = dashboard.data ? getRestoreWindow(dashboard.data.backupAvailability.pitr) : { min: null, max: null };
  const [backupPoint, setBackupPoint] = useState(initialBackupOptions[0]?.value || '');
  const [restoreTime, setRestoreTime] = useState(function initialRestoreTime() {
    return getDefaultRestoreTime(initialRestoreWindow);
  });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBranch, setPreviewBranch] = useState<PreviewBranch | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [restorePromptOpen, setRestorePromptOpen] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const previewBusy = createPreviewBranch.isPending || deletePreviewBranch.isPending;
  const restoreBusy = restoreBranch.isPending;

  useEffect(function fillRestoreDefaults() {
    if (!dashboard.data) {
      return;
    }

    if (!backupPoint) {
      setBackupPoint(getBackupOptions(dashboard.data.backupAvailability.backups)[0]?.value || '');
    }

    if (!restoreTime) {
      setRestoreTime(getDefaultRestoreTime(getRestoreWindow(dashboard.data.backupAvailability.pitr)));
    }
  }, [backupPoint, dashboard.data, restoreTime]);

  async function refreshDashboard() {
    await queryClient.invalidateQueries({ queryKey: orpc.dashboard.retrieve.key() });
  }

  if (!dashboard.data) {
    return <BackupRestoreLoadingPage message={dashboard.error ? 'Could not load backup data.' : 'Loading backup data...'} />;
  }

  const state = dashboard.data;

  if (!isSetupComplete(state)) {
    return <OnboardingWizard />;
  }

  const branchId = params.branchId;
  const isProd = branchId === 'prod';
  const branch = isProd ? null : state.branches.find(function findBranch(item) {
    return item.slug === branchId;
  });
  const selectedBranch = isProd ? 'prod' : branch?.slug || branchId;
  const selectedBranchLabel = isProd ? 'prod' : branch?.displayName || branchId;
  const status = isProd ? (state.prodConnectionUrl ? 'ready' : 'pending') : branch?.status || 'missing';
  const branchOptions = getBranchOptions(state);
  const backupOptions = getBackupOptions(state.backupAvailability.backups);
  const restoreWindow = getRestoreWindow(state.backupAvailability.pitr);
  const backupWindow = getBackupWindow(state.backupAvailability.backups);
  const pitrAvailable = state.backupAvailability.status === 'ok' && Boolean(restoreWindow.min && restoreWindow.max);
  const sourceBranch = 'prod';

  async function handleOpenPreview() {
    setPreviewError(null);

    try {
      const created = await createPreviewBranch.mutateAsync({
        sourceBranch,
        restoreTime: toRestoreIso(restoreTime),
      });
      setPreviewBranch(created);
      setPreviewOpen(true);
    } catch (error: any) {
      setPreviewError(error?.message || 'Could not create preview branch');
    }
  }

  async function handleClosePreview() {
    const branchToDelete = previewBranch;
    setPreviewOpen(false);
    setPreviewBranch(null);

    if (!branchToDelete) {
      return;
    }

    try {
      await deletePreviewBranch.mutateAsync({ id: branchToDelete.id });
    } catch (error: any) {
      setPreviewError(error?.message || `Could not delete preview branch ${branchToDelete.displayName}`);
    }
  }

  async function handleRestore() {
    setRestoreError(null);
    setRestoreMessage(null);

    try {
      const job = await restoreBranch.mutateAsync({
        targetBranch: selectedBranch,
        sourceBranch,
        restoreTime: toRestoreIso(restoreTime),
      });
      setRestorePromptOpen(false);
      setRestoreMessage(`Restore job ${job.id} started. Progress is available in Settings.`);
      await refreshDashboard();
    } catch (error: any) {
      setRestoreError(error?.message || 'Could not start restore');
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeBranchPage="backup" selectedBranch={selectedBranch} />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <header>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{isProd ? 'Production' : 'Development'}</Badge>
                <StatusBadge status={status} />
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">Backup & Restore</h1>
              <div className="mt-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <GitBranch className="size-4" />
                <span>{selectedBranchLabel}</span>
              </div>
              <p className="mt-6 max-w-2xl text-sm leading-6 text-muted-foreground">
                Use point-in-time restore for exact recent recovery, or daily backups for older recovery.
              </p>
            </header>

            <Card className="max-w-5xl">
              <CardHeader>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex gap-4">
                    <div className="mt-1 grid size-10 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
                      <Zap className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <CardTitle>Instant point-in-time restore</CardTitle>
                      <CardDescription className="mt-2 max-w-xl">
                        {pitrAvailable
                          ? `Restore to any exact moment in the available backup history.`
                          : 'No point-in-time restore history is available yet.'}
                      </CardDescription>
                    </div>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="grid gap-5">
                <div className="grid gap-4 rounded-lg border border-border bg-muted/30 p-4 md:grid-cols-2">
                  <div className="grid gap-2">
                    <Label>Source branch</Label>
                    <div className="flex h-10 items-center rounded-md border border-input bg-background px-3 text-sm font-medium">
                      prod
                    </div>
                    <div className="text-xs text-muted-foreground">PITR uses production WAL history for any target branch.</div>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="restore-time">Point in time</Label>
                    <div className="relative">
                      <Calendar className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="restore-time"
                        type="datetime-local"
                        className="h-10 pl-9"
                        min={restoreWindow.min || undefined}
                        max={restoreWindow.max || undefined}
                        value={restoreTime}
                        disabled={!pitrAvailable}
                        onChange={function changeRestoreTime(event) {
                          setRestoreTime(event.target.value);
                        }}
                      />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {pitrAvailable && restoreWindow.min && restoreWindow.max
                        ? `Europe/Stockholm. Available from ${formatShortDateTime(restoreWindow.min)} to ${formatShortDateTime(restoreWindow.max)}.`
                        : state.backupAvailability.message || 'PITR is not available yet.'}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
                  <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                    Preview creates a temporary read-only restore branch for the selected time. Production and dev branches stay untouched.
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!pitrAvailable || previewBusy || restoreBusy}
                      onClick={function previewDataClick() {
                        void handleOpenPreview();
                      }}
                    >
                      {previewBusy ? <Loader2 className="animate-spin" /> : <Search />}
                      {previewBusy ? 'Creating preview' : 'Preview data'}
                    </Button>
                    <Button
                      type="button"
                      disabled={!pitrAvailable || previewBusy || restoreBusy}
                      onClick={function restoreClick() {
                        setRestorePromptOpen(true);
                      }}
                    >
                      Restore to point in time
                    </Button>
                  </div>
                </div>

                {restoreMessage ? (
                  <div className="rounded-md border border-emerald-500/30 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                    {restoreMessage}
                  </div>
                ) : null}

                {previewError || restoreError ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    {previewError || restoreError}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card className="max-w-5xl">
              <CardHeader>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex gap-4">
                    <div className="mt-1 grid size-10 shrink-0 place-items-center rounded-md border border-border bg-muted text-muted-foreground">
                      <Database className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <CardTitle>Restore from daily backup</CardTitle>
                      <CardDescription className="mt-2 max-w-xl">
                        Restore from real production full backups found in pgBackRest.
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant="secondary">{state.backup.fullBackupRetentionDays} day policy</Badge>
                </div>
              </CardHeader>

              <CardContent className="grid gap-5">
                <div className="grid gap-4 rounded-lg border border-border bg-muted/30 p-4 md:grid-cols-2">
                  <div className="grid gap-2">
                    <Label>Source branch</Label>
                    <div className="flex h-10 items-center rounded-md border border-input bg-background px-3 text-sm font-medium">
                      prod
                    </div>
                    <div className="text-xs text-muted-foreground">Daily backups are taken only from production.</div>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="backup-point">Backup</Label>
                    <Select value={backupPoint} onValueChange={setBackupPoint} disabled={!backupOptions.length}>
                      <SelectTrigger id="backup-point" className="h-10 w-full bg-background font-medium">
                        <SelectValue placeholder="Select backup" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {backupOptions.map(function renderBackupOption(option) {
                            return (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            );
                          })}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <div className="text-xs text-muted-foreground">
                      {backupOptions.length
                        ? `Available from ${backupWindow.from} to ${backupWindow.to}. Daily restore points are less precise than PITR.`
                        : 'No production full backups found yet.'}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
                  <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                    Use this when the recovery point is older than the PITR window. The source is always production.
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button type="button" variant="outline" disabled>
                      <Search />
                      Preview backup
                    </Button>
                    <Button type="button" disabled>
                      Restore from backup
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>
      </div>

      {previewOpen ? (
        <HistoricPreviewModal
          branch={sourceBranch}
          branchOptions={branchOptions}
          previewBranch={previewBranch}
          restoreTime={restoreTime}
          onClose={function closePreview() {
            void handleClosePreview();
          }}
          onRestore={function restoreFromPreview() {
            void handleRestore();
          }}
          restoreBusy={restoreBusy}
        />
      ) : null}

      {restorePromptOpen ? (
        <RestorePromptModal
          branch={selectedBranch}
          sourceBranch={sourceBranch}
          restoreTime={restoreTime}
          previewBusy={previewBusy}
          restoreBusy={restoreBusy}
          restoreError={restoreError}
          onClose={function closeRestorePrompt() {
            setRestorePromptOpen(false);
          }}
          onRestore={function confirmRestore() {
            void handleRestore();
          }}
        />
      ) : null}
    </main>
  );
}

function RestorePromptModal(props: {
  branch: string;
  sourceBranch: string;
  restoreTime: string;
  previewBusy: boolean;
  restoreBusy: boolean;
  restoreError: string | null;
  onClose: () => void;
  onRestore: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 text-card-foreground shadow-xl">
        <div className="flex gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-md bg-amber-50 text-amber-700">
            <AlertTriangle className="size-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-normal">Restore branch</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              You are about to restore {props.branch} from {props.sourceBranch} at {formatHistoricTime(props.restoreTime)}.
              This replaces the current branch data with the selected point in time.
            </p>
          </div>
        </div>

        {props.restoreError ? (
          <div className="mt-5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {props.restoreError}
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            autoFocus
            data-default-action=""
            disabled={props.previewBusy || props.restoreBusy}
            onClick={props.onRestore}
          >
            {props.restoreBusy ? <Loader2 className="animate-spin" /> : <Zap />}
            Restore now
          </Button>
        </div>
      </div>
    </div>
  );
}

function HistoricPreviewModal(props: {
  branch: string;
  branchOptions: BranchOption[];
  previewBranch: PreviewBranch | null;
  restoreTime: string;
  onClose: () => void;
  onRestore: () => void;
  restoreBusy: boolean;
}) {
  const [tab, setTab] = useState<'browse' | 'query' | 'compare'>('browse');
  const historicTime = formatHistoricTime(props.restoreTime);

  return (
    <div className="fixed inset-0 z-50 bg-background/80 p-3 backdrop-blur-sm">
      <div className="grid h-full grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl">
        <div className="flex flex-col gap-3 border-b border-border px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-normal">Preview historic data</h2>
            <div className="mt-3 flex flex-wrap items-start gap-2">
              <Select value={props.branch} disabled>
                <SelectTrigger className="w-52 bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                  {props.branchOptions.map(function renderBranchOption(option) {
                    return (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    );
                  })}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <div>
                <div className="relative w-64">
                  <Calendar className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input className="pl-9" type="datetime-local" value={props.restoreTime} readOnly />
                </div>
                <div className="mt-1 text-xs text-muted-foreground">Europe/Stockholm, GMT+02:00</div>
              </div>
              <div className="flex rounded-md border border-border p-0.5">
                <PreviewTab active={tab === 'browse'} label="Browse data" onClick={function selectBrowse() { setTab('browse'); }} />
                <PreviewTab active={tab === 'query'} label="Query data" onClick={function selectQuery() { setTab('query'); }} />
                <PreviewTab active={tab === 'compare'} label="Compare schemas" onClick={function selectCompare() { setTab('compare'); }} />
              </div>
              {props.previewBranch ? (
                <Badge variant="info">Preview branch: {props.previewBranch.displayName}</Badge>
              ) : null}
            </div>
          </div>

          <Button type="button" variant="outline" size="icon" onClick={props.onClose} aria-label="Close preview">
            <X />
          </Button>
        </div>

        <div className="flex items-center justify-center gap-2 bg-blue-600 px-4 py-2 text-sm font-medium text-white">
          <Info className="size-4" />
          <span>You are viewing data as it existed at {historicTime}</span>
        </div>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[280px_1fr]">
          <aside className="grid min-h-0 border-b border-border px-4 py-5 lg:border-b-0 lg:border-r">
            <div>
              <h3 className="text-xl font-semibold tracking-normal">Tables</h3>
              <div className="mt-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <GitBranch className="size-4" />
                <span>{props.branch}</span>
              </div>

              <div className="mt-5 grid gap-3">
                <SelectShell icon={Database} value="postgres" />
                <SelectShell icon={Table2} value="public" />
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input className="pl-9" placeholder="Search..." />
                </div>
              </div>
            </div>
          </aside>

          <section className="min-h-[360px] p-6">
            {tab === 'browse' ? (
              <PreviewEmptyState
                icon={Table2}
                title="Historic tables will appear here"
                description="Preview will use a temporary read-only restore branch, then remove it after you close this modal."
              />
            ) : null}

            {tab === 'query' ? (
              <QueryPreviewPanel />
            ) : null}

            {tab === 'compare' ? (
              <PreviewEmptyState
                icon={GitCompareArrows}
                title="Compare current and historic schema"
                description="Use this before restore to see what changed between now and the selected time."
              />
            ) : null}
          </section>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-4">
          <Button type="button" variant="outline" onClick={props.onClose}>Cancel</Button>
          <Button
            type="button"
            autoFocus
            data-default-action=""
            disabled={props.restoreBusy}
            onClick={props.onRestore}
          >
            {props.restoreBusy ? <Loader2 className="animate-spin" /> : <Zap />}
            Proceed to restore
          </Button>
        </div>
      </div>
    </div>
  );
}

function PreviewTab(props: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={props.active ? 'h-8 rounded-sm bg-secondary px-3 text-sm font-medium text-secondary-foreground' : 'h-8 rounded-sm px-3 text-sm font-medium text-muted-foreground hover:text-foreground'}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function QueryPreviewPanel() {
  return (
    <div className="grid h-full min-h-[320px] grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
      <div>
        <h3 className="text-lg font-semibold tracking-normal">Query historic data</h3>
        <p className="mt-1 text-sm text-muted-foreground">Run SQL against the temporary historic branch, not the live database.</p>
      </div>
      <textarea
        className="min-h-0 resize-none rounded-md border border-input bg-background p-3 font-mono text-sm leading-6 outline-none ring-ring transition-shadow placeholder:text-muted-foreground focus:ring-2"
        placeholder="select * from users limit 50;"
      />
      <div className="flex justify-end">
        <Button type="button" disabled>
          <Code2 />
          Run query
        </Button>
      </div>
    </div>
  );
}

function SelectShell(props: {
  icon: ComponentType<{ className?: string }>;
  value: string;
}) {
  const Icon = props.icon;

  return (
    <Select value={props.value} disabled>
      <SelectTrigger className="w-full bg-background">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={props.value}>
            <Icon className="size-4 text-muted-foreground" />
            {props.value}
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function PreviewEmptyState(props: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  const Icon = props.icon;

  return (
    <div className="grid h-full min-h-[320px] place-items-center">
      <div className="max-w-md text-center">
        <div className="mx-auto grid size-11 place-items-center rounded-md border border-border bg-muted">
          <Icon className="size-5 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-lg font-semibold tracking-normal">{props.title}</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{props.description}</p>
      </div>
    </div>
  );
}

type BranchOption = {
  value: string;
  label: string;
};

type PreviewBranch = {
  id: number;
  slug: string;
  displayName: string;
  connectionUrl: string;
};

function BackupRestoreLoadingPage(props: Readonly<{ message: string }>) {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 text-foreground">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="animate-spin" />
        {props.message}
      </div>
    </main>
  );
}

function getBranchOptions(state: ControlPlaneState) {
  return [
    {
      value: 'prod',
      label: 'prod',
    },
    ...state.branches.map(function mapBranch(branch) {
      return {
        value: branch.slug,
        label: branch.displayName,
      };
    }),
  ];
}

function getBackupOptions(backups: Array<{ label: string; type: string; completedAt: string }>) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return backups.map(function mapBackupOption(backup) {
    const date = new Date(backup.completedAt);
    return {
      value: backup.label,
      label: `${formatter.format(date)} ${backup.type} backup`,
    };
  });
}

function getBackupWindow(backups: Array<{ startedAt: string; completedAt: string }>) {
  const newest = backups[0]?.completedAt || '';
  const oldest = backups[backups.length - 1]?.startedAt || newest;

  return {
    from: formatBackupDateTime(oldest),
    to: formatBackupDateTime(newest),
  };
}

function formatBackupDateTime(value: string) {
  if (!value) {
    return 'not available';
  }

  const date = new Date(value);

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function getDefaultRestoreTime(window: { min: string | null; max: string | null }) {
  const date = new Date(Date.now() - 5 * 60 * 1000);
  const value = toDateTimeLocalValue(date);

  if (window.max && value > window.max) {
    return window.max;
  }

  if (window.min && value < window.min) {
    return window.min;
  }

  return value;
}

function getRestoreWindow(pitr: { from: string | null; to: string | null }) {
  if (pitr.from && pitr.to) {
    return {
      min: toDateTimeLocalValue(new Date(pitr.from)),
      max: toDateTimeLocalValue(new Date(pitr.to)),
    };
  }

  return {
    min: null,
    max: null,
  };
}

function toDateTimeLocalValue(date: Date) {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);

  return offsetDate.toISOString().slice(0, 16);
}

function toRestoreIso(value: string) {
  return new Date(value).toISOString();
}

function formatShortDateTime(value: string) {
  const date = new Date(value);

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatHistoricTime(value: string) {
  if (!value) {
    return 'the selected time';
  }

  const date = new Date(value);

  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}
