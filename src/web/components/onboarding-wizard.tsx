import type { FormEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Database,
  Folder,
  GitBranch,
  HardDrive,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
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

export function OnboardingWizard(props: Readonly<{ onDismissComplete?: () => void }>) {
  const queryClient = useQueryClient();
  const dashboard = useQuery(orpc.dashboard.retrieve.queryOptions());
  const saveAppPassword = useMutation(orpc.onboarding.appPassword.update.mutationOptions({ onSuccess: refreshDashboard }));
  const saveProject = useMutation(orpc.onboarding.project.update.mutationOptions({ onSuccess: refreshDashboard }));
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

    if (saveAppPassword.isPending) {
      return 'save-app-password';
    }

    if (saveProject.isPending) {
      return 'save-project';
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
  const error = getErrorMessage([
    saveAppPassword.error,
    saveProject.error,
    saveServer.error,
    checkServer.error,
    saveBackupSettings.error,
    completeSetup.error,
  ]);

  async function handleSaveAppPassword(formData: FormData) {
    try {
      await saveAppPassword.mutateAsync({
        username: String(formData.get('username') || 'admin'),
        password: String(formData.get('password') || ''),
      });
    } catch {}
  }

  async function handleSaveProject(formData: FormData) {
    try {
      await saveProject.mutateAsync({
        name: String(formData.get('name') || ''),
        postgresVersion: String(formData.get('postgresVersion') || '17'),
        databaseName: String(formData.get('databaseName') || 'postgres'),
        appUser: String(formData.get('appUser') || 'postgres'),
      });
    } catch {}
  }

  async function handleSaveServer(formData: FormData) {
    try {
      const role = formData.get('role') === 'prod' ? 'prod' : 'dev';
      await saveServer.mutateAsync({
        role,
        host: String(formData.get('host') || ''),
        sshUser: String(formData.get('sshUser') || ''),
        sshKeyPath: String(formData.get('sshKeyPath') || ''),
      });
    } catch {}
  }

  async function handleCheckServer(role: ServerRole) {
    try {
      await checkServer.mutateAsync({ role });
    } catch {}
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
    } catch {}
  }

  async function handleCompleteSetup() {
    if (!nextStep || busy) {
      return;
    }

    try {
      await completeSetup.mutateAsync(undefined);
    } catch {}
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
              Follow each step. Progress is saved, so refresh is safe.
            </p>
          </div>
          <Button variant="outline" onClick={function refreshPage() { void dashboard.refetch(); }}>
            <RefreshCw />
            Refresh
          </Button>
        </header>

        <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)_360px]">
          <SetupStepsCard steps={state.setupSteps} activeKey={nextStep?.key || null} doneSteps={doneSteps} />
          <div className="grid gap-4">
            {error ? <ErrorNote message={error} /> : null}
            {renderCurrentStep({
              state,
              nextStep,
              busy,
              prodServer,
              devServer,
              onSaveAppPassword: handleSaveAppPassword,
              onSaveProject: handleSaveProject,
              onSaveServer: handleSaveServer,
              onCheckServer: handleCheckServer,
              onSaveBackup: handleSaveBackup,
              onCompleteSetup: handleCompleteSetup,
              onDismissComplete: props.onDismissComplete,
            })}
          </div>
          <JobsPanel jobs={state.jobs} activeJobs={activeJobs.length} />
        </div>
      </section>
    </main>
  );
}

interface CurrentStepProps {
  state: ControlPlaneState;
  nextStep: ControlPlaneState['setupSteps'][number] | undefined;
  busy: string | null;
  prodServer: ControlPlaneState['servers'][number] | undefined;
  devServer: ControlPlaneState['servers'][number] | undefined;
  onSaveAppPassword: (formData: FormData) => Promise<void>;
  onSaveProject: (formData: FormData) => Promise<void>;
  onSaveServer: (formData: FormData) => Promise<void>;
  onCheckServer: (role: ServerRole) => Promise<void>;
  onSaveBackup: (formData: FormData) => Promise<void>;
  onCompleteSetup: () => Promise<void>;
  onDismissComplete?: () => void;
}

