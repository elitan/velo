import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, ArchiveRestore, CheckCircle2, Database, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
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
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#web/components/ui/card';
import { Checkbox } from '#web/components/ui/checkbox';
import { Label } from '#web/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#web/components/ui/select';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '#web/components/ui/tabs';
import { api, orpc } from '#web/lib/api-client';
import {
  AppSidebar,
  BackupPanel,
  JobsPanel,
  ServerPanel,
  StatusBadge,
  type ServerRole,
} from '#web/components/control-plane';

const JOB_PAGE_SIZE = 20;
type JobStatusFilter = 'all' | 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const queryClient = useQueryClient();
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const [settingsTab, setSettingsTab] = useState('overview');
  const [jobStatus, setJobStatus] = useState<JobStatusFilter>('all');
  const [jobPage, setJobPage] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const saveServer = useMutation(orpc.servers.update.mutationOptions({ onSuccess: refreshDashboard }));
  const checkServer = useMutation(orpc.servers.check.mutationOptions({ onSuccess: refreshDashboard }));
  const saveBackupSettings = useMutation(orpc.backup.settings.update.mutationOptions({ onSuccess: refreshDashboard }));
  const jobList = useQuery({
    queryKey: ['settings-jobs', jobStatus, jobPage],
    queryFn: function listSettingsJobs() {
      return api.jobs.list({
        limit: JOB_PAGE_SIZE,
        offset: jobPage * JOB_PAGE_SIZE,
        status: getJobStatusQuery(jobStatus),
      });
    },
  });
  const selectedJob = useQuery({
    queryKey: ['settings-job', selectedJobId],
    enabled: selectedJobId !== null,
    queryFn: function retrieveSelectedJob() {
      if (!selectedJobId) {
        throw new Error('Missing job id');
      }

      return api.jobs.retrieve({ id: selectedJobId });
    },
  });
  const retryJob = useMutation({
    mutationFn: function retryJobMutation(id: number) {
      return api.jobs.retry({ id });
    },
    onSuccess: refreshJobs,
  });
  const cancelJob = useMutation({
    mutationFn: function cancelJobMutation(id: number) {
      return api.jobs.cancel({ id });
    },
    onSuccess: refreshJobs,
  });
  const busy = getBusyKey();
  const activeJobs = dashboard.data?.jobs.filter(function isActive(job) {
    return isActiveJobStatus(job.status);
  }).length ?? 0;

  useEffect(function pollActiveJobs() {
    if (activeJobs === 0) {
      return;
    }

    const interval = window.setInterval(function refreshActiveJobs() {
      void dashboard.refetch();
      void queryClient.invalidateQueries({ queryKey: ['settings-jobs'] });
    }, 2000);

    return function clearPoll() {
      window.clearInterval(interval);
    };
  }, [activeJobs, dashboard]);

  async function refreshDashboard() {
    await queryClient.invalidateQueries({ queryKey: orpc.dashboard.retrieve.key() });
  }

  async function refreshJobs() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.dashboard.retrieve.key() }),
      queryClient.invalidateQueries({ queryKey: ['settings-jobs'] }),
      queryClient.invalidateQueries({ queryKey: ['settings-job', selectedJobId] }),
    ]);
  }

  function getBusyKey(): string | null {
    if (saveServer.isPending) {
      return `save-${saveServer.variables?.role || 'production'}`;
    }

    if (checkServer.isPending) {
      return `check-${checkServer.variables?.role || 'production'}`;
    }

    if (saveBackupSettings.isPending) {
      return 'save-backup';
    }

    return null;
  }

  function getBusyJobId(): number | null {
    if (retryJob.isPending) {
      return retryJob.variables ?? null;
    }

    if (cancelJob.isPending) {
      return cancelJob.variables ?? null;
    }

    return null;
  }

  if (!dashboard.data) {
    return <SettingsLoadingPage message={dashboard.error ? 'Could not load settings.' : 'Loading settings...'} />;
  }

  const state = dashboard.data;

  const prodServer = state.servers.find(function findProd(server) {
    return server.role === 'prod';
  });
  const devServer = state.servers.find(function findDev(server) {
    return server.role === 'dev';
  });
  const okServers = state.servers.filter(function countOk(server) {
    return server.status === 'ok';
  }).length;
  const backupMode = state.backup.enabled ? 'S3/R2' : 'local';
  const lastJob = state.jobs[0] || null;

  async function handleSave(formData: FormData) {
    const role = formData.get('role') === 'prod' ? 'prod' : 'dev';
    try {
      await saveServer.mutateAsync({
        role,
        host: String(formData.get('host') || ''),
        sshUser: String(formData.get('sshUser') || ''),
        sshKeyPath: String(formData.get('sshKeyPath') || ''),
        allowedCidr: role === 'prod' ? String(formData.get('allowedCidr') || '') : undefined,
      });
      toast.success(`${role === 'prod' ? 'Production' : 'Development'} server saved.`);
    } catch (error: any) {
      toast.error(error?.message || 'Could not save server.');
    }
  }

  async function handleCheck(role: ServerRole) {
    try {
      await checkServer.mutateAsync({ role });
      toast.success(`${role === 'prod' ? 'Production' : 'Development'} server checked.`);
    } catch (error: any) {
      toast.error(error?.message || 'Could not check server.');
    }
  }

  async function handleSaveBackup(formData: FormData) {
    try {
      await saveBackupSettings.mutateAsync({
        enabled: formData.get('enabled') === 'on',
        endpoint: String(formData.get('endpoint') || ''),
        bucket: String(formData.get('bucket') || ''),
        region: String(formData.get('region') || 'auto'),
        accessKeyId: String(formData.get('accessKeyId') || ''),
        secretAccessKey: String(formData.get('secretAccessKey') || ''),
        path: String(formData.get('path') || '/prod'),
        pitrDays: Number(formData.get('pitrDays') || 7),
        fullBackupRetentionDays: Number(formData.get('fullBackupRetentionDays') || 90),
      });
      toast.success('Backup settings saved.');
    } catch (error: any) {
      toast.error(error?.message || 'Could not save backup settings.');
    }
  }

  function handleJobStatusChange(status: string) {
    if (!isJobStatusFilter(status)) {
      return;
    }

    setJobStatus(status);
    setJobPage(0);
  }

  function openJob(jobId: number) {
    setSettingsTab('jobs');
    setSelectedJobId(jobId);
  }

  async function handleRetryJob(jobId: number) {
    try {
      await retryJob.mutateAsync(jobId);
      toast.success('Job queued.');
    } catch (error: any) {
      toast.error(error?.message || 'Could not retry job.');
    }
  }

  async function handleCancelJob(jobId: number) {
    try {
      await cancelJob.mutateAsync(jobId);
      toast.success('Job cancelled.');
    } catch (error: any) {
      toast.error(error?.message || 'Could not cancel job.');
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen flex-col lg:grid lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeProject="settings" />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[980px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <h1 className="text-3xl font-semibold tracking-normal md:text-4xl">Settings</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Manage server access, backup storage, and background activity.
                </p>
              </div>
              <Button variant="outline" onClick={function refreshPage() { void dashboard.refetch(); }}>
                <RefreshCw />
                Refresh
              </Button>
            </header>

            <Tabs value={settingsTab} onValueChange={setSettingsTab} orientation="vertical" className="grid gap-6 lg:grid-cols-[180px_minmax(0,1fr)]">
              <TabsList variant="line" className="w-full items-stretch justify-start">
                <TabsTrigger className="pl-3 data-active:text-muted-foreground data-active:after:left-0 data-active:after:right-auto" value="overview">
                  <Activity />
                  Overview
                </TabsTrigger>
                <TabsTrigger className="pl-3 data-active:text-muted-foreground data-active:after:left-0 data-active:after:right-auto" value="servers">
                  <Database />
                  Servers
                </TabsTrigger>
                <TabsTrigger className="pl-3 data-active:text-muted-foreground data-active:after:left-0 data-active:after:right-auto" value="backups">
                  <ArchiveRestore />
                  Backups
                </TabsTrigger>
                <TabsTrigger className="pl-3 data-active:text-muted-foreground data-active:after:left-0 data-active:after:right-auto" value="updates">
                  <RefreshCw />
                  Updates
                </TabsTrigger>
                <TabsTrigger className="pl-3 data-active:text-muted-foreground data-active:after:left-0 data-active:after:right-auto" value="jobs">
                  <Activity />
                  Jobs
                </TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="min-w-0">
                <div className="grid gap-6">
                  <SettingsOverview
                    okServers={okServers}
                    serverCount={state.servers.length}
                    backupMode={backupMode}
                    backupDetail={state.backup.bucket || 'not configured'}
                    activeJobs={activeJobs}
                    lastJob={lastJob}
                  />
                  <SetupStepsPanel steps={state.setupSteps} onOpenJob={openJob} />
                </div>
              </TabsContent>

              <TabsContent value="servers" className="min-w-0">
                <div className="grid gap-6 lg:grid-cols-2">
                  <ServerPanel title="Production" role="prod" server={prodServer} allowedCidr={state.prodAllowedCidr || ''} busy={busy} onSave={handleSave} onCheck={handleCheck} />
                  <ServerPanel title="Development" role="dev" server={devServer} busy={busy} onSave={handleSave} onCheck={handleCheck} />
                </div>
              </TabsContent>

              <TabsContent value="backups" className="min-w-0">
                <BackupPanel backup={state.backup} busy={busy === 'save-backup'} onSave={handleSaveBackup} />
              </TabsContent>

              <TabsContent value="updates" className="min-w-0">
                <UpdatePanel />
              </TabsContent>

              <TabsContent value="jobs" className="min-w-0">
                <JobsPanel
                  jobs={jobList.data || state.jobs}
                  activeJobs={activeJobs}
                  loading={jobList.isLoading}
                  statusFilter={jobStatus}
                  onStatusFilterChange={handleJobStatusChange}
                  page={jobPage}
                  hasMore={(jobList.data?.length || 0) === JOB_PAGE_SIZE}
                  onPreviousPage={function previousJobPage() {
                    setJobPage(Math.max(0, jobPage - 1));
                  }}
                  onNextPage={function nextJobPage() {
                    setJobPage(jobPage + 1);
                  }}
                  selectedJob={selectedJob.data || null}
                  selectedJobOpen={selectedJobId !== null}
                  selectedJobLoading={selectedJob.isLoading}
                  busyJobId={getBusyJobId()}
                  onOpenJob={setSelectedJobId}
                  onCloseJob={function closeJob() {
                    setSelectedJobId(null);
                  }}
                  onRetry={handleRetryJob}
                  onCancel={handleCancelJob}
                />
              </TabsContent>
            </Tabs>
          </div>
        </section>
      </div>
    </main>
  );
}

function getJobStatusQuery(status: JobStatusFilter): Exclude<JobStatusFilter, 'all'> | undefined {
  return status === 'all' ? undefined : status;
}

function isJobStatusFilter(status: string): status is JobStatusFilter {
  return ['all', 'queued', 'running', 'done', 'error', 'cancelled'].includes(status);
}

function isActiveJobStatus(status: string): boolean {
  return status === 'queued' || status === 'running';
}

interface SettingsOverviewProps {
  okServers: number;
  serverCount: number;
  backupMode: string;
  backupDetail: string;
  activeJobs: number;
  lastJob: {
    type: string;
    status: string;
    createdAt: string;
    error: string | null;
  } | null;
}

function SettingsOverview(props: SettingsOverviewProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Overview</CardTitle>
        <CardDescription>Current system state</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <OverviewRow
          icon={<Database className="size-4" />}
          label="Servers"
          value={`${props.okServers}/${props.serverCount} healthy`}
          status={props.okServers === props.serverCount ? 'ok' : 'pending'}
        />
        <OverviewRow
          icon={<ArchiveRestore className="size-4" />}
          label="Backups"
          value={`${props.backupMode} · ${props.backupDetail}`}
          status={props.backupMode === 'S3/R2' ? 'ok' : 'pending'}
        />
        <OverviewRow
          icon={<RefreshCw className="size-4" />}
          label="Jobs"
          value={props.activeJobs > 0 ? `${props.activeJobs} active` : 'none active'}
          status={props.activeJobs > 0 ? 'running' : 'done'}
        />
        <OverviewRow
          icon={<Activity className="size-4" />}
          label="Latest job"
          value={props.lastJob ? `${props.lastJob.type} · ${formatLastCheck(props.lastJob.createdAt)}` : 'none'}
          status={props.lastJob?.status || 'done'}
        />
        {props.lastJob?.error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {props.lastJob.error}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface SetupStepsPanelProps {
  steps: Array<{
    key: string;
    label: string;
    status: string;
    message: string | null;
    failedJobId: number | null;
  }>;
  onOpenJob: (jobId: number) => void;
}

function SetupStepsPanel(props: SetupStepsPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Setup</CardTitle>
        <CardDescription>Onboarding steps and failed jobs</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {props.steps.map(function renderStep(step) {
          return (
            <div className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_auto] sm:items-center" key={step.key}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">{step.label}</p>
                  <StatusBadge status={step.status} />
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{step.message || 'No message yet.'}</p>
              </div>
              {step.failedJobId ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={function openFailedJob() {
                    props.onOpenJob(step.failedJobId!);
                  }}
                >
                  <Activity />
                  Job #{step.failedJobId}
                </Button>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function OverviewRow(props: Readonly<{ icon: ReactNode; label: string; value: string; status: string }>) {
  return (
    <div className="flex min-h-14 items-center gap-3 border-b border-border pb-4 last:border-b-0 last:pb-0">
      <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        {props.icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{props.label}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{props.value}</p>
      </div>
      <StatusBadge status={props.status} />
    </div>
  );
}

type UpdateState = 'idle' | 'restarting' | 'success' | 'failed';

function UpdatePanel() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<UpdateState>('idle');
  const [showApplyDialog, setShowApplyDialog] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const status = useQuery(orpc.updates.get.queryOptions());
  const auto = useQuery(orpc.updates.auto.get.queryOptions());
  const result = useQuery({
    ...orpc.updates.result.queryOptions(),
    refetchInterval: state === 'restarting' ? 2000 : false,
  });

  const check = useMutation(orpc.updates.check.mutationOptions({
    onSuccess: refreshUpdates,
    onError: function handleCheckError() {
      toast.error('Could not check for updates.');
    },
  }));

  const apply = useMutation(orpc.updates.apply.mutationOptions({
    onSuccess: function handleApplySuccess() {
      setState('restarting');
    },
    onError: function handleApplyError(cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not apply update.');
      setState('idle');
    },
  }));

  const clearResult = useMutation(orpc.updates.clearResult.mutationOptions());
  const saveAuto = useMutation(orpc.updates.auto.update.mutationOptions({
    onSuccess: function refreshAutoUpdates() {
      void queryClient.invalidateQueries({ queryKey: orpc.updates.auto.get.key() });
    },
  }));

  useEffect(function watchResult() {
    if (state !== 'restarting' || !result.data?.completed) {
      return;
    }

    if (result.data.success) {
      setState('success');
      toast.success('Update complete.', {
        description: result.data.newVersion ? `Now on v${result.data.newVersion}` : 'Done.',
      });
      void refreshUpdates();
      return;
    }

    setState('failed');
    setShowLog(true);
    toast.error('Update failed.', {
      description: 'Rolled back to previous app files.',
    });
  }, [result.data, state]);

  async function refreshUpdates() {
    await queryClient.invalidateQueries({ queryKey: orpc.updates.get.key() });
  }

  function handleCheck() {
    check.mutate(undefined);
  }

  function handleApply() {
    setShowLog(false);
    setShowApplyDialog(false);
    apply.mutate(undefined);
  }

  async function dismissResult() {
    await clearResult.mutateAsync(undefined);
    setState('idle');
    setShowLog(false);
    await result.refetch();
  }

  function updateAutoEnabled(checked: boolean) {
    saveAuto.mutate({ enabled: checked });
  }

  function updateAutoPatches(checked: boolean) {
    saveAuto.mutate({ applyPatches: checked });
  }

  function updateAutoMigrations(checked: boolean) {
    saveAuto.mutate({ applyMigrations: checked });
  }

  function updateAutoHour(value: string) {
    saveAuto.mutate({ hour: localToUtcHour(Number(value)) });
  }

  const isBusy = check.isPending || apply.isPending || state === 'restarting';
  const update = status.data;
  const autoSettings = auto.data;
  const checkTone = getUpdateCheckTone(update?.checkStatus);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Updates</CardTitle>
            <CardDescription>GitHub releases and app updates</CardDescription>
          </div>
          <Badge variant={update?.updateAvailable ? 'info' : 'secondary'}>
            {update?.currentVersion ? `v${update.currentVersion}` : 'checking'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-4">
          <UpdateMetaRow label="Current version" value={update?.currentVersion ? `v${update.currentVersion}` : 'loading'} />
          <UpdateMetaRow label="Latest release" value={update?.latestVersion ? `v${update.latestVersion}` : 'unknown'} />
          <UpdateMetaRow label="Last check" value={formatLastCheck(update?.lastCheck)} />
          <div className="grid gap-1 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
            <p className="text-xs text-muted-foreground">Check result</p>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge variant={checkTone}>{formatUpdateCheckStatus(update?.checkStatus)}</Badge>
              {update?.checkMessage ? (
                <span className="truncate text-xs text-muted-foreground">{update.checkMessage}</span>
              ) : null}
            </div>
          </div>
        </div>

        {state === 'restarting' ? (
          <UpdateNotice icon={<Loader2 className="size-4 animate-spin" />} title="Restarting" detail="Update is running." />
        ) : null}

        {update?.checkStatus && update.checkStatus !== 'ok' && update.checkStatus !== 'never' ? (
          <UpdateNotice
            icon={<AlertTriangle className="size-4" />}
            title={formatUpdateCheckStatus(update.checkStatus)}
            detail={update.checkMessage || 'Could not complete update check.'}
            tone={update.checkStatus === 'offline' || update.checkStatus === 'rate_limited' || update.checkStatus === 'no_release' ? 'default' : 'destructive'}
          />
        ) : null}

        {update?.updateAvailable ? (
          <div className="rounded-lg border border-border bg-muted/20 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">v{update.availableVersion || update.latestVersion} available</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Last checked {formatLastCheck(update.lastCheck)}
                </p>
              </div>
              {update.hasMigrations ? (
                <Badge variant="warning">
                  <AlertTriangle className="size-3" />
                  migration
                </Badge>
              ) : null}
            </div>
            {update.htmlUrl ? (
              <Button asChild variant="outline" size="sm" className="mt-3">
                <a href={update.htmlUrl} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  Release notes
                </a>
              </Button>
            ) : null}
            {update.releaseNotes ? (
              <pre className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 text-xs text-muted-foreground">
                {update.releaseNotes}
              </pre>
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-muted/20 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                {update?.latestVersion ? (
                  <span className="inline-flex items-center gap-2">
                    <CheckCircle2 className="size-4 text-emerald-300" />
                    Latest release is v{update.latestVersion}. Last checked {formatLastCheck(update.lastCheck)}.
                  </span>
                ) : update ? (
                  'No release data yet. Check for updates.'
                ) : (
                  'Loading update status...'
                )}
              </div>
              {update?.htmlUrl ? (
                <Button asChild variant="outline" size="sm">
                  <a href={update.htmlUrl} target="_blank" rel="noreferrer">
                    <ExternalLink />
                    Release notes
                  </a>
                </Button>
              ) : null}
            </div>
          </div>
        )}

        {result.data?.log ? (
          <div className="grid gap-2">
            <Button type="button" variant="outline" onClick={function toggleLog() { setShowLog(!showLog); }}>
              {showLog ? 'Hide log' : 'Show log'}
            </Button>
            {showLog ? (
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs text-muted-foreground">
                {stripAnsi(result.data.log)}
              </pre>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-4">
          <Label className="flex items-center gap-2">
            <Checkbox checked={autoSettings?.enabled ?? true} onCheckedChange={function changeEnabled(checked) { updateAutoEnabled(checked === true); }} />
            Auto check
          </Label>
          <Label className="flex items-center gap-2">
            <Checkbox checked={autoSettings?.applyPatches ?? false} onCheckedChange={function changePatches(checked) { updateAutoPatches(checked === true); }} />
            Auto apply patch releases
          </Label>
          <Label className="flex items-center gap-2">
            <Checkbox checked={autoSettings?.applyMigrations ?? false} onCheckedChange={function changeMigrations(checked) { updateAutoMigrations(checked === true); }} />
            Allow migration updates
          </Label>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="update-hour">Hour</Label>
            <Select value={String(utcToLocalHour(autoSettings?.hour ?? 4))} onValueChange={updateAutoHour}>
              <SelectTrigger id="update-hour" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, function renderHour(_, hour) {
                  return (
                    <SelectItem key={hour} value={String(hour)}>
                      {formatHour(hour)}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex justify-between gap-2">
        {state === 'success' || state === 'failed' ? (
          <Button type="button" variant="secondary" onClick={dismissResult}>
            Dismiss
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={handleCheck} disabled={isBusy}>
            {check.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Check
          </Button>
        )}
        <Button type="button" disabled={!update?.updateAvailable || isBusy} onClick={function openApplyDialog() { setShowApplyDialog(true); }}>
          {apply.isPending || state === 'restarting' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Update
        </Button>
      </CardFooter>

      <AlertDialog open={showApplyDialog} onOpenChange={setShowApplyDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply update?</AlertDialogTitle>
            <AlertDialogDescription>
              Velo will restart. App files roll back if the update fails.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleApply}>Update</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function UpdateMetaRow(props: Readonly<{ label: string; value: string }>) {
  return (
    <div className="grid gap-1 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
      <p className="text-xs text-muted-foreground">{props.label}</p>
      <p className="min-w-0 truncate text-sm font-medium">{props.value}</p>
    </div>
  );
}

function UpdateNotice(props: Readonly<{ icon: ReactNode; title: string; detail: string; tone?: 'default' | 'destructive' }>) {
  return (
    <div className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${props.tone === 'destructive' ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-border bg-muted/20'}`}>
      {props.icon}
      <div>
        <p className="font-medium">{props.title}</p>
        <p className="mt-1 text-xs opacity-80">{props.detail}</p>
      </div>
    </div>
  );
}

function getUpdateCheckTone(status: string | null | undefined): 'secondary' | 'success' | 'warning' | 'destructive' {
  if (status === 'ok') {
    return 'success';
  }

  if (status === 'offline' || status === 'rate_limited' || status === 'no_release') {
    return 'warning';
  }

  if (status === 'error') {
    return 'destructive';
  }

  return 'secondary';
}

function formatUpdateCheckStatus(status: string | null | undefined): string {
  if (status === 'ok') {
    return 'ok';
  }

  if (status === 'no_release') {
    return 'no release';
  }

  if (status === 'offline') {
    return 'offline';
  }

  if (status === 'rate_limited') {
    return 'rate limited';
  }

  if (status === 'error') {
    return 'error';
  }

  return 'never checked';
}

function formatLastCheck(value: string | null | undefined): string {
  if (!value) {
    return 'never';
  }

  return new Date(value).toLocaleString();
}

function utcToLocalHour(utcHour: number): number {
  const date = new Date();
  date.setUTCHours(utcHour, 0, 0, 0);
  return date.getHours();
}

function localToUtcHour(localHour: number): number {
  const date = new Date();
  date.setHours(localHour, 0, 0, 0);
  return date.getUTCHours();
}

function formatHour(hour: number): string {
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const value = hour % 12 || 12;
  return `${value}:00 ${suffix}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function SettingsLoadingPage(props: Readonly<{ message: string }>) {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 text-foreground">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <RefreshCw className="animate-spin" />
        {props.message}
      </div>
    </main>
  );
}
