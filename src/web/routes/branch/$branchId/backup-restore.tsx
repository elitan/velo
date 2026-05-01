import { createFileRoute } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import type { ComponentType } from 'react';
import { useState } from 'react';
import {
  Calendar,
  ChevronsUpDown,
  Code2,
  Database,
  GitBranch,
  GitCompareArrows,
  Info,
  Loader2,
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
import {
  createPreviewBranchAction,
  deletePreviewBranchAction,
  getSetupState,
} from '../../../lib/actions';
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
  const createPreviewBranch = useServerFn(createPreviewBranchAction);
  const deletePreviewBranch = useServerFn(deletePreviewBranchAction);
  const params = Route.useParams();
  const branchId = params.branchId;
  const isProd = branchId === 'prod';
  const branch = isProd ? null : state.branches.find(function findBranch(item) {
    return item.name === branchId;
  });
  const selectedBranch = isProd ? 'prod' : branch?.name || branchId;
  const status = isProd ? (state.prodConnectionUrl ? 'ready' : 'pending') : branch?.status || 'missing';
  const branchOptions = getBranchOptions(state);
  const [sourceBranch, setSourceBranch] = useState(selectedBranch);
  const [restoreTime, setRestoreTime] = useState(getDefaultRestoreTime());
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBranch, setPreviewBranch] = useState<PreviewBranch | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  async function handleOpenPreview() {
    setPreviewBusy(true);
    setPreviewError(null);

    try {
      const created = await createPreviewBranch({
        data: {
          sourceBranch,
          restoreTime,
        },
      });
      setPreviewBranch(created);
      setPreviewOpen(true);
    } catch (error: any) {
      setPreviewError(error?.message || 'Could not create preview branch');
    } finally {
      setPreviewBusy(false);
    }
  }

  async function handleClosePreview() {
    const branchToDelete = previewBranch;
    setPreviewOpen(false);
    setPreviewBranch(null);

    if (!branchToDelete) {
      return;
    }

    try {
      await deletePreviewBranch({ data: { id: branchToDelete.id } });
    } catch (error: any) {
      setPreviewError(error?.message || `Could not delete preview branch ${branchToDelete.name}`);
    }
  }

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
              <p className="mt-6 max-w-2xl text-sm leading-6 text-muted-foreground">
                Choose a source branch and point in time, preview the historic data, then restore when ready.
              </p>
            </header>

            <Card className="max-w-5xl">
              <CardHeader>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex gap-4">
                    <div className="mt-1 grid size-10 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
                      <Zap className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <CardTitle>Instant point-in-time restore</CardTitle>
                      <CardDescription className="mt-2 max-w-xl">
                        Restore from any branch to any point in the past {state.backup.pitrDays} days.
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant="info">{state.backup.pitrDays} day PITR</Badge>
                </div>
              </CardHeader>

              <CardContent className="grid gap-5">
                <div className="grid gap-4 rounded-lg border border-border bg-muted/30 p-4 md:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="source-branch">Source branch</Label>
                    <div className="relative">
                      <select
                        id="source-branch"
                        className="h-10 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 text-sm font-medium outline-none ring-ring transition-shadow focus:ring-2"
                        value={sourceBranch}
                        onChange={function changeSourceBranch(event) {
                          setSourceBranch(event.target.value);
                        }}
                      >
                        {branchOptions.map(function renderBranchOption(option) {
                          return (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          );
                        })}
                      </select>
                      <ChevronsUpDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="restore-time">Point in time</Label>
                    <div className="relative">
                      <Calendar className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="restore-time"
                        type="datetime-local"
                        className="h-10 pl-9"
                        value={restoreTime}
                        onChange={function changeRestoreTime(event) {
                          setRestoreTime(event.target.value);
                        }}
                      />
                    </div>
                    <div className="text-xs text-muted-foreground">Europe/Stockholm, GMT+02:00</div>
                  </div>
                </div>

                <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
                  <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                    Preview creates a temporary read-only restore branch for the selected time. Production and dev branches stay untouched.
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={previewBusy}
                      onClick={function previewDataClick() {
                        void handleOpenPreview();
                      }}
                    >
                      {previewBusy ? <Loader2 className="animate-spin" /> : <Search />}
                      {previewBusy ? 'Creating preview' : 'Preview data'}
                    </Button>
                    <Button type="button" disabled>
                      Restore to point in time
                    </Button>
                  </div>
                </div>

                {previewError ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    {previewError}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </section>
      </div>

      {previewOpen ? (
        <HistoricPreviewModal
          branch={sourceBranch}
          branchOptions={branchOptions}
          previewBranch={previewBranch}
          restoreTime={restoreTime}
          onBranchChange={setSourceBranch}
          onClose={function closePreview() {
            void handleClosePreview();
          }}
        />
      ) : null}
    </main>
  );
}

function HistoricPreviewModal(props: {
  branch: string;
  branchOptions: BranchOption[];
  previewBranch: PreviewBranch | null;
  restoreTime: string;
  onBranchChange: (branch: string) => void;
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
              <div className="relative w-52">
                <select
                  className="h-9 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 text-sm outline-none"
                  value={props.branch}
                  onChange={function changePreviewBranch(event) {
                    props.onBranchChange(event.target.value);
                  }}
                  disabled
                >
                  {props.branchOptions.map(function renderBranchOption(option) {
                    return (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    );
                  })}
                </select>
                <ChevronsUpDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              </div>
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
              {props.previewBranch ? (
                <Badge variant="info">Preview branch: {props.previewBranch.name}</Badge>
              ) : null}
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
      <ChevronsUpDown className="size-4 text-muted-foreground" />
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

type BranchOption = {
  value: string;
  label: string;
};

type PreviewBranch = {
  id: number;
  name: string;
  connectionUrl: string;
};

function getBranchOptions(state: Awaited<ReturnType<typeof getSetupState>>) {
  return [
    {
      value: 'prod',
      label: 'prod',
    },
    ...state.branches.map(function mapBranch(branch) {
      return {
        value: branch.name,
        label: branch.name,
      };
    }),
  ];
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
