import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import type { FormEvent, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  GitBranch,
  HardDrive,
  Loader2,
  Play,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import { Badge, type BadgeProps } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Checkbox } from '../components/ui/checkbox';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Separator } from '../components/ui/separator';
import { cn } from '@/lib/utils';
import {
  checkServerAction,
  createBranchAction,
  createReplicaBaseAction,
  deleteBranchAction,
  getSetupState,
  runDevBootstrapAction,
  runProdBootstrapAction,
  saveBackupSettingsAction,
  saveServerAction,
} from '../lib/actions';

export const Route = createFileRoute('/')({
  loader: function loader() {
    return getSetupState();
  },
  component: HomePage,
});

type ServerRole = 'prod' | 'dev';

interface ConnectionItem {
  id: string;
  name: string;
  scope: string;
  status: string;
  url: string | null;
  port: number | null;
}

function HomePage() {
  const state = Route.useLoaderData();
  const router = useRouter();
  const saveServer = useServerFn(saveServerAction);
  const checkServer = useServerFn(checkServerAction);
  const runDevBootstrap = useServerFn(runDevBootstrapAction);
  const runProdBootstrap = useServerFn(runProdBootstrapAction);
  const saveBackupSettings = useServerFn(saveBackupSettingsAction);
  const createBranch = useServerFn(createBranchAction);
  const deleteBranch = useServerFn(deleteBranchAction);
  const createReplicaBase = useServerFn(createReplicaBaseAction);
  const [busy, setBusy] = useState<string | null>(null);

  async function handleSave(formData: FormData) {
    const role = formData.get('role') === 'prod' ? 'prod' : 'dev';
    await runBusy(`save-${role}`, async function saveServerForm() {
      await saveServer({
        data: {
          role,
          host: String(formData.get('host') || ''),
          sshUser: String(formData.get('sshUser') || ''),
          sshKeyPath: String(formData.get('sshKeyPath') || ''),
        },
      });
    });
  }

  async function handleSaveBackup(formData: FormData) {
    await runBusy('save-backup', async function saveBackupForm() {
      await saveBackupSettings({
        data: {
          enabled: formData.get('enabled') === 'on',
          endpoint: String(formData.get('endpoint') || ''),
          bucket: String(formData.get('bucket') || ''),
          region: String(formData.get('region') || 'auto'),
          accessKeyId: String(formData.get('accessKeyId') || ''),
          secretAccessKey: String(formData.get('secretAccessKey') || ''),
          path: String(formData.get('path') || '/prod'),
        },
      });
    });
  }

  async function handleCheck(role: ServerRole) {
    await runBusy(`check-${role}`, async function checkServerRole() {
      await checkServer({ data: { role } });
    });
  }

  async function handleBootstrap(kind: ServerRole) {
    await runBusy(`bootstrap-${kind}`, async function bootstrapServer() {
      if (kind === 'prod') {
        await runProdBootstrap();
      } else {
        await runDevBootstrap();
      }
    });
  }

  async function handleCreateBranch(formData: FormData) {
    const name = String(formData.get('name') || '');
    await runBusy('create-branch', async function createBranchForm() {
      await createBranch({ data: { name } });
    });
  }

  async function handleDeleteBranch(id: number, name: string) {
    if (!window.confirm(`Delete branch "${name}"?`)) {
      return;
    }

    await runBusy(`delete-branch-${id}`, async function deleteBranchClick() {
      await deleteBranch({ data: { id } });
    });
  }

  async function handleCreateReplica() {
    await runBusy('create-replica', async function createReplica() {
      await createReplicaBase();
    });
  }

  async function runBusy(key: string, task: () => Promise<void>) {
    setBusy(key);
    try {
      await task();
      await router.invalidate();
    } finally {
      setBusy(null);
    }
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
  const activeJobs = state.jobs.filter(function isActive(job) {
    return job.status === 'queued' || job.status === 'running';
  }).length;
  const okServers = state.servers.filter(function countOk(server) {
    return server.status === 'ok';
  }).length;
  const setupComplete = doneSteps === state.setupSteps.length;

  useEffect(function pollActiveJobs() {
    if (activeJobs === 0) {
      return;
    }

    const interval = window.setInterval(function refreshActiveJobs() {
      void router.invalidate();
    }, 2000);

    return function clearPoll() {
      window.clearInterval(interval);
    };
  }, [activeJobs, router]);

  const connectionItems = useMemo(function buildConnections(): ConnectionItem[] {
    return [
      {
        id: 'production',
        name: 'Production',
        scope: 'primary database',
        status: state.prodConnectionUrl ? 'ready' : 'pending',
        url: state.prodConnectionUrl,
        port: 5432,
      },
      ...state.branches.map(function mapBranch(branch) {
        return {
          id: `branch-${branch.id}`,
          name: branch.name,
          scope: 'branch',
          status: branch.status,
          url: branch.connectionUrl,
          port: branch.port,
        };
      }),
    ];
  }, [state.branches, state.prodConnectionUrl]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[244px_1fr]">
        <aside className="hidden bg-sidebar px-5 py-5 text-sidebar-foreground lg:block lg:border-r">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Database className="size-4" />
            </div>
            <div>
              <div className="text-sm font-semibold leading-none">Velo</div>
              <div className="mt-1 text-xs text-muted-foreground">Control plane</div>
            </div>
          </div>

          <div className="mt-7 grid gap-1 text-sm">
            <NavItem icon={Activity} label="Overview" href="#overview" active />
            <NavItem icon={Database} label="Connections" href="#connections" />
            <NavItem icon={GitBranch} label="Branches" href="#branches" />
            <NavItem icon={Settings2} label="Settings" href="#settings" />
          </div>

          <div className="mt-7 rounded-lg border bg-background p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">System</span>
              <StatusBadge status={setupComplete ? 'done' : activeJobs > 0 ? 'running' : 'pending'} />
            </div>
            <div className="mt-3 text-2xl font-semibold">{doneSteps}/{state.setupSteps.length}</div>
            <div className="mt-1 text-xs text-muted-foreground">setup steps complete</div>
          </div>
        </aside>

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between gap-4 lg:hidden">
              <div className="flex items-center gap-3">
                <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
                  <Database className="size-4" />
                </div>
                <div>
                  <div className="text-sm font-semibold leading-none">Velo</div>
                  <div className="mt-1 text-xs text-muted-foreground">Control plane</div>
                </div>
              </div>
              <StatusBadge status={setupComplete ? 'done' : activeJobs > 0 ? 'running' : 'pending'} />
            </div>

            <header id="overview" className="scroll-mt-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">MVP</Badge>
                  <Badge variant={setupComplete ? 'success' : 'warning'}>
                    {setupComplete ? 'ready' : 'setup needed'}
                  </Badge>
                </div>
                <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">
                  Hosted Postgres, made quiet.
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Production lives on its own server. Dev branches stay fast on ZFS. Every database connection is here.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  onClick={function refreshPage() {
                    void router.invalidate();
                  }}
                >
                  <RefreshCw />
                  Refresh
                </Button>
                <Button
                  onClick={function createReplicaClick() {
                    void handleCreateReplica();
                  }}
                  disabled={busy === 'create-replica' || !prodServer}
                >
                  {busy === 'create-replica' ? <Loader2 className="animate-spin" /> : <Play />}
                  Sync replica
                </Button>
              </div>
            </header>

            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard title="Setup" value={`${doneSteps}/${state.setupSteps.length}`} detail="steps done" icon={ShieldCheck} tone="emerald" />
              <MetricCard title="Servers" value={`${okServers}/2`} detail="healthy hosts" icon={Server} tone="blue" />
              <MetricCard title="Branches" value={String(state.branches.length)} detail="dev databases" icon={GitBranch} tone="violet" />
              <MetricCard title="Jobs" value={String(activeJobs)} detail="active now" icon={Activity} tone="amber" />
            </section>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_390px]">
              <div className="grid min-w-0 gap-6">
                <div id="connections" className="scroll-mt-6">
                  <ConnectionsPanel connections={connectionItems} />
                </div>

                <SetupPanel
                  steps={state.setupSteps}
                  busy={busy}
                  prodServerReady={Boolean(prodServer)}
                  onBootstrap={handleBootstrap}
                  onCreateReplica={handleCreateReplica}
                />

                <div id="branches" className="scroll-mt-6">
                  <BranchesPanel
                    branches={state.branches}
                    busy={busy}
                    onCreate={handleCreateBranch}
                    onDelete={handleDeleteBranch}
                  />
                </div>
              </div>

              <div id="settings" className="grid scroll-mt-6 content-start gap-6">
                <ServerPanel
                  title="Production"
                  role="prod"
                  server={prodServer}
                  busy={busy}
                  onSave={handleSave}
                  onCheck={handleCheck}
                />
                <ServerPanel
                  title="Development"
                  role="dev"
                  server={devServer}
                  busy={busy}
                  onSave={handleSave}
                  onCheck={handleCheck}
                />
                <BackupPanel
                  backup={state.backup}
                  busy={busy === 'save-backup'}
                  onSave={handleSaveBackup}
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

interface NavItemProps {
  icon: typeof Activity;
  label: string;
  href: string;
  active?: boolean;
}

function NavItem(props: NavItemProps) {
  const Icon = props.icon;

  return (
    <a
      href={props.href}
      className={cn(
        'flex h-9 items-center gap-2 rounded-md px-3 text-muted-foreground',
        'transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        props.active && 'bg-sidebar-accent text-sidebar-accent-foreground'
      )}
    >
      <Icon className="size-4" />
      <span>{props.label}</span>
    </a>
  );
}

interface MetricCardProps {
  title: string;
  value: string;
  detail: string;
  icon: typeof Activity;
  tone: 'emerald' | 'blue' | 'violet' | 'amber';
}

function MetricCard(props: MetricCardProps) {
  const Icon = props.icon;
  const toneClass = {
    emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    blue: 'bg-blue-50 text-blue-700 ring-blue-100',
    violet: 'bg-violet-50 text-violet-700 ring-violet-100',
    amber: 'bg-amber-50 text-amber-700 ring-amber-100',
  }[props.tone];

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 p-4">
        <div>
          <p className="text-sm text-muted-foreground">{props.title}</p>
          <div className="mt-1 text-2xl font-semibold">{props.value}</div>
          <p className="mt-1 text-xs text-muted-foreground">{props.detail}</p>
        </div>
        <div className={cn('grid size-10 place-items-center rounded-lg ring-1', toneClass)}>
          <Icon className="size-5" />
        </div>
      </CardContent>
    </Card>
  );
}

interface ConnectionsPanelProps {
  connections: ConnectionItem[];
}

function ConnectionsPanel(props: ConnectionsPanelProps) {
  const readyCount = props.connections.filter(function countReady(connection) {
    return Boolean(connection.url);
  }).length;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>Connections</CardTitle>
          <CardDescription>{readyCount} database URLs available</CardDescription>
        </div>
        <Badge variant="secondary">
          <TerminalSquare className="size-3" />
          psql ready
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y">
          {props.connections.map(function renderConnection(connection) {
            return (
              <div className="grid gap-3 px-5 py-4 lg:grid-cols-[190px_1fr] lg:items-center" key={connection.id}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{connection.name}</p>
                    <StatusBadge status={connection.status} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{connection.scope}</span>
                    <span className="text-border">/</span>
                    <span>{connection.port ? `:${connection.port}` : 'no port'}</span>
                  </div>
                </div>
                <ConnectionString value={connection.url} />
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

interface SetupPanelProps {
  steps: Array<{
    key: string;
    label: string;
    status: string;
    message: string | null;
  }>;
  busy: string | null;
  prodServerReady: boolean;
  onBootstrap: (kind: ServerRole) => Promise<void>;
  onCreateReplica: () => Promise<void>;
}

function SetupPanel(props: SetupPanelProps) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <CardTitle>Setup flow</CardTitle>
          <CardDescription>Run this top to bottom. Actions are idempotent.</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={function clickDevBootstrap() {
              void props.onBootstrap('dev');
            }}
            disabled={props.busy === 'bootstrap-dev'}
          >
            {props.busy === 'bootstrap-dev' ? <Loader2 className="animate-spin" /> : <HardDrive />}
            Setup dev
          </Button>
          <Button
            variant="outline"
            onClick={function clickProdBootstrap() {
              void props.onBootstrap('prod');
            }}
            disabled={props.busy === 'bootstrap-prod' || !props.prodServerReady}
          >
            {props.busy === 'bootstrap-prod' ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            Setup prod
          </Button>
          <Button
            variant="outline"
            onClick={function clickCreateReplica() {
              void props.onCreateReplica();
            }}
            disabled={props.busy === 'create-replica' || !props.prodServerReady}
          >
            {props.busy === 'create-replica' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Replica
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-2">
          {props.steps.map(function renderStep(step, index) {
            return (
              <div className="rounded-lg border bg-muted/20 p-4" key={step.key}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <StepIcon status={step.status} index={index + 1} />
                    <div className="min-w-0">
                      <p className="font-medium leading-5">{step.label}</p>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {step.message || 'Waiting'}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={step.status} />
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

interface BranchesPanelProps {
  branches: Array<{
    id: number;
    name: string;
    status: string;
    port: number | null;
    connectionUrl: string | null;
  }>;
  busy: string | null;
  onCreate: (formData: FormData) => Promise<void>;
  onDelete: (id: number, name: string) => Promise<void>;
}

function BranchesPanel(props: BranchesPanelProps) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>Branches</CardTitle>
          <CardDescription>Writable ZFS clones from the dev base.</CardDescription>
        </div>
        <BranchCreateForm busy={props.busy === 'create-branch'} onCreate={props.onCreate} />
      </CardHeader>
      <CardContent className="p-0">
        {props.branches.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            title="No branches yet"
            detail="Create the replica base first, then create your first branch."
          />
        ) : (
          <div className="divide-y">
            {props.branches.map(function renderBranch(branch) {
              const isDeleting = props.busy === `delete-branch-${branch.id}`;

              async function deleteClick() {
                await props.onDelete(branch.id, branch.name);
              }

              return (
                <div className="grid gap-3 px-5 py-4 md:grid-cols-[1fr_120px_80px_auto] md:items-center" key={branch.id}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <GitBranch className="size-4 text-muted-foreground" />
                      <p className="font-medium">{branch.name}</p>
                    </div>
                    <div className="mt-2 md:hidden">
                      <ConnectionString value={branch.connectionUrl} />
                    </div>
                  </div>
                  <StatusBadge status={branch.status} />
                  <div className="text-sm text-muted-foreground">{branch.port || '-'}</div>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={deleteClick}
                    disabled={isDeleting}
                    title="Delete branch"
                  >
                    {isDeleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  </Button>
                  <div className="hidden md:col-span-4 md:block">
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

interface BranchCreateFormProps {
  busy: boolean;
  onCreate: (formData: FormData) => Promise<void>;
}

function BranchCreateForm(props: BranchCreateFormProps) {
  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    await props.onCreate(new FormData(form));
    form.reset();
  }

  return (
    <form className="grid grid-cols-[minmax(0,180px)_auto] gap-2" onSubmit={submitForm}>
      <Input name="name" placeholder="preview-1" />
      <Button type="submit" variant="secondary" disabled={props.busy}>
        {props.busy ? <Loader2 className="animate-spin" /> : <GitBranch />}
        Create
      </Button>
    </form>
  );
}

interface ServerPanelProps {
  title: string;
  role: ServerRole;
  server: {
    host: string;
    ssh_user: string;
    ssh_key_path: string;
    status: string;
    status_message: string | null;
  } | undefined;
  busy: string | null;
  onSave: (formData: FormData) => Promise<void>;
  onCheck: (role: ServerRole) => Promise<void>;
}

function ServerPanel(props: ServerPanelProps) {
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
              <Input name="sshUser" defaultValue={props.server?.ssh_user || 'root'} placeholder="root" />
            </Field>
            <Field label="SSH key">
              <Input name="sshKeyPath" defaultValue={props.server?.ssh_key_path || '~/.ssh/id_ed25519'} />
            </Field>
          </div>
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
          {props.server?.status_message || 'Not checked yet.'}
        </p>
      </CardContent>
    </Card>
  );
}

interface BackupPanelProps {
  backup: {
    enabled: boolean;
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretConfigured: boolean;
    path: string;
  };
  busy: boolean;
  onSave: (formData: FormData) => Promise<void>;
}

function BackupPanel(props: BackupPanelProps) {
  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.onSave(new FormData(event.currentTarget));
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>Backups</CardTitle>
          <CardDescription>pgBackRest storage</CardDescription>
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

interface JobsPanelProps {
  jobs: Array<{
    id: number;
    type: string;
    status: string;
    error: string | null;
    updatedAt: string;
    logs: Array<{
      id: number;
      level: 'info' | 'error';
      message: string;
    }>;
  }>;
  activeJobs: number;
}

function JobsPanel(props: JobsPanelProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>Jobs</CardTitle>
          <CardDescription>Recent background work</CardDescription>
        </div>
        <Badge variant={props.activeJobs > 0 ? 'info' : 'secondary'}>{props.activeJobs} active</Badge>
      </CardHeader>
      <CardContent>
        {props.jobs.length === 0 ? (
          <EmptyState icon={Clock3} title="No jobs yet" detail="Setup and branch actions will appear here." compact />
        ) : (
          <div className="grid gap-3">
            {props.jobs.map(function renderJob(job) {
              return (
                <div className="rounded-lg border bg-muted/20 p-3" key={job.id}>
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-sm font-medium">{job.type}</p>
                    <StatusBadge status={job.status} />
                  </div>
                  <p className="mt-2 truncate text-xs text-muted-foreground">{job.error || job.updatedAt}</p>
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
          </div>
        )}
      </CardContent>
    </Card>
  );
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

    await copyToClipboard(value);
    setCopied(true);
    window.setTimeout(function resetCopied() {
      setCopied(false);
    }, 1200);
  }

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
      <code className="min-w-0 truncate rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
        {value || 'not ready'}
      </code>
      <Button type="button" size="icon" variant="outline" onClick={copyValue} disabled={!value} title="Copy connection string">
        {copied ? <CheckCircle2 className="text-emerald-600" /> : <Copy />}
      </Button>
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
      <div className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <p className="mt-3 text-sm font-medium">{props.title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{props.detail}</p>
    </div>
  );
}

function StepIcon(props: { status: string; index: number }) {
  if (props.status === 'done') {
    return (
      <div className="grid size-8 shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100">
        <CheckCircle2 className="size-4" />
      </div>
    );
  }

  if (props.status === 'running') {
    return (
      <div className="grid size-8 shrink-0 place-items-center rounded-full bg-blue-50 text-blue-700 ring-1 ring-blue-100">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  if (props.status === 'error') {
    return (
      <div className="grid size-8 shrink-0 place-items-center rounded-full bg-red-50 text-red-700 ring-1 ring-red-100">
        <AlertTriangle className="size-4" />
      </div>
    );
  }

  return (
    <div className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
      {props.index}
    </div>
  );
}

function StatusBadge(props: { status: string }) {
  const variant = getStatusVariant(props.status);
  const Icon = getStatusIcon(props.status);

  return (
    <Badge variant={variant} className="capitalize">
      <Icon className={cn('size-3', props.status === 'creating' && 'animate-spin')} />
      {props.status}
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

  if (status === 'error' || status === 'stopped') {
    return 'destructive';
  }

  return 'warning';
}

function getStatusIcon(status: string) {
  if (status === 'ok' || status === 'done' || status === 'ready') {
    return CheckCircle2;
  }

  if (status === 'creating') {
    return Loader2;
  }

  if (status === 'running') {
    return Activity;
  }

  if (status === 'error' || status === 'stopped') {
    return AlertTriangle;
  }

  return Clock3;
}
