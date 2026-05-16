import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, ArchiveRestore, Database, Loader2, RefreshCw } from 'lucide-react';
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
import { orpc } from '#web/lib/api-client';
import {
  AppSidebar,
  BackupPanel,
  BranchesPanel,
  JobsPanel,
  MetricCard,
  ServerPanel,
  type ServerRole,
} from '#web/components/control-plane';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const queryClient = useQueryClient();
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const saveServer = useMutation(orpc.servers.update.mutationOptions({ onSuccess: refreshDashboard }));
  const checkServer = useMutation(orpc.servers.check.mutationOptions({ onSuccess: refreshDashboard }));
  const saveBackupSettings = useMutation(orpc.backup.settings.update.mutationOptions({ onSuccess: refreshDashboard }));
  const deleteBranch = useMutation(orpc.branches.delete.mutationOptions({ onSuccess: refreshDashboard }));
  const busy = getBusyKey();
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

    if (deleteBranch.isPending) {
      return `delete-branch-${deleteBranch.variables?.id}`;
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

  async function handleSave(formData: FormData) {
    const role = formData.get('role') === 'prod' ? 'prod' : 'dev';
    try {
      await saveServer.mutateAsync({
        role,
        host: String(formData.get('host') || ''),
        sshUser: String(formData.get('sshUser') || ''),
        sshKeyPath: String(formData.get('sshKeyPath') || ''),
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

  async function handleDeleteBranch(id: number) {
    try {
      await deleteBranch.mutateAsync({ id });
      toast.success('Branch deleted.');
    } catch (error: any) {
      toast.error(error?.message || 'Could not delete branch.');
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen flex-col lg:grid lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeProject="settings" />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
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

            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <MetricCard title="Servers" value={`${okServers}/${state.servers.length}`} detail="healthy" icon={Database} tone="emerald" />
              <MetricCard title="Backups" value={backupMode} detail={state.backup.bucket || 'not configured'} icon={ArchiveRestore} tone="violet" />
              <MetricCard title="Jobs" value={String(activeJobs)} detail="active now" icon={Activity} tone="amber" />
            </section>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_390px]">
              <div className="grid min-w-0 gap-6">
                <BranchesPanel
                  branches={state.branches}
                  busy={busy}
                  onDelete={handleDeleteBranch}
                />
                <div className="grid gap-6 lg:grid-cols-2">
                  <ServerPanel title="Production" role="prod" server={prodServer} busy={busy} onSave={handleSave} onCheck={handleCheck} />
                  <ServerPanel title="Development" role="dev" server={devServer} busy={busy} onSave={handleSave} onCheck={handleCheck} />
                </div>
                <BackupPanel backup={state.backup} busy={busy === 'save-backup'} onSave={handleSaveBackup} />
              </div>
              <div className="grid content-start gap-6">
                <UpdatePanel />
                <JobsPanel jobs={state.jobs} activeJobs={activeJobs} />
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
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
        {state === 'restarting' ? (
          <UpdateNotice icon={<Loader2 className="size-4 animate-spin" />} title="Restarting" detail="Update is running." />
        ) : null}

        {update?.updateAvailable ? (
          <div className="rounded-lg border border-border bg-muted/20 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">v{update.latestVersion} available</p>
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
            {update.releaseNotes ? (
              <pre className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 text-xs text-muted-foreground">
                {update.releaseNotes}
              </pre>
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
            {update ? `Latest version. Last checked ${formatLastCheck(update.lastCheck)}.` : 'Loading update status...'}
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