function renderCurrentStep(props: CurrentStepProps): ReactNode {
  const step = props.nextStep;

  if (!step) {
    return <SetupCompleteStep state={props.state} onDismiss={props.onDismissComplete} />;
  }

  if (step.key === 'app-password') {
    return <AppPasswordStep state={props.state} busy={props.busy === 'save-app-password'} onSave={props.onSaveAppPassword} />;
  }

  if (step.key === 'project') {
    return <ProjectStep state={props.state} busy={props.busy === 'save-project'} onSave={props.onSaveProject} />;
  }

  if (step.key === 'dev-check') {
    return (
      <ServerPanel
        key="dev-server-step"
        title="Development"
        role="dev"
        server={props.devServer}
        busy={props.busy}
        onSave={props.onSaveServer}
        onCheck={props.onCheckServer}
      />
    );
  }

  if (step.key === 'prod-check') {
    return (
      <ServerPanel
        key="prod-server-step"
        title="Production"
        role="prod"
        server={props.prodServer}
        busy={props.busy}
        onSave={props.onSaveServer}
        onCheck={props.onCheckServer}
      />
    );
  }

  if (step.key === 'backups-config') {
    return <BackupPanel backup={props.state.backup} busy={props.busy === 'save-backup'} onSave={props.onSaveBackup} />;
  }

  return <RunSetupStep step={step} busy={props.busy === 'setup'} onRun={props.onCompleteSetup} />;
}

