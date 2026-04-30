import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { useEffect, useState } from 'react';
import { Activity, ArchiveRestore, Database, GitBranch, RefreshCw, Settings2, SlidersHorizontal } from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import {
  checkServerAction,
  getSetupState,
  saveBackupSettingsAction,
  saveServerAction,
} from '../lib/actions';
import {
  BackupPanel,
  JobsPanel,
  MetricCard,
  NavItem,
  ServerPanel,
  StatusBadge,
  SystemPanel,
  type ServerRole,
} from './index';

export const Route = createFileRoute('/settings')({
  loader: function loader() {
    return getSetupState();
  },
  component: SettingsPage,
});

function SettingsPage() {
  const state = Route.useLoaderData();
  const router = useRouter();
  const saveServer = useServerFn(saveServerAction);
  const checkServer = useServerFn(checkServerAction);
  const saveBackupSettings = useServerFn(saveBackupSettingsAction);
  const [busy, setBusy] = useState<string | null>(null);

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
  const backupMode = state.backup.enabled ? 'S3/R2' : 'local';

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

  async function runBusy(key: string, task: () => Promise<void>) {
    setBusy(key);
    try {
      await task();
      await router.invalidate();
    } finally {
      setBusy(null);
    }
  }

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

  async function handleCheck(role: ServerRole) {
    await runBusy(`check-${role}`, async function checkServerRole() {
      await checkServer({ data: { role } });
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
            <NavItem icon={Activity} label="Overview" href="/" />
            <NavItem icon={Database} label="Production" href="/prod" />
            <NavItem icon={GitBranch} label="Development" href="/dev" />
            <NavItem icon={Settings2} label="Settings" href="/settings" active />
          </div>
        </aside>

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
                  Configure servers, backup storage, and control plane defaults.
                </p>
              </div>
              <Button variant="outline" onClick={function refreshPage() { void router.invalidate(); }}>
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
                <GeneralSettingsPanel backupMode={backupMode} />
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

function GeneralSettingsPanel(props: { backupMode: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>Current control plane defaults</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SettingCell label="State" value="SQLite" />
        <SettingCell label="Web" value="TanStack Start" />
        <SettingCell label="Branching" value="ZFS COW" />
        <SettingCell label="Backups" value={props.backupMode} />
      </CardContent>
    </Card>
  );
}

function SettingCell(props: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-4">
      <p className="text-xs font-medium text-muted-foreground">{props.label}</p>
      <p className="mt-1 text-sm font-medium">{props.value}</p>
    </div>
  );
}
