import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export type Timestamp = ColumnType<string, string | undefined, string>;

export interface SettingsTable {
  key: string;
  value: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ServersTable {
  id: Generated<number>;
  role: 'prod' | 'dev';
  host: string;
  sshUser: string;
  sshKeyPath: string;
  status: 'unknown' | 'ok' | 'error';
  statusMessage: string | null;
  lastCheckedAt: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface SetupStepsTable {
  id: Generated<number>;
  key: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'stale';
  message: string | null;
  failedJobId: number | null;
  updatedAt: Timestamp;
}

export interface ProjectsTable {
  id: Generated<number>;
  name: string;
  postgresVersion: string;
  databaseName: string;
  appUser: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface BranchesTable {
  id: Generated<number>;
  projectId: number;
  slug: string;
  displayName: string;
  dataset: string;
  port: number | null;
  proxyPort: number | null;
  backendPort: number | null;
  status: 'creating' | 'running' | 'stopped' | 'error';
  parentBranchId: number | null;
  sourceReplayAt: string | null;
  expiresAt: string | null;
  connectionUrl: string | null;
  lastActiveAt: string | null;
  stoppedAt: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface JobsTable {
  id: Generated<number>;
  type: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  inputJson: string | null;
  error: string | null;
  attempts: Generated<number>;
  maxAttempts: Generated<number>;
  runAfter: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  heartbeatAt: string | null;
  createdAt: Timestamp;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: Timestamp;
}

export interface JobLogsTable {
  id: Generated<number>;
  jobId: number;
  level: 'info' | 'error';
  message: string;
  createdAt: Timestamp;
}

export interface DB {
  settings: SettingsTable;
  servers: ServersTable;
  setupSteps: SetupStepsTable;
  projects: ProjectsTable;
  branches: BranchesTable;
  jobs: JobsTable;
  jobLogs: JobLogsTable;
}

export type Setting = Selectable<SettingsTable>;
export type NewSetting = Insertable<SettingsTable>;
export type SettingUpdate = Updateable<SettingsTable>;

export type Server = Selectable<ServersTable>;
export type NewServer = Insertable<ServersTable>;
export type ServerUpdate = Updateable<ServersTable>;

export type SetupStep = Selectable<SetupStepsTable>;
export type NewSetupStep = Insertable<SetupStepsTable>;
export type SetupStepUpdate = Updateable<SetupStepsTable>;

export type Project = Selectable<ProjectsTable>;
export type NewProject = Insertable<ProjectsTable>;
export type ProjectUpdate = Updateable<ProjectsTable>;

export type Branch = Selectable<BranchesTable>;
export type NewBranch = Insertable<BranchesTable>;
export type BranchUpdate = Updateable<BranchesTable>;

export type Job = Selectable<JobsTable>;
export type NewJob = Insertable<JobsTable>;
export type JobUpdate = Updateable<JobsTable>;

export type JobLog = Selectable<JobLogsTable>;
export type NewJobLog = Insertable<JobLogsTable>;
export type JobLogUpdate = Updateable<JobLogsTable>;