function SetupStepsCard(props: {
  steps: ControlPlaneState['setupSteps'];
  activeKey: string | null;
  doneSteps: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.doneSteps}/{props.steps.length} complete</CardTitle>
        <CardDescription>{props.activeKey ? 'Current blocker shown at right' : 'Ready to use'}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {props.steps.map(function renderStep(step, index) {
          const active = step.key === props.activeKey;
          const Icon = getStepIcon(step.key);

          return (
            <div
              className={cn(
                'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-md border px-3 py-2',
                active ? 'border-primary bg-primary/5' : 'border-border'
              )}
              key={step.key}
            >
              <div className="grid size-7 place-items-center rounded-md bg-muted text-muted-foreground">
                <Icon className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{step.label}</p>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {step.message || (active ? 'Ready' : `Step ${index + 1}`)}
                </p>
              </div>
              <StatusBadge status={active && step.status === 'pending' ? 'ready' : step.status} />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function AppPasswordStep(props: {
  state: ControlPlaneState;
  busy: boolean;
  onSave: (formData: FormData) => Promise<void>;
}) {
  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.onSave(new FormData(event.currentTarget));
  }

  return (
    <StepCard icon={KeyRound} title="Set app password" detail="Protect the web app before setup changes servers.">
      <form className="grid gap-4" onSubmit={submitForm}>
        <Field label="Username" htmlFor="app-username">
          <Input id="app-username" name="username" defaultValue={props.state.appAuth.username || 'admin'} autoComplete="username" />
        </Field>
        <Field label="Password" htmlFor="app-password">
          <Input id="app-password" name="password" type="password" minLength={8} autoComplete="new-password" />
        </Field>
        <Button type="submit" disabled={props.busy}>
          {props.busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
          Save password
        </Button>
      </form>
    </StepCard>
  );
}

function ProjectStep(props: {
  state: ControlPlaneState;
  busy: boolean;
  onSave: (formData: FormData) => Promise<void>;
}) {
  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.onSave(new FormData(event.currentTarget));
  }

  return (
    <StepCard icon={Folder} title="Create project" detail="Name the control-plane project and pick Postgres defaults.">
      <form className="grid gap-4" onSubmit={submitForm}>
        <Field label="Project name" htmlFor="project-name">
          <Input id="project-name" name="name" defaultValue={props.state.project?.name || 'prod'} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Postgres" htmlFor="project-postgres-version">
            <Input id="project-postgres-version" name="postgresVersion" defaultValue={props.state.project?.postgresVersion || '17'} />
          </Field>
          <Field label="Database" htmlFor="project-database-name">
            <Input id="project-database-name" name="databaseName" defaultValue={props.state.project?.databaseName || 'postgres'} />
          </Field>
          <Field label="App user" htmlFor="project-app-user">
            <Input id="project-app-user" name="appUser" defaultValue={props.state.project?.appUser || 'postgres'} />
          </Field>
        </div>
        <Button type="submit" disabled={props.busy}>
          {props.busy ? <Loader2 className="animate-spin" /> : <Folder />}
          Save project
        </Button>
      </form>
    </StepCard>
  );
}

function RunSetupStep(props: {
  step: ControlPlaneState['setupSteps'][number];
  busy: boolean;
  onRun: () => Promise<void>;
}) {
  const needsWarning = props.step.key === 'prod-setup' || props.step.key === 'backups';

  return (
    <StepCard icon={ShieldCheck} title="Run setup" detail={getRunSetupDetail(props.step.key)}>
      <div className="grid gap-4">
        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
          {props.step.message || 'Ready to continue.'}
        </div>
        {needsWarning ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button disabled={props.busy}>
                {props.busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                Run setup
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Run production setup?</AlertDialogTitle>
                <AlertDialogDescription>
                  This installs packages, writes Postgres and pgBackRest config, restarts Postgres, and creates the first full backup.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={props.busy}>Cancel</AlertDialogCancel>
                <AlertDialogAction disabled={props.busy} onClick={function confirmRun() { void props.onRun(); }}>
                  Continue
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <Button disabled={props.busy} onClick={function clickRun() { void props.onRun(); }}>
            {props.busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            Run setup
          </Button>
        )}
      </div>
    </StepCard>
  );
}

function SetupCompleteStep(props: { state: ControlPlaneState; onDismiss?: () => void }) {
  const devBranch = props.state.branches.find(function findDev(branch) {
    return branch.slug === 'dev';
  }) || props.state.branches[0];

  return (
    <StepCard icon={CheckCircle2} title="Setup complete" detail="Velo is ready.">
      <div className="grid gap-4">
        <Field label="Production">
          <CopyValue value={props.state.prodConnectionUrl} />
        </Field>
        <Field label={devBranch ? devBranch.displayName : 'Dev branch'}>
          <CopyValue value={devBranch?.connectionUrl || null} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={props.onDismiss}>
            <CheckCircle2 />
            Show dashboard
          </Button>
          <Button asChild>
            <Link to="/branch/$branchId/overview" params={{ branchId: 'prod' }}>
              <Database />
              Open prod
            </Link>
          </Button>
          {devBranch ? (
            <Button asChild variant="outline">
              <Link to="/branch/$branchId/overview" params={{ branchId: devBranch.slug }}>
                <GitBranch />
                Open dev
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </StepCard>
  );
}

function StepCard(props: {
  icon: typeof Database;
  title: string;
  detail: string;
  children: ReactNode;
}) {
  const Icon = props.icon;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3">
        <div className="grid size-9 place-items-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-4" />
        </div>
        <div>
          <CardTitle>{props.title}</CardTitle>
          <CardDescription>{props.detail}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>{props.children}</CardContent>
    </Card>
  );
}

function ErrorNote(props: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 size-4" />
      <span>{props.message}</span>
    </div>
  );
}

interface FieldProps {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}

function Field(props: FieldProps) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      {props.children}
    </div>
  );
}

function CopyValue(props: { value: string | null }) {
  const [copied, setCopied] = useState(false);
  const value = props.value || '';

  async function copyValue() {
    if (!value) {
      return;
    }

    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(function resetCopied() {
      setCopied(false);
    }, 1200);
  }

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
      <code className="min-w-0 truncate rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
        {value || 'not ready'}
      </code>
      <Button type="button" size="icon" variant="outline" onClick={copyValue} disabled={!value} title="Copy">
        {copied ? <CheckCircle2 className="text-emerald-600" /> : <Copy />}
      </Button>
    </div>
  );
}

function getNextStep(state: ControlPlaneState) {
  return state.setupSteps.find(function isIncomplete(step) {
    return step.status !== 'done';
  });
}

function getStepIcon(key: string) {
  if (key === 'app-password') {
    return KeyRound;
  }

  if (key === 'project') {
    return Folder;
  }

  if (key === 'dev-check') {
    return HardDrive;
  }

  if (key === 'prod-check' || key === 'prod-setup' || key === 'backups' || key === 'backups-config') {
    return ShieldCheck;
  }

  if (key === 'replica') {
    return Database;
  }

  if (key === 'first-branch') {
    return GitBranch;
  }

  return CheckCircle2;
}

function getRunSetupDetail(key: string): string {
  if (key === 'prod-setup' || key === 'backups') {
    return 'Install production Postgres, configure backups, and create the first backup.';
  }

  if (key === 'replica') {
    return 'Create the dev replica base from production.';
  }

  if (key === 'first-branch') {
    return 'Create the first writable dev branch.';
  }

  return 'Continue setup.';
}

function getErrorMessage(errors: unknown[]): string | null {
  const error = errors.find(function hasError(item) {
    return Boolean(item);
  });

  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Action failed';
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
