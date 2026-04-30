import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import {
  checkServerAction,
  createBranchAction,
  createReplicaBaseAction,
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

function HomePage() {
  const state = Route.useLoaderData();
  const router = useRouter();
  const saveServer = useServerFn(saveServerAction);
  const checkServer = useServerFn(checkServerAction);
  const runDevBootstrap = useServerFn(runDevBootstrapAction);
  const runProdBootstrap = useServerFn(runProdBootstrapAction);
  const saveBackupSettings = useServerFn(saveBackupSettingsAction);
  const createBranch = useServerFn(createBranchAction);
  const createReplicaBase = useServerFn(createReplicaBaseAction);
  const [busy, setBusy] = useState<string | null>(null);

  async function handleSave(formData: FormData) {
    const role = formData.get('role') === 'prod' ? 'prod' : 'dev';
    setBusy(`save-${role}`);
    await saveServer({
      data: {
        role,
        host: String(formData.get('host') || ''),
        sshUser: String(formData.get('sshUser') || ''),
        sshKeyPath: String(formData.get('sshKeyPath') || ''),
      },
    });
    await router.invalidate();
    setBusy(null);
  }

  async function handleSaveBackup(formData: FormData) {
    setBusy('save-backup');
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
    await router.invalidate();
    setBusy(null);
  }

  async function handleCheck(role: 'prod' | 'dev') {
    setBusy(`check-${role}`);
    await checkServer({ data: { role } });
    await router.invalidate();
    setBusy(null);
  }

  async function handleBootstrap(kind: 'prod' | 'dev') {
    setBusy(`bootstrap-${kind}`);
    if (kind === 'prod') {
      await runProdBootstrap();
    } else {
      await runDevBootstrap();
    }
    await router.invalidate();
    setBusy(null);
  }

  async function handleCreateBranch(formData: FormData) {
    const name = String(formData.get('name') || '');
    setBusy('create-branch');
    await createBranch({ data: { name } });
    await router.invalidate();
    setBusy(null);
  }

  async function handleCreateReplica() {
    setBusy('create-replica');
    await createReplicaBase();
    await router.invalidate();
    setBusy(null);
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

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">Velo</p>
          <h1>Control plane</h1>
          <p className="subhead">Stable prod, fast dev branches, one place to see every connection.</p>
        </div>
        <div className="pill">mvp</div>
      </header>

      <section className="summaryGrid">
        <Metric label="setup" value={`${doneSteps}/${state.setupSteps.length}`} detail="steps done" />
        <Metric label="servers" value={`${okServers}/2`} detail="healthy" />
        <Metric label="branches" value={String(state.branches.length)} detail="ready to use" />
        <Metric label="jobs" value={String(activeJobs)} detail="active now" />
      </section>

      <div className="workspaceGrid">
        <div className="mainStack">
          <section className="section">
            <div className="sectionHeader">
              <h2>Connections</h2>
              <span className="muted">{state.branches.length + (state.prodConnectionUrl ? 1 : 0)} available</span>
            </div>
            <div className="connectionList">
              <ConnectionRow
                name="Production"
                status={state.prodConnectionUrl ? 'ready' : 'pending'}
                url={state.prodConnectionUrl}
              />
              {state.branches.map(function renderBranchConnection(branch) {
                return (
                  <ConnectionRow
                    key={branch.id}
                    name={branch.name}
                    status={branch.status}
                    url={branch.connectionUrl}
                  />
                );
              })}
            </div>
          </section>

          <section className="section">
            <div className="sectionHeader">
              <h2>Setup</h2>
              <div className="actions">
                <button
                  className="secondary"
                  onClick={function clickDevBootstrap() {
                    void handleBootstrap('dev');
                  }}
                  disabled={busy === 'bootstrap-dev'}
                >
                  {busy === 'bootstrap-dev' ? 'running dev' : 'setup dev'}
                </button>
                <button
                  className="secondary"
                  onClick={function clickProdBootstrap() {
                    void handleBootstrap('prod');
                  }}
                  disabled={busy === 'bootstrap-prod' || !prodServer}
                >
                  {busy === 'bootstrap-prod' ? 'running prod' : 'setup prod'}
                </button>
                <button
                  className="secondary"
                  onClick={function clickCreateReplica() {
                    void handleCreateReplica();
                  }}
                  disabled={busy === 'create-replica' || !prodServer}
                >
                  {busy === 'create-replica' ? 'creating replica' : 'create replica'}
                </button>
              </div>
            </div>
            <div className="steps">
              {state.setupSteps.map(function renderStep(step, index) {
                return (
                  <div className="step" key={step.key}>
                    <span className="stepNumber">{index + 1}</span>
                    <div>
                      <div className="stepTitle">
                        <strong>{step.label}</strong>
                        <span className={`status ${step.status}`}>{step.status}</span>
                      </div>
                      <p>{step.message || 'waiting'}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="section">
            <div className="sectionHeader">
              <h2>Branches</h2>
              <BranchCreateForm busy={busy === 'create-branch'} onCreate={handleCreateBranch} />
            </div>
            {state.branches.length === 0 ? (
              <div className="empty">No branches yet. Create the replica first.</div>
            ) : (
              <div className="table">
                <div className="row rowHead">
                  <span>Name</span>
                  <span>Status</span>
                  <span>Port</span>
                  <span>Connection</span>
                </div>
                {state.branches.map(function renderBranch(branch) {
                  return (
                    <div className="row" key={branch.id}>
                      <strong>{branch.name}</strong>
                      <span className={`status ${branch.status}`}>{branch.status}</span>
                      <span>{branch.port || '-'}</span>
                      <ConnectionString value={branch.connectionUrl} />
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <aside className="sideStack">
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
        </aside>
      </div>
    </main>
  );
}

interface MetricProps {
  label: string;
  value: string;
  detail: string;
}

function Metric(props: MetricProps) {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <small>{props.detail}</small>
    </div>
  );
}

interface ConnectionRowProps {
  name: string;
  status: string;
  url: string | null;
}

function ConnectionRow(props: ConnectionRowProps) {
  return (
    <div className="connectionRow">
      <div>
        <strong>{props.name}</strong>
        <span className={`status ${props.status}`}>{props.status}</span>
      </div>
      <ConnectionString value={props.url} />
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

    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(function resetCopied() {
      setCopied(false);
    }, 1200);
  }

  return (
    <div className="connectionString">
      <code>{value || 'not ready'}</code>
      <button type="button" className="smallButton" onClick={copyValue} disabled={!value}>
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
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
  async function submitForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.onSave(new FormData(event.currentTarget));
  }

  return (
    <section className="panel">
      <div className="panelHeader">
        <h2>Backups</h2>
        <span className={`status ${props.backup.enabled ? 'ok' : 'pending'}`}>
          {props.backup.enabled ? 's3' : 'local'}
        </span>
      </div>
      <form onSubmit={submitForm} className="form">
        <label className="checkLabel">
          <input name="enabled" type="checkbox" defaultChecked={props.backup.enabled} />
          Use S3 compatible storage
        </label>
        <label>
          Endpoint
          <input name="endpoint" defaultValue={props.backup.endpoint} placeholder="https://account.r2.cloudflarestorage.com" />
        </label>
        <label>
          Bucket
          <input name="bucket" defaultValue={props.backup.bucket} placeholder="velo-dev" />
        </label>
        <div className="formGrid">
          <label>
            Region
            <input name="region" defaultValue={props.backup.region} placeholder="auto" />
          </label>
          <label>
            Path
            <input name="path" defaultValue={props.backup.path} placeholder="/prod" />
          </label>
        </div>
        <label>
          Access key
          <input name="accessKeyId" defaultValue={props.backup.accessKeyId} autoComplete="off" />
        </label>
        <label>
          Secret key
          <input
            name="secretAccessKey"
            type="password"
            placeholder={props.backup.secretConfigured ? 'configured, leave blank to keep' : ''}
            autoComplete="off"
          />
        </label>
        <button type="submit" disabled={props.busy}>{props.busy ? 'saving' : 'save backups'}</button>
      </form>
    </section>
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
    <section className="panel">
      <div className="panelHeader">
        <h2>Jobs</h2>
        <span className="muted">{props.activeJobs} active</span>
      </div>
      {props.jobs.length === 0 ? (
        <div className="empty">No jobs yet.</div>
      ) : (
        <div className="jobs">
          {props.jobs.map(function renderJob(job) {
            return (
              <div className="job" key={job.id}>
                <div className="jobHeader">
                  <strong>{job.type}</strong>
                  <span className={`status ${job.status}`}>{job.status}</span>
                </div>
                <p>{job.error || job.updatedAt}</p>
                {job.logs.length > 0 ? (
                  <div className="logs">
                    {job.logs.map(function renderLog(log) {
                      return <code className={log.level} key={log.id}>{log.message}</code>;
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

interface BranchCreateFormProps {
  busy: boolean;
  onCreate: (formData: FormData) => Promise<void>;
}

function BranchCreateForm(props: BranchCreateFormProps) {
  async function submitForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.onCreate(new FormData(event.currentTarget));
  }

  return (
    <form className="branchForm" onSubmit={submitForm}>
      <input name="name" placeholder="preview-1" />
      <button type="submit" className="secondary" disabled={props.busy}>
        {props.busy ? 'creating' : 'create branch'}
      </button>
    </form>
  );
}

interface ServerPanelProps {
  title: string;
  role: 'prod' | 'dev';
  server: {
    host: string;
    ssh_user: string;
    ssh_key_path: string;
    status: string;
    status_message: string | null;
  } | undefined;
  busy: string | null;
  onSave: (formData: FormData) => Promise<void>;
  onCheck: (role: 'prod' | 'dev') => Promise<void>;
}

function ServerPanel(props: ServerPanelProps) {
  const isSaving = props.busy === `save-${props.role}`;
  const isChecking = props.busy === `check-${props.role}`;

  async function submitForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.onSave(new FormData(event.currentTarget));
  }

  async function clickCheck() {
    await props.onCheck(props.role);
  }

  return (
    <section className="panel">
      <div className="panelHeader">
        <h2>{props.title}</h2>
        <span className={`status ${props.server?.status || 'unknown'}`}>
          {props.server?.status || 'unknown'}
        </span>
      </div>
      <form onSubmit={submitForm} className="form">
        <input type="hidden" name="role" value={props.role} />
        <label>
          Host
          <input name="host" defaultValue={props.server?.host || ''} placeholder="1.2.3.4" />
        </label>
        <label>
          SSH user
          <input name="sshUser" defaultValue={props.server?.ssh_user || 'root'} placeholder="root" />
        </label>
        <label>
          SSH key path
          <input name="sshKeyPath" defaultValue={props.server?.ssh_key_path || '~/.ssh/id_ed25519'} />
        </label>
        <div className="actions">
          <button type="submit" disabled={isSaving}>{isSaving ? 'saving' : 'save'}</button>
          <button type="button" className="secondary" onClick={clickCheck} disabled={isChecking || !props.server}>
            {isChecking ? 'checking' : 'check'}
          </button>
        </div>
      </form>
      <p className="message">{props.server?.status_message || 'Not checked yet.'}</p>
    </section>
  );
}
