import { Activity, AlertTriangle, Eye, Loader2, RefreshCw } from 'lucide-react';
import { cn } from '#lib/utils';
import { Badge } from '#web/components/ui/badge';
import { Button } from '#web/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#web/components/ui/card';
import type { ControlPlaneState } from '#web/lib/api-client';
import { formatRelativeTime } from '#web/lib/time';

type BackupAvailability = ControlPlaneState['backupAvailability'];
type BackupPoint = BackupAvailability['backups'][number];
type BackupJob = ControlPlaneState['jobs'][number];

export interface BackupHealthPanelProps {
  availability: BackupAvailability;
  checkedAt: string | null;
  checking?: boolean;
  jobs: BackupJob[];
  onRefresh: () => void;
  onOpenJob: (jobId: number) => void;
}

export function BackupHealthPanel(props: BackupHealthPanelProps) {
  const healthy = props.availability.status === 'ok';
  const latestBackup = props.availability.backups[0] || null;
  const backupJob = findBackupJob(props.jobs);
  const showBackupJob = backupJob && (backupJob.status === 'queued' || backupJob.status === 'running' || backupJob.status === 'error');

  return (
    <Card>
      <CardHeader className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
        <div className="flex min-w-0 gap-3">
          <div className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', healthy ? 'bg-emerald-500' : 'bg-destructive')} />
          <div className="min-w-0">
            <CardTitle>{healthy ? 'Backups are working' : 'Backups need attention'}</CardTitle>
            <CardDescription>{formatBackupHealthSummary(props.availability, latestBackup)}</CardDescription>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={props.checking} onClick={props.onRefresh}>
          {props.checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Check
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3">
        {props.availability.message ? (
          <div className="flex gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>{props.availability.message}</p>
          </div>
        ) : null}

        {showBackupJob ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/20 p-3">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">Settings update</p>
                <BackupJobStatus status={backupJob.status} />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {backupJob.error || `updated ${formatRelativeTime(backupJob.updatedAt)}`}
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={function openBackupJob() {
              props.onOpenJob(backupJob.id);
            }}>
              <Eye />
              View
            </Button>
          </div>
        ) : null}

        <div className="border-y border-border">
          <BackupHealthRow
            label="Last backup"
            value={latestBackup ? formatRelativeTime(latestBackup.completedAt) : 'none found'}
            detail={latestBackup ? latestBackup.label : 'no successful backup yet'}
          />
          <BackupHealthRow
            label="Restore window"
            value={props.availability.pitr.from && props.availability.pitr.to ? 'available' : 'not available'}
            detail={formatPitrWindow(props.availability)}
          />
          <BackupHealthRow
            label="Continuous recovery"
            value={formatArchiveValue(props.availability)}
            detail={formatArchiveDetail(props.availability)}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Last checked {formatRelativeTime(props.checkedAt)}
          </p>
          {props.availability.backups.length > 0 ? (
            <p className="truncate text-xs text-muted-foreground">
              {props.availability.backups.length} backup{props.availability.backups.length === 1 ? '' : 's'} found
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function BackupHealthRow(props: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="grid gap-1 border-t border-border py-3 first:border-t-0 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
      <p className="text-xs font-medium text-muted-foreground">{props.label}</p>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{props.value}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{props.detail}</p>
      </div>
    </div>
  );
}

function BackupJobStatus(props: { status: string }) {
  return (
    <Badge variant={getJobStatusVariant(props.status)} className="capitalize">
      <Activity className={cn('size-3', props.status === 'running' && 'animate-pulse')} />
      {props.status}
    </Badge>
  );
}

function getJobStatusVariant(status: string) {
  if (status === 'done' || status === 'running') {
    return 'success';
  }

  if (status === 'error') {
    return 'destructive';
  }

  return 'warning';
}

function formatBackupHealthSummary(availability: BackupAvailability, latestBackup: BackupPoint | null): string {
  if (availability.status !== 'ok') {
    return availability.message || 'Backup status could not be verified.';
  }

  if (!latestBackup) {
    return 'Backup storage is reachable, but no backup has completed yet.';
  }

  if (availability.pitr.from && availability.pitr.to) {
    return `Last backup completed ${formatRelativeTime(latestBackup.completedAt)}. Restore points are available.`;
  }

  return `Last backup completed ${formatRelativeTime(latestBackup.completedAt)}. Waiting for restore points.`;
}

function findBackupJob(jobs: BackupJob[]): BackupJob | null {
  const backupJobs = jobs.filter(function isBackupJob(job) {
    return job.type === 'backup-reconfigure';
  });

  return backupJobs.find(function isActiveBackupJob(job) {
    return job.status === 'queued' || job.status === 'running';
  }) || backupJobs[0] || null;
}

function formatPitrWindow(availability: BackupAvailability): string {
  if (!availability.pitr.from || !availability.pitr.to) {
    return availability.message || 'waiting for backup history';
  }

  return `${formatBackupDate(availability.pitr.from)} to ${formatBackupDate(availability.pitr.to)}`;
}

function formatArchiveValue(availability: BackupAvailability): string {
  if (availability.archive?.lastArchivedAt) {
    return availability.archive.failedCount && availability.archive.failedCount > 0 ? 'active with failures' : 'active';
  }

  return availability.status === 'ok' ? 'ok' : 'unknown';
}

function formatArchiveDetail(availability: BackupAvailability): string {
  if (availability.archive?.lastArchivedAt) {
    const failedCount = availability.archive.failedCount || 0;
    return `last archived ${formatRelativeTime(availability.archive.lastArchivedAt)} · ${failedCount} failed`;
  }

  return availability.status === 'ok' ? 'backup history is readable' : 'archive status unavailable';
}

function formatBackupDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}
