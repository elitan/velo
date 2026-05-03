import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Database,
  GitBranch,
  HardDrive,
  Loader2,
  RefreshCw,
  ShieldCheck,
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
import { orpc, type ControlPlaneState } from '#web/lib/api-client';
import {
  BackupPanel,
  JobsPanel,
  ServerPanel,
  StatusBadge,
  type ServerRole,
} from './control-plane';

export function isSetupComplete(state: ControlPlaneState): boolean {
  return state.setupSteps.every(function isDone(step) {
    return step.status === 'done';
  });
}

export function OnboardingWizard() {
  const queryClient = useQueryClient();
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const saveServer = useMutation(orpc.servers.update.mutationOptions({ onSuccess: refreshDashboard }));
  const checkServer = useMutation(orpc.servers.check.mutationOptions({ onSuccess: refreshDashboard }));
  const saveBackupSettings = useMutation(orpc.backup.settings.update.mutationOptions({ onSuccess: refreshDashboard }));
  const completeSetup = useMutation(orpc.bootstrap.complete.mutationOptions({ onSuccess: refreshDashboard }));

  const activeJobs = dashboard.data?.jobs.filter(function isActive(job) {
    return job.status === 'queued' || job.status === 'running';
  }) ?? [];
  const busy = getBusyKey();

  useEffect(function pollActiveJobs() {
    if (activeJobs.length === 0) {
      return;
    }

    const interval = window.setInterval(function refreshActiveJobs() {
      void dashboard.refetch();
    }, 2000);

    return function clearPoll() {
      window.clearInterval(interval);
    };
  }, [activeJobs.length, dashboard]);

  async function refreshDashboard() {
    await queryClient.invalidateQueries({ queryKey: orpc.dashboard.retrieve.key() });
  }

  function getBusyKey(): string | null {
    const activeJob = activeJobs[0];

    if (activeJob) {
      return activeJob.type;
    }

    if (saveServer.isPending) {
      return `save-${saveServer.variables?.role || 'prod'}`;
    }

    if (checkServer.isPending) {
      return `check-${checkServer.variables?.role || 'prod'}`;
    }

    if (saveBackupSettings.isPending) {
      return 'save-backup';
    }

    if (completeSetup.isPending) {
      return 'setup';
    }

    return null;
  }

  if (!dashboard.data) {
    return <OnboardingLoading message={dashboard.error ? 'Could not load setup.' : 'Loading setup...'} />;
  }

  const state = dashboard.data;
  const nextStep = getNextStep(state);
  const prodServer = state.servers.find(function findProd(server) {
    return server.role === 'prod';
  });
  const devServer = state.servers.find(function findDev(server) {
    return server.role === 'dev';
  });
  const doneSteps = state.setupSteps.filter(function countDone(step) {
    return step.status === 'done';
  }).length;

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

  async function handleCompleteSetup() {
    if (!nextStep || busy) {
      return;
    }

    await completeSetup.mutateAsync(undefined);
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">Setup</Badge>
              <StatusBadge status={isSetupComplete(state) ? 'done' : 'running'} />
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">Set up Velo</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Finish setup before using branches, SQL, tables, or restore tools.
            </p>
          </div>
          <Button variant="outline" onClick={function refreshPage() { void dashboard.refetch(); }}>
            <RefreshCw />
            Refresh
          </Button>
        </header>

        <Card>
          <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle>{doneSteps}/{state.setupSteps.length} complete</CardTitle>
              <CardDescription>{nextStep ? `Next: ${nextStep.label}` : 'Setup complete'}</CardDescription>
            </div>
            <Button onClick={handleCompleteSetup} disabled={!nextStep || Boolean(busy)}>
              {busy ? <Loader2 className="animate-spin" /> : getStepIcon(nextStep?.key)}
              {busy ? 'Working...' : nextStep ? 'Finish setup' : 'Done'}
            </Button>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {state.setupSteps.map(function renderStep(step) {
              const isActive = nextStep?.key === step.key;

              return (
                <div className="border-t border-border pt-3 first:border-t-0 first:pt-0" key={step.key}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{step.label}</p>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {step.message || (isActive ? 'Ready' : 'Waiting')}
                      </p>
                    </div>
                    <StatusBadge status={isActive && busy ? 'running' : step.status} />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="grid gap-6">
            <div className="grid gap-6 lg:grid-cols-2">
              <ServerPanel title="Production" role="prod" server={prodServer} busy={busy} onSave={handleSave} onCheck={handleCheck} />
              <ServerPanel title="Development" role="dev" server={devServer} busy={busy} onSave={handleSave} onCheck={handleCheck} />
            </div>
            <BackupPanel backup={state.backup} busy={busy === 'save-backup'} onSave={handleSaveBackup} />
          </div>
          <JobsPanel jobs={state.jobs} activeJobs={activeJobs.length} />
        </div>
      </section>
    </main>
  );
}

function getNextStep(state: ControlPlaneState) {
  return state.setupSteps.find(function isIncomplete(step) {
    return step.status !== 'done';
  });
}

function getStepIcon(key: string | undefined) {
  if (key === 'dev-check') {
    return <HardDrive />;
  }

  if (key === 'prod-check' || key === 'prod-setup' || key === 'backups') {
    return <ShieldCheck />;
  }

  if (key === 'replica') {
    return <Database />;
  }

  if (key === 'first-branch') {
    return <GitBranch />;
  }

  return <CheckCircle2 />;
}

function OnboardingLoading(props: Readonly<{ message: string }>) {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 text-foreground">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="animate-spin" />
        {props.message}
      </div>
    </main>
  );
}
