import { createFileRoute } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { useState } from 'react';
import {
  Calendar,
  Code2,
  Database,
  GitBranch,
  GitCompareArrows,
  Info,
  Search,
  Table2,
  X,
  Zap,
} from 'lucide-react';
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
  const branchId = params.branchId;
  const isProd = branchId === 'prod';
  const branch = isProd ? null : state.branches.find(function findBranch(item) {
    return item.name === branchId;
  });
  const selectedBranch = isProd ? 'prod' : branch?.name || branchId;
  const status = isProd ? (state.prodConnectionUrl ? 'ready' : 'pending') : branch?.status || 'missing';
  const [restoreTime, setRestoreTime] = useState(getDefaultRestoreTime());
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[244px_1fr]">
        <AppSidebar branches={state.branches} activeBranchPage="backup" selectedBranch={selectedBranch} />

        <section className="min-w-0">
          <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <header>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{isProd ? 'Production' : 'Development'}</Badge>
                <StatusBadge status={status} />
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">Backup & Restore</h1>
              <div className="mt-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <GitBranch className="size-4" />
                <span>{selectedBranch}</span>
              </div>
              <p className="mt-6 max-w-3xl text-sm leading-6 text-muted-foreground">
                Restore this branch to a point in time, preview historic data first, and keep production recovery simple.
              </p>
            </header>

            <Card>
              <CardHeader className="border-b-0 pb-0">
                <div className="flex gap-4">
                  <div className="mt-1 grid size-10 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
                    <Zap className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <CardTitle>Instant point-in-time restore</CardTitle>
                    <CardDescription className="mt-2">
                      Restore this branch to any point in the past {state.backup.pitrDays} days.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="grid gap-5 pt-5">
                <div className="border-t border-border" />

                <div className="grid gap-4 lg:grid-cols-[minmax(0,260px)_minmax(0,300px)_1fr] lg:items-end">
                  <div className="grid gap-2">
                    <Label htmlFor="source-branch">Source branch</Label>
                    <select
                      id="source-branch"
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-ring transition-shadow focus:ring-2"
                      value={selectedBranch}
                      disabled
                    >
                      <option>{selectedBranch}</option>
                    </select>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="restore-time">Point in time</Label>
                    <div className="relative">
                      <Calendar className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="restore-time"
                        type="datetime-local"
                        className="pl-9"
                        value={restoreTime}
                        onChange={function changeRestoreTime(event) {
                          setRestoreTime(event.target.value);
                        }}
                      />
                    </div>
                    <div className="text-xs text-muted-foreground">Europe/Stockholm, GMT+02:00</div>
                  </div>

                  <div className="flex flex-col gap-2 sm:flex-row lg:justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={function openPreview() {
                        setPreviewOpen(true);
                      }}
                    >
                      <Search />
                      Preview data
                    </Button>
                    <Button type="button" disabled>
                      Restore to point in time
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>
      </div>

      {previewOpen ? (
        <HistoricPreviewModal
          branch={selectedBranch}
          restoreTime={restoreTime}
          onClose={function closePreview() {
            setPreviewOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}

function HistoricPreviewModal(props: {
  branch: string;
  restoreTime: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'browse' | 'query' | 'compare'>('browse');
  const historicTime = formatHistoricTime(props.restoreTime);

  return (
    <div className="fixed inset-0 z-50 bg-background/80 p-3 backdrop-blur-sm">
      <div className="grid h-full grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl">
        <div className="flex flex-col gap-3 border-b border-border px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-normal">Preview historic data</h2>
            <div className="mt-3 flex flex-wrap items-start gap-2">
              <select
                className="h-9 w-52 rounded-md border border-input bg-background px-3 text-sm outline-none"
                value={props.branch}
                disabled
              >
                <option>{props.branch}</option>
              </select>
              <div>
                <div className="relative w-64">
                  <Calendar className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input className="pl-9" type="datetime-local" value={props.restoreTime} readOnly />
                </div>
                <div className="mt-1 text-xs text-muted-foreground">Europe/Stockholm, GMT+02:00</div>
              </div>
              <div className="flex rounded-md border border-border p-0.5">
                <PreviewTab active={tab === 'browse'} label="Browse data" onClick={function selectBrowse() { setTab('browse'); }} />
                <PreviewTab active={tab === 'query'} label="Query data" onClick={function selectQuery() { setTab('query'); }} />
                <PreviewTab active={tab === 'compare'} label="Compare schemas" onClick={function selectCompare() { setTab('compare'); }} />
              </div>
            </div>
          </div>

          <Button type="button" variant="outline" size="icon" onClick={props.onClose} aria-label="Close preview">
            <X />
          </Button>
        </div>

        <div className="flex items-center justify-center gap-2 bg-blue-600 px-4 py-2 text-sm font-medium text-white">
          <Info className="size-4" />
          <span>You are viewing data as it existed at {historicTime}</span>
        </div>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[280px_1fr]">
          <aside className="grid min-h-0 border-b border-border px-4 py-5 lg:border-b-0 lg:border-r">
            <div>
              <h3 className="text-xl font-semibold tracking-normal">Tables</h3>
              <div className="mt-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <GitBranch className="size-4" />
                <span>{props.branch}</span>
              </div>

              <div className="mt-5 grid gap-3">
                <SelectShell icon={Database} label="postgres" />
                <SelectShell icon={Table2} label="public" />
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input className="pl-9" placeholder="Search..." />
                </div>
              </div>
            </div>
          </aside>

          <section className="min-h-[360px] p-6">
            {tab === 'browse' ? (
              <PreviewEmptyState
                icon={Table2}
                title="Historic tables will appear here"
                description="Preview will use a temporary read-only restore branch, then remove it after you close this modal."
              />
            ) : null}

            {tab === 'query' ? (
              <QueryPreviewPanel />
            ) : null}

            {tab === 'compare' ? (
              <PreviewEmptyState
                icon={GitCompareArrows}
                title="Compare current and historic schema"
                description="Use this before restore to see what changed between now and the selected time."
              />
            ) : null}
          </section>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-4">
          <Button type="button" variant="outline" onClick={props.onClose}>Cancel</Button>
          <Button type="button" disabled>Proceed to restore</Button>
        </div>
      </div>
    </div>
  );
}

function PreviewTab(props: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={props.active ? 'h-8 rounded-sm bg-secondary px-3 text-sm font-medium text-secondary-foreground' : 'h-8 rounded-sm px-3 text-sm font-medium text-muted-foreground hover:text-foreground'}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function QueryPreviewPanel() {
  return (
    <div className="grid h-full min-h-[320px] grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
      <div>
        <h3 className="text-lg font-semibold tracking-normal">Query historic data</h3>
        <p className="mt-1 text-sm text-muted-foreground">Run SQL against the temporary historic branch, not the live database.</p>
      </div>
      <textarea
        className="min-h-0 resize-none rounded-md border border-input bg-background p-3 font-mono text-sm leading-6 outline-none ring-ring transition-shadow placeholder:text-muted-foreground focus:ring-2"
        placeholder="select * from users limit 50;"
      />
      <div className="flex justify-end">
        <Button type="button" disabled>
          <Code2 />
          Run query
        </Button>
      </div>
    </div>
  );
}

function SelectShell(props: {
  icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  const Icon = props.icon;

  return (
    <div className="flex h-9 items-center justify-between rounded-md border border-input bg-background px-3 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <span className="truncate">{props.label}</span>
      </span>
      <span className="text-muted-foreground">⌄</span>
    </div>
  );
}

function PreviewEmptyState(props: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  const Icon = props.icon;

  return (
    <div className="grid h-full min-h-[320px] place-items-center">
      <div className="max-w-md text-center">
        <div className="mx-auto grid size-11 place-items-center rounded-md border border-border bg-muted">
          <Icon className="size-5 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-lg font-semibold tracking-normal">{props.title}</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{props.description}</p>
      </div>
    </div>
  );
}

function getDefaultRestoreTime() {
  const date = new Date(Date.now() - 5 * 60 * 1000);
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);

  return offsetDate.toISOString().slice(0, 16);
}

function formatHistoricTime(value: string) {
  if (!value) {
    return 'the selected time';
  }

  const date = new Date(value);

  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}
