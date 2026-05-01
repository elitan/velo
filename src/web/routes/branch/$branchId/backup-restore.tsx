import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ArchiveRestore, Clock3, DatabaseBackup, RefreshCw, ShieldAlert } from 'lucide-react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { getSetupState } from '../../../lib/actions';
import {
  AppSidebar,
  MetricCard,
  StatusBadge,
} from '../../index';

export const Route = createFileRoute('/branch/$branchId/backup-restore')({
  loader: function loader() {
    return getSetupState();
  },
  component: BackupRestorePage,
});

function BackupRestorePage() {
  const state = Route.useLoaderData();
  const params = Route.useParams();
  const router = useRouter();
  const branchId = params.branchId;
  const isProd = branchId === 'prod';
  const branch = isProd ? null : state.branches.find(function findBranch(item) {
    return item.name === branchId;
  });
  const selectedBranch = isProd ? 'prod' : branch?.name || branchId;
  const activeJobs = state.jobs.filter(function isActive(job) {
    return job.status === 'queued' || job.status === 'running';
  }).length;
  const backupsStep = state.setupSteps.find(function findBackupsStep(step) {
    return step.key === 'backups';
  });
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

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeBranchPage="backup" selectedBranch={selectedBranch} />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{isProd ? 'Production' : 'Development'}</Badge>
                  <StatusBadge status={backupsStep?.status || 'pending'} />
                </div>
                <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">Backup & Restore</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Restore production to a safe branch, or recover production itself when needed.
                </p>
              </div>
              <Button variant="outline" onClick={function refreshPage() { void router.invalidate(); }}>
                <RefreshCw />
                Refresh
              </Button>
            </header>

            <section className="grid gap-3 sm:grid-cols-3">
              <MetricCard title="PITR window" value={`${state.backup.pitrDays} days`} detail="point-in-time restore" icon={Clock3} tone="blue" />
              <MetricCard title="Full backups" value="Daily" detail={`${state.backup.fullBackupRetentionDays} days retained`} icon={DatabaseBackup} tone="emerald" />
              <MetricCard title="Repository" value={backupMode} detail={state.backup.bucket || 'not configured'} icon={ArchiveRestore} tone="violet" />
            </section>

            <div className="grid gap-6 xl:grid-cols-2">
              <RestoreActionCard
                title="Restore prod to a new branch"
                description="Safest path. Creates a writable dev branch from production at a selected time. Production stays untouched."
                button="Create restore branch"
                tone="safe"
              />
              <RestoreActionCard
                title="Restore production"
                description="High risk. Replaces production with a selected backup or point in time. This needs an explicit confirmation flow."
                button="Start prod restore"
                tone="danger"
              />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function RestoreActionCard(props: {
  title: string;
  description: string;
  button: string;
  tone: 'safe' | 'danger';
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label>Restore time</Label>
          <Input type="datetime-local" />
        </div>
        <div className="grid gap-2">
          <Label>Branch name</Label>
          <Input placeholder="restore-incident-1" disabled={props.tone === 'danger'} />
        </div>
        <Button type="button" variant={props.tone === 'danger' ? 'destructive' : 'default'} disabled>
          {props.tone === 'danger' ? <ShieldAlert /> : <ArchiveRestore />}
          {props.button}
        </Button>
      </CardContent>
    </Card>
  );
}
