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
import { toast } from 'sonner';
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

const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
const TIME_FORMAT_LABEL = `Times are local to ${LOCAL_TIME_ZONE}.`;

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
  const [restorePoint, setRestorePoint] = useState('latest');
  const [customRestoreTime, setCustomRestoreTime] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBranch, setPreviewBranch] = useState<PreviewBranch | null>(null);
  const [restorePromptOpen, setRestorePromptOpen] = useState(false);
  const [restoreJobId, setRestoreJobId] = useState<number | null>(null);
  const previewBusy = createPreviewBranch.isPending || deletePreviewBranch.isPending;
  const restoreBusy = restoreBranch.isPending;

  useEffect(function fillRestoreDefaults() {
    if (!dashboard.data) {
      return;
    }

    if (!backupPoint) {
      setBackupPoint(getBackupOptions(dashboard.data.backupAvailability.backups)[0]?.value || '');
    }

    const restoreWindow = getRestoreWindow(dashboard.data.backupAvailability.pitr);
    const nextRestoreTime = restorePoint === 'latest' && restoreWindow.max
      ? restoreWindow.max
      : clampRestoreTime(restoreTime, restoreWindow);

    if (nextRestoreTime !== restoreTime) {
      setRestoreTime(nextRestoreTime);
    }
  }, [backupPoint, dashboard.data, restorePoint, restoreTime]);

  async function refreshDashboard() {
    await queryClient.invalidateQueries({ queryKey: orpc.dashboard.retrieve.key() });
  }

  const branchId = params.branchId;
  const selectedBranchForJobs = getSelectedBranchForJobs(dashboard.data, branchId);
  const restoreJob = dashboard.data ? getRestoreJob(dashboard.data.jobs, selectedBranchForJobs, restoreJobId) : null;
  const restoreJobActive = Boolean(restoreJob && (restoreJob.status === 'queued' || restoreJob.status === 'running'));
  const restoreLocked = restoreBusy || restoreJobActive;

  useEffect(function pollRestoreJob() {
    if (!restoreLocked) {
      return;
    }

    const interval = window.setInterval(function refreshRestoreJob() {
      void dashboard.refetch();
    }, 2000);

    return function clearPoll() {
      window.clearInterval(interval);
    };
  }, [dashboard, restoreLocked]);

  useEffect(function watchRestoreJob() {
    if (!restoreJob || restoreJob.status === 'queued' || restoreJob.status === 'running') {
      return;
    }

    if (restoreJob.status === 'done') {
      toast.success('Restore complete.', { id: `restore-${restoreJob.id}` });
      setRestoreJobId(null);
      return;
    }

    toast.error(restoreJob.error || getLastErrorLog(restoreJob) || 'Restore failed.', { id: `restore-${restoreJob.id}` });
  }, [restoreJob]);

  if (!dashboard.data) {
    return <BackupRestoreLoadingPage message={dashboard.error ? 'Could not load backup data.' : 'Loading backup data...'} />;
  }

  const state = dashboard.data;

  const isProd = branchId === 'production';
  const branch = isProd ? null : state.branches.find(function findBranch(item) {
    return item.slug === branchId;
  });
  const selectedBranch = isProd ? 'production' : branch?.slug || branchId;
  const selectedBranchLabel = isProd ? 'production' : branch?.displayName || branchId;
  const status = isProd ? (state.prodConnectionUrl ? 'ready' : 'pending') : branch?.status || 'missing';
  const branchOptions = getBranchOptions(state);
  const backupOptions = getBackupOptions(state.backupAvailability.backups);
  const restoreWindow = getRestoreWindow(state.backupAvailability.pitr);
  const backupWindow = getBackupWindow(state.backupAvailability.backups);
  const pitrAvailable = state.backupAvailability.status === 'ok' && Boolean(restoreWindow.min && restoreWindow.max);
  const restorePointOptions = getRestorePointOptions(restoreWindow);
  const restoreTimeValid = pitrAvailable && isRestoreTimeInWindow(restoreTime, restoreWindow);
  const sourceBranch = 'production';

  function selectRestorePoint(value: string) {
    setRestorePoint(value);

    if (value === 'custom') {
      setCustomRestoreTime(restoreTime);
      return;
    }

    const option = restorePointOptions.find(function findOption(item) {
      return item.value === value;
    });

    if (option) {
      setRestoreTime(option.restoreTime);
    }
  }

  function updateCustomRestoreTime(value: string) {
    setCustomRestoreTime(value);

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return;
    }

    const normalized = toDateTimeLocalValue(date);

    if (isRestoreTimeInWindow(normalized, restoreWindow)) {
      setRestoreTime(normalized);
    }
  }

  async function handleOpenPreview() {
    try {
      const created = await createPreviewBranch.mutateAsync({
        sourceBranch,
        restoreTime: toRestoreIso(restoreTime),
      });
      setPreviewBranch(created);
      setPreviewOpen(true);
    } catch (error: any) {
      toast.error(error?.message || 'Could not create preview branch');
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
      toast.error(error?.message || `Could not delete preview branch ${branchToDelete.displayName}`);
    }
  }

  async function handleRestore() {
    try {
      const job = await restoreBranch.mutateAsync({
        targetBranch: selectedBranch,
        sourceBranch,
        restoreTime: toRestoreIso(restoreTime),
      });
      setRestoreJobId(job.id);
      setRestorePromptOpen(false);
      setPreviewOpen(false);
      toast.loading(`Restoring ${selectedBranchLabel}.`, { id: `restore-${job.id}` });
      await refreshDashboard();
    } catch (error: any) {
      toast.error(error?.message || 'Could not start restore');
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen flex-col lg:grid lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeBranchPage="backup" selectedBranch={selectedBranch} />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[980px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
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

            {restoreJob ? (
              <RestoreProgressPanel
                job={restoreJob}
                targetBranch={selectedBranchLabel}
                sourceBranch={sourceBranch}
                restoreTime={getRestoreInput(restoreJob)?.restoreTime || toRestoreIso(restoreTime)}
              />
            ) : null}

            <Card>
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
                <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
                  <div className="grid gap-2">
                    <Label>Source branch</Label>
                    <div className="flex h-10 items-center rounded-md border border-input bg-background px-3 text-sm font-medium">
                      production
                    </div>
                    <div className="text-xs text-muted-foreground">PITR uses production WAL history for any target branch.</div>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="restore-point">Restore point</Label>
                    <Select value={restorePoint} onValueChange={selectRestorePoint} disabled={!pitrAvailable}>
                      <SelectTrigger id="restore-point" className="h-10 w-full bg-background [&_[data-slot=select-value]]:truncate">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {restorePointOptions.map(function renderRestorePoint(option) {
                          return (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          );
                        })}
                        <SelectItem value="custom">Custom ISO time</SelectItem>
                      </SelectContent>
                    </Select>
                    {restorePoint === 'custom' ? (
                      <div className="relative">
                        <Calendar className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          aria-label="Custom restore time"
                          className="h-10 pl-9 font-mono"
                          placeholder={formatIsoInputPlaceholder(restoreTime)}
                          value={customRestoreTime}
                          disabled={!pitrAvailable}
                          onChange={function changeCustomRestoreTime(event) {
                            updateCustomRestoreTime(event.target.value);
                          }}
                        />
                      </div>
                    ) : null}
                    <div className="text-xs text-muted-foreground">{pitrAvailable ? TIME_FORMAT_LABEL : state.backupAvailability.message || 'PITR is not available yet.'}</div>
                  </div>
                </div>

                <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
                  <p className="max-w-xl text-xs leading-5 text-muted-foreground">
                    Preview creates a temporary read-only restore branch for the selected time. Production and dev branches stay untouched.
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!restoreTimeValid || previewBusy || restoreLocked}
                      onClick={function previewDataClick() {
                        void handleOpenPreview();
                      }}
                    >
                      {previewBusy ? <Loader2 className="animate-spin" /> : <Search />}
                      {previewBusy ? 'Creating preview' : 'Preview data'}
                    </Button>
                    <Button
                      type="button"
                      disabled={!restoreTimeValid || previewBusy || restoreLocked}
                      onClick={function restoreClick() {
                        setRestorePromptOpen(true);
                      }}
                    >
                      {restoreLocked ? 'Restore running' : 'Restore to point in time'}
                    </Button>
                  </div>
                </div>

              </CardContent>
            </Card>

            <Card>
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
                <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
                  <div className="grid gap-2">
                    <Label>Source branch</Label>
                    <div className="flex h-10 items-center rounded-md border border-input bg-background px-3 text-sm font-medium">
                      production
                    </div>
                    <div className="min-h-8 text-xs text-muted-foreground">Daily backups are taken only from production.</div>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="backup-point">Backup</Label>
                    <Select value={backupPoint} onValueChange={setBackupPoint} disabled={!backupOptions.length}>
                      <SelectTrigger id="backup-point" className="h-10 w-full bg-background font-medium [&_[data-slot=select-value]]:truncate">
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
                    <div className="min-h-8 text-xs text-muted-foreground">
                      {backupOptions.length
                        ? `Available from ${backupWindow.from} to ${backupWindow.to}. Daily restore points are less precise than PITR.`
                        : 'No production full backups found yet.'}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
                  <p className="max-w-xl text-xs leading-5 text-muted-foreground">
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

function RestoreProgressPanel(props: {
  job: RestoreJob;
  targetBranch: string;
  sourceBranch: string;
  restoreTime: string;
}) {
  const isActive = props.job.status === 'queued' || props.job.status === 'running';
  const error = props.job.error || getLastErrorLog(props.job);

  return (
    <Card className={isActive ? 'border-blue-500/40 bg-blue-500/10' : undefined}>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>{isActive ? 'Restore in progress' : 'Restore result'}</CardTitle>
            <CardDescription>
              {props.targetBranch} from {props.sourceBranch} at {formatDisplayDateTime(props.restoreTime)}
            </CardDescription>
          </div>
          <StatusBadge status={props.job.status} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {isActive ? (
          <div className="flex items-start gap-3 rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 text-sm">
            <Loader2 className="mt-0.5 size-4 animate-spin text-blue-300" />
            <div>
              <p className="font-medium">Branch is locked while restore runs.</p>
              <p className="mt-1 text-xs text-muted-foreground">Avoid writes until this completes.</p>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <p className="font-medium">Restore failed</p>
            <p className="mt-2 whitespace-pre-wrap font-mono text-xs leading-5">{error}</p>
          </div>
        ) : null}

        {props.job.logs.length > 0 ? (
          <div className="grid gap-2 rounded-lg border border-border bg-muted/20 p-3">
            <p className="text-xs font-medium text-muted-foreground">Progress log</p>
            <div className="grid gap-1">
              {props.job.logs.slice(0, 5).map(function renderLog(log) {
                return (
                  <code
                    className={log.level === 'error' ? 'whitespace-pre-wrap text-xs leading-5 text-destructive' : 'whitespace-pre-wrap text-xs leading-5 text-muted-foreground'}
                    key={log.id}
                  >
                    {log.message}
                  </code>
                );
              })}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RestorePromptModal(props: {
  branch: string;
  sourceBranch: string;
  restoreTime: string;
  previewBusy: boolean;
  restoreBusy: boolean;
  onClose: () => void;
  onRestore: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-md border border-border bg-card p-5 text-card-foreground shadow-xl">
        <div className="flex gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-md bg-amber-500/10 text-amber-300">
            <AlertTriangle className="size-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-normal">Restore branch</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              You are about to restore {props.branch} from {props.sourceBranch} at {formatDisplayDateTime(props.restoreTime)}.
              This replaces the current branch data with the selected point in time.
            </p>
          </div>
        </div>

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
  const historicTime = formatDisplayDateTime(props.restoreTime);

  return (
    <div className="fixed inset-0 z-50 bg-background/80 p-3 backdrop-blur-sm">
      <div className="grid h-full grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-md border border-border bg-card text-card-foreground shadow-xl">
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
                <div className="mt-1 text-xs text-muted-foreground">{TIME_FORMAT_LABEL}</div>
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

type RestoreJob = ControlPlaneState['jobs'][number];

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
      value: 'production',
      label: 'production',
    },
    ...state.branches.map(function mapBranch(branch) {
      return {
        value: branch.slug,
        label: branch.displayName,
      };
    }),
  ];
}

function getSelectedBranchForJobs(state: ControlPlaneState | undefined, branchId: string): string {
  if (branchId === 'production') {
    return 'production';
  }

  const branch = state?.branches.find(function findBranch(item) {
    return item.slug === branchId;
  });

  return branch?.slug || branchId;
}

function getRestoreJob(jobs: RestoreJob[], selectedBranch: string, restoreJobId: number | null): RestoreJob | null {
  const tracked = restoreJobId ? jobs.find(function findTrackedJob(job) {
    return job.id === restoreJobId;
  }) : null;

  if (tracked) {
    return tracked;
  }

  return jobs.find(function findRestoreJob(job) {
    const input = getRestoreInput(job);

    return job.type === 'restore-branch'
      && input?.targetBranch === selectedBranch
      && (job.status === 'queued' || job.status === 'running');
  }) || null;
}

function getRestoreInput(job: RestoreJob): { targetBranch: string; sourceBranch: string; restoreTime: string } | null {
  if (!job.input || typeof job.input !== 'object') {
    return null;
  }

  const input = job.input as Record<string, unknown>;

  if (typeof input.targetBranch !== 'string' || typeof input.sourceBranch !== 'string' || typeof input.restoreTime !== 'string') {
    return null;
  }

  return {
    targetBranch: input.targetBranch,
    sourceBranch: input.sourceBranch,
    restoreTime: input.restoreTime,
  };
}

function getLastErrorLog(job: RestoreJob): string | null {
  const log = job.logs.find(function findErrorLog(item) {
    return item.level === 'error';
  });

  return log?.message || null;
}

function getBackupOptions(backups: Array<{ label: string; type: string; completedAt: string }>) {
  return backups.map(function mapBackupOption(backup) {
    return {
      value: backup.label,
      label: `${formatDisplayDateTime(backup.completedAt)} ${backup.type} backup`,
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

function getRestorePointOptions(window: { min: string | null; max: string | null }) {
  if (!window.min || !window.max) {
    return [];
  }

  const candidates = [
    {
      value: 'latest',
      restoreTime: window.max,
      labelPrefix: 'Latest available',
    },
    {
      value: 'minus-1m',
      restoreTime: toDateTimeLocalValue(new Date(Date.now() - 60 * 1000)),
      labelPrefix: '1 minute ago',
    },
    {
      value: 'minus-5m',
      restoreTime: toDateTimeLocalValue(new Date(Date.now() - 5 * 60 * 1000)),
      labelPrefix: '5 minutes ago',
    },
    {
      value: 'minus-15m',
      restoreTime: toDateTimeLocalValue(new Date(Date.now() - 15 * 60 * 1000)),
      labelPrefix: '15 minutes ago',
    },
    {
      value: 'minus-30m',
      restoreTime: toDateTimeLocalValue(new Date(Date.now() - 30 * 60 * 1000)),
      labelPrefix: '30 minutes ago',
    },
    {
      value: 'earliest',
      restoreTime: window.min,
      labelPrefix: 'Earliest available',
    },
  ];
  const options: RestorePointOption[] = [];

  candidates.forEach(function addCandidate(candidate) {
    if (!isRestoreTimeInWindow(candidate.restoreTime, window)) {
      return;
    }

    if (options.some(function hasSameTime(option) {
      return option.restoreTime === candidate.restoreTime;
    })) {
      return;
    }

    options.push({
      value: candidate.value,
      restoreTime: candidate.restoreTime,
      label: formatRestorePointOptionLabel(candidate.labelPrefix, candidate.restoreTime),
    });
  });

  return options;
}

function formatRestorePointOptionLabel(prefix: string, value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return `${prefix} · ${value}`;
  }

  return `${prefix} (${formatRelativeTime(date)}) · ${formatDisplayDateTime(value)}`;
}

function formatBackupDateTime(value: string) {
  if (!value) {
    return 'not available';
  }

  return formatDisplayDateTime(value);
}

function getDefaultRestoreTime(window: { min: string | null; max: string | null }) {
  const date = new Date(Date.now() - 5 * 60 * 1000);
  const value = toDateTimeLocalValue(date);

  return clampRestoreTime(value, window);
}

function clampRestoreTime(value: string, window: { min: string | null; max: string | null }) {
  if (!window.min || !window.max) {
    return value || toDateTimeLocalValue(new Date(Date.now() - 5 * 60 * 1000));
  }

  if (!value) {
    return window.max;
  }

  if (window.max && value > window.max) {
    return window.max;
  }

  if (window.min && value < window.min) {
    return window.min;
  }

  return value;
}

function isRestoreTimeInWindow(value: string, window: { min: string | null; max: string | null }) {
  if (!value || !window.min || !window.max) {
    return false;
  }

  return value >= window.min && value <= window.max;
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

  return offsetDate.toISOString().slice(0, 19);
}

function toRestoreIso(value: string) {
  return new Date(value).toISOString();
}

function formatDisplayDateTime(value: string) {
  if (!value) {
    return 'the selected time';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return toReadableLocalDateTime(date);
}

function formatRestorePointDetail(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${formatRelativeTime(date)} · ${formatDisplayDateTime(value)}`;
}

function formatIsoInputPlaceholder(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '2026-05-16T14:25:15+02:00';
  }

  return toLocalIsoString(date);
}

function toReadableLocalDateTime(date: Date) {
  return toDateTimeLocalValue(date).replace('T', ' ');
}

function toLocalIsoString(date: Date) {
  return `${toDateTimeLocalValue(date)}${getLocalOffset(date)}`;
}

function getLocalOffset(date: Date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const minutes = String(absOffset % 60).padStart(2, '0');

  return `${sign}${hours}:${minutes}`;
}

function formatRelativeTime(date: Date) {
  const diffMs = Date.now() - date.getTime();
  const absSeconds = Math.max(0, Math.round(Math.abs(diffMs) / 1000));

  if (absSeconds < 60) {
    return diffMs >= 0 ? `${absSeconds}s ago` : `in ${absSeconds}s`;
  }

  const minutes = Math.round(absSeconds / 60);

  if (minutes < 60) {
    return diffMs >= 0 ? `${minutes}m ago` : `in ${minutes}m`;
  }

  const hours = Math.round(minutes / 60);

  return diffMs >= 0 ? `${hours}h ago` : `in ${hours}h`;
}

interface RestorePointOption {
  value: string;
  restoreTime: string;
  label: string;
}
