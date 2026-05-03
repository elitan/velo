import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Activity, ArchiveRestore, Database, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { Badge } from '#web/components/ui/badge';
import { Button } from '#web/components/ui/button';
import { orpc } from '#web/lib/api-client';
import {
  AppSidebar,
  BackupPanel,
  BranchesPanel,
  JobsPanel,
  MetricCard,
  ServerPanel,
  SetupPanel,
  StatusBadge,
  SystemPanel,
  type ServerRole,
} from '#web/components/control-plane';
import { isSetupComplete, OnboardingWizard } from '#web/components/onboarding-wizard';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const queryClient = useQueryClient();
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const saveServer = useMutation(orpc.servers.update.mutationOptions({ onSuccess: refreshDashboard }));
  const checkServer = useMutation(orpc.servers.check.mutationOptions({ onSuccess: refreshDashboard }));
  const saveBackupSettings = useMutation(orpc.backup.settings.update.mutationOptions({ onSuccess: refreshDashboard }));
  const startBootstrap = useMutation(orpc.bootstrap.start.mutationOptions({ onSuccess: refreshDashboard }));
  const createBranch = useMutation(orpc.branches.create.mutationOptions({ onSuccess: refreshDashboard }));
  const deleteBranch = useMutation(orpc.branches.delete.mutationOptions({ onSuccess: refreshDashboard }));
  const createReplicaBase = useMutation(orpc.replicaBase.create.mutationOptions({ onSuccess: refreshDashboard }));
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
      return `save-${saveServer.variables?.role || 'prod'}`;
    }

    if (checkServer.isPending) {
      return `check-${checkServer.variables?.role || 'prod'}`;
    }

    if (saveBackupSettings.isPending) {
      return 'save-backup';
    }

    if (startBootstrap.isPending) {
      return `bootstrap-${startBootstrap.variables?.target || 'dev'}`;
    }

    if (createBranch.isPending) {
      return 'create-branch';
    }

    if (deleteBranch.isPending) {
      return `delete-branch-${deleteBranch.variables?.id}`;
    }

    if (createReplicaBase.isPending) {
      return 'create-replica';
    }

    return null;
  }

  if (!dashboard.data) {
    return <SettingsLoadingPage message={dashboard.error ? 'Could not load settings.' : 'Loading settings...'} />;
  }

  const state = dashboard.data;

  if (!isSetupComplete(state)) {
    return <OnboardingWizard />;
  }

  const prodServer = state.servers.find(function findProd(server) {
    return server.role === 'prod';
  });
  const devServer = state.servers.find(function findDev(server) {
    return server.role === 'dev';
  });
  const doneSteps = state.setupSteps.filter(function countDone(step) {
    return step.status === 'done';
  }).length;
  const okServers = state.servers.filter(function countOk(server) {
    return server.status === 'ok';
  }).length;
  const backupMode = state.backup.enabled ? 'S3/R2' : 'local';

  async function handleSave(formData: FormData) {
    const role = formData.get('role') === 'prod' ? 'prod' : 'dev';
    await saveServer.mutateAsync({
      role,
      host: String(formData.get('host') || ''),
      sshUser: String(formData.get('sshUser') || ''),
      sshKeyPath: String(formData.get('sshKeyPath') || ''),
    });
  }

  async function handleCheck(role: ServerRole) {
    await checkServer.mutateAsync({ role });
  }

  async function handleSaveBackup(formData: FormData) {
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
  }

  async function handleBootstrap(kind: ServerRole) {
    await startBootstrap.mutateAsync({ target: kind });
  }

  async function handleCreateBranch(formData: FormData) {
    const name = String(formData.get('name') || '');
    await createBranch.mutateAsync({ name });
  }

  async function handleDeleteBranch(id: number) {
    await deleteBranch.mutateAsync({ id });
  }

  async function handleCreateReplica() {
    await createReplicaBase.mutateAsync(undefined);
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeProject="settings" />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Control plane</Badge>
                  <StatusBadge status={doneSteps === state.setupSteps.length ? 'done' : 'pending'} />
                </div>
                <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">Settings</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Manage server access, backup storage, and background activity.
                </p>
              </div>
              <Button variant="outline" onClick={function refreshPage() { void dashboard.refetch(); }}>
                <RefreshCw />
                Refresh
              </Button>
            </header>

            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard title="Setup" value={`${doneSteps}/${state.setupSteps.length}`} detail="steps complete" icon={SlidersHorizontal} tone="blue" />
              <MetricCard title="Servers" value={`${okServers}/${state.servers.length}`} detail="healthy" icon={Database} tone="emerald" />
              <MetricCard title="Backups" value={backupMode} detail={state.backup.bucket || 'not configured'} icon={ArchiveRestore} tone="violet" />
              <MetricCard title="Jobs" value={String(activeJobs)} detail="active now" icon={Activity} tone="amber" />
            </section>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_390px]">
              <div className="grid min-w-0 gap-6">
                <SetupPanel
                  steps={state.setupSteps}
                  busy={busy}
                  prodServerReady={Boolean(prodServer)}
                  onBootstrap={handleBootstrap}
                  onCreateReplica={handleCreateReplica}
                />
                <BranchesPanel
                  branches={state.branches}
                  busy={busy}
                  onCreate={handleCreateBranch}
                  onDelete={handleDeleteBranch}
                />
                <div className="grid gap-6 lg:grid-cols-2">
                  <ServerPanel title="Production" role="prod" server={prodServer} busy={busy} onSave={handleSave} onCheck={handleCheck} />
                  <ServerPanel title="Development" role="dev" server={devServer} busy={busy} onSave={handleSave} onCheck={handleCheck} />
                </div>
                <BackupPanel backup={state.backup} busy={busy === 'save-backup'} onSave={handleSaveBackup} />
              </div>
              <div className="grid content-start gap-6">
                <SystemPanel
                  setupDone={doneSteps}
                  setupTotal={state.setupSteps.length}
                  healthyServers={okServers}
                  totalServers={state.servers.length}
                  backupMode={backupMode}
                  activeJobs={activeJobs}
                />
                <JobsPanel jobs={state.jobs} activeJobs={activeJobs} />
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
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
