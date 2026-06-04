import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  GitBranch,
  Loader2,
  RotateCcw,
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
  AlertDialogTrigger,
} from '#web/components/ui/alert-dialog';
import { Badge } from '#web/components/ui/badge';
import { Button } from '#web/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#web/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#web/components/ui/dialog';
import { Input } from '#web/components/ui/input';
import { Label } from '#web/components/ui/label';
import { orpc, type ControlPlaneState } from '#web/lib/api-client';
import {
  AppSidebar,
  StatusBadge,
} from '#web/components/control-plane';
import { getMutationErrorMessage } from '#web/lib/errors';

const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
const PRODUCTION_RESTORE_CONFIRMATION = 'restore production';

export const Route = createFileRoute('/branch/$branchId/backup-restore')({
  component: BackupRestorePage,
});

function BackupRestorePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const restoreBranch = useMutation(orpc.branches.restore.mutationOptions({ onSuccess: refreshDashboard }));
  const resetBranch = useMutation(orpc.branches.reset.mutationOptions({ onSuccess: refreshDashboard }));
  const params = Route.useParams();
  const initialRestoreWindow = dashboard.data ? getRestoreWindow(dashboard.data.backupAvailability.pitr) : { min: null, max: null };
  const [restoreTime, setRestoreTime] = useState(function initialRestoreTime() {
    return getDefaultRestoreTime(initialRestoreWindow);
  });
  const [restoreTimeTouched, setRestoreTimeTouched] = useState(false);
  const [restorePromptOpen, setRestorePromptOpen] = useState(false);
  const [productionRestoreConfirmation, setProductionRestoreConfirmation] = useState('');
  const [restoreJobId, setRestoreJobId] = useState<number | null>(null);
  const restoreBusy = restoreBranch.isPending;

  useEffect(function fillRestoreDefaults() {
    if (!dashboard.data) {
      return;
    }

    const restoreWindow = getRestoreWindow(dashboard.data.backupAvailability.pitr);
    const nextRestoreTime = restoreTimeTouched
      ? clampRestoreTime(restoreTime, restoreWindow)
      : getDefaultRestoreTime(restoreWindow);

    if (nextRestoreTime !== restoreTime) {
      setRestoreTime(nextRestoreTime);
    }
  }, [dashboard.data, restoreTime, restoreTimeTouched]);

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
    return <BackupRestoreLoadingPage message={dashboard.error ? 'Could not load restore data.' : 'Loading restore data...'} />;
  }

  const state = dashboard.data;

  const isProd = branchId === 'production';
  const branch = isProd ? null : state.branches.find(function findBranch(item) {
    return item.slug === branchId;
  });
  const selectedBranch = isProd ? 'production' : branch?.slug || branchId;
  const selectedBranchLabel = isProd ? 'production' : branch?.displayName || branchId;
  const status = isProd ? (state.prodConnectionUrl ? 'ready' : 'pending') : branch?.status || 'missing';
  const restoreWindow = getRestoreWindow(state.backupAvailability.pitr);
  const pitrAvailable = state.backupAvailability.status === 'ok' && Boolean(restoreWindow.min && restoreWindow.max);
  const restoreTimeValid = pitrAvailable && isRestoreTimeInWindow(restoreTime, restoreWindow);
  const sourceBranch = 'production';
  const restoreHistory = getRestoreHistory(state.jobs, selectedBranch);

  async function handleResetDevelopmentBranch() {
    if (!branch) {
      return;
    }

    try {
      await resetBranch.mutateAsync({ slug: branch.slug });
      toast.success(`Reset ${selectedBranchLabel}.`);
      await navigate({ to: '/branch/$branchId/overview', params: { branchId: branch.slug } });
    } catch (error: any) {
      toast.error(getMutationErrorMessage(error, 'Could not reset branch.'));
    }
  }

  function updateRestoreTime(value: string) {
    setRestoreTimeTouched(true);
    setRestoreTime(value);
  }

  function selectLatestRestoreTime() {
    if (!restoreWindow.max) {
      return;
    }

    setRestoreTimeTouched(false);
    setRestoreTime(restoreWindow.max);
  }

  function handleOpenRestorePrompt() {
    setProductionRestoreConfirmation('');
    setRestorePromptOpen(true);
  }

  async function handleRestore() {
    try {
      const job = await restoreBranch.mutateAsync({
        targetBranch: selectedBranch,
        sourceBranch,
        restoreTime: toRestoreIso(restoreTime),
        productionRestoreConfirmation,
      });
      setRestoreJobId(job.id);
      setRestorePromptOpen(false);
      setProductionRestoreConfirmation('');
      toast.loading(`Restoring ${selectedBranchLabel}.`, { id: `restore-${job.id}` });

      await refreshDashboard();
    } catch (error: any) {
      toast.error(getMutationErrorMessage(error, 'Could not start restore'));
    }
  }

  if (!isProd) {
    return (
      <RestoreUnavailablePage
        branchExists={Boolean(branch)}
        branchLabel={selectedBranchLabel}
        branchSlug={selectedBranch}
        branches={state.branches}
        resetBusy={resetBranch.isPending}
        status={status}
        onReset={function resetDevelopmentBranch() {
          void handleResetDevelopmentBranch();
        }}
      />
    );
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen flex-col lg:grid lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeBranchPage="backup" selectedBranch={selectedBranch} />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[840px] gap-5 px-4 py-6 sm:px-6 lg:px-8">
            <header>
              <div className="flex items-center gap-2">
                <Badge variant="outline">Production</Badge>
                <StatusBadge status={status} />
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">Restore production</h1>
              <div className="mt-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <GitBranch className="size-4" />
                <span>{selectedBranchLabel}</span>
              </div>
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
              <CardContent className="grid gap-5">
                <div className="grid gap-2">
                  <Label htmlFor="restore-time">Date and time</Label>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <Input
                      id="restore-time"
                      className="h-10 font-mono"
                      type="datetime-local"
                      step={1}
                      min={restoreWindow.min || undefined}
                      max={restoreWindow.max || undefined}
                      value={restoreTime}
                      disabled={!pitrAvailable}
                      onChange={function changeRestoreTime(event) {
                        updateRestoreTime(event.target.value);
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10"
                      disabled={!restoreWindow.max || restoreLocked}
                      onClick={selectLatestRestoreTime}
                    >
                      Use latest
                    </Button>
                  </div>
                  <RestoreAvailability
                    available={pitrAvailable}
                    message={state.backupAvailability.message}
                    restoreTimeValid={restoreTimeValid}
                    restoreWindow={restoreWindow}
                  />
                </div>

                <div className="flex justify-end border-t border-border pt-5">
                  <Button
                    type="button"
                    disabled={!restoreTimeValid || restoreLocked}
                    onClick={function restoreClick() {
                      handleOpenRestorePrompt();
                    }}
                  >
                    {restoreLocked ? 'Restore running' : 'Restore production'}
                  </Button>
                </div>

              </CardContent>
            </Card>

            <RestoreHistoryPanel jobs={restoreHistory} selectedBranch={selectedBranchLabel} />
          </div>
        </section>
      </div>

      <RestorePromptModal
        open={restorePromptOpen}
        restoreTime={restoreTime}
        confirmation={productionRestoreConfirmation}
        restoreBusy={restoreBusy}
        onOpenChange={function changeRestorePromptOpen(open) {
          setRestorePromptOpen(open);
        }}
        onConfirmationChange={setProductionRestoreConfirmation}
        onRestore={function confirmRestore() {
          void handleRestore();
        }}
      />
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

function RestoreUnavailablePage(props: {
  branchExists: boolean;
  branchLabel: string;
  branchSlug: string;
  branches: ControlPlaneState['branches'];
  resetBusy: boolean;
  status: string;
  onReset: () => void;
}) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen flex-col lg:grid lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={props.branches} selectedBranch={props.branchSlug} />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[760px] gap-5 px-4 py-6 sm:px-6 lg:px-8">
            <header>
              <div className="flex items-center gap-2">
                <Badge variant="outline">Development</Badge>
                <StatusBadge status={props.status} />
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">Restore</h1>
              <div className="mt-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <GitBranch className="size-4" />
                <span>{props.branchLabel}</span>
              </div>
            </header>

            <Card>
              <CardHeader>
                <div className="flex gap-4">
                  <div className="mt-1 grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                    <RotateCcw className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <CardTitle>Restore is production-only</CardTitle>
                    <CardDescription className="mt-2 max-w-xl">
                      Velo keeps restore history for production. Dev branches can be reset from their parent.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center">
                <Button asChild type="button">
                  <Link to="/branch/$branchId/backup-restore" params={{ branchId: 'production' }}>
                    Open production restore
                  </Link>
                </Button>
                {props.branchExists ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button type="button" variant="outline" disabled={props.resetBusy}>
                        {props.resetBusy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                        {props.resetBusy ? 'Resetting' : 'Reset from parent'}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Reset {props.branchLabel}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This replaces the branch with its parent current state. Current branch data will be removed.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={props.onReset}>
                          Reset branch
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </section>
      </div>
    </main>
  );
}

function RestoreAvailability(props: {
  available: boolean;
  message: string | null;
  restoreTimeValid: boolean;
  restoreWindow: { min: string | null; max: string | null };
}) {
  if (!props.available || !props.restoreWindow.min || !props.restoreWindow.max) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="warning">Not ready</Badge>
        <span>{props.message || 'Restore history is not ready yet.'}</span>
      </div>
    );
  }

  return (
    <div className="grid gap-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        {!props.restoreTimeValid ? <Badge variant="warning">Exact restore not available</Badge> : null}
        <span>
          Valid from {formatDisplayDateTime(props.restoreWindow.min)} to {formatDisplayDateTime(props.restoreWindow.max)}.
        </span>
      </div>
      <LocalTimeZoneLabel />
    </div>
  );
}

function LocalTimeZoneLabel() {
  return (
    <div>
      Times are local to <span className="font-medium text-foreground">{LOCAL_TIME_ZONE}</span>.
    </div>
  );
}

function RestoreHistoryPanel(props: {
  jobs: RestoreJob[];
  selectedBranch: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Recent restores</CardTitle>
      </CardHeader>
      <CardContent>
        {props.jobs.length ? (
          <div className="grid gap-2">
            {props.jobs.map(function renderRestoreHistory(job) {
              const input = getRestoreInput(job);

              return (
                <div key={job.id} className="grid gap-2 rounded-md border border-border p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center">
                  <div>
                    <p className="font-medium">{input?.restoreTime ? formatDisplayDateTime(input.restoreTime) : 'time unavailable'}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {input?.targetBranch || props.selectedBranch} · job #{job.id} · {formatDisplayDateTime(job.createdAt)}
                    </p>
                    {job.error ? (
                      <p className="mt-2 line-clamp-2 text-xs text-destructive">{job.error}</p>
                    ) : null}
                  </div>
                  <StatusBadge status={job.status} />
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No restore jobs yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryItem(props: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{props.label}</p>
      <p className="mt-1 font-medium text-foreground">{props.value}</p>
    </div>
  );
}

function RestorePromptModal(props: {
  open: boolean;
  restoreTime: string;
  confirmation: string;
  restoreBusy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmationChange: (value: string) => void;
  onRestore: () => void;
}) {
  const restoreDisabled = props.restoreBusy
    || props.confirmation !== PRODUCTION_RESTORE_CONFIRMATION;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Confirm restore production</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 rounded-md border border-border bg-muted/20 p-4 text-sm">
          <SummaryItem label="Selected time" value={`${formatDisplayDateTime(props.restoreTime)} (${LOCAL_TIME_ZONE})`} />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="production-restore-confirmation">
            Type <ConfirmationCode value={PRODUCTION_RESTORE_CONFIRMATION} />
          </Label>
          <Input
            id="production-restore-confirmation"
            aria-label="Production restore confirmation"
            value={props.confirmation}
            autoComplete="off"
            onChange={function changeConfirmation(event) {
              props.onConfirmationChange(event.target.value);
            }}
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={function closeRestorePrompt() {
            props.onOpenChange(false);
          }}>
            Cancel
          </Button>
          <Button
            type="button"
            autoFocus
            data-default-action=""
            disabled={restoreDisabled}
            onClick={props.onRestore}
          >
            {props.restoreBusy ? <Loader2 className="animate-spin" /> : null}
            Restore production
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmationCode(props: { value: string }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{props.value}</code>;
}

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

function getRestoreHistory(jobs: RestoreJob[], selectedBranch: string): RestoreJob[] {
  return jobs.filter(function isSelectedRestoreJob(job) {
    const input = getRestoreInput(job);

    return job.type === 'restore-branch' && input?.targetBranch === selectedBranch;
  }).slice(0, 3);
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

function getDefaultRestoreTime(window: { min: string | null; max: string | null }) {
  if (window.max) {
    return window.max;
  }

  return toDateTimeLocalValue(new Date(Date.now() - 5 * 60 * 1000));
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

function toReadableLocalDateTime(date: Date) {
  return toDateTimeLocalValue(date).replace('T', ' ');
}
