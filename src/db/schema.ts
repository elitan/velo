import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export type Timestamp = ColumnType<string, string | undefined, string>;

export interface SettingsTable {
  key: string;
  value: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ServersTable {
  id: Generated<number>;
  role: 'prod' | 'dev';
  host: string;
  ssh_user: string;
  ssh_key_path: string;
  status: 'unknown' | 'ok' | 'error';
  status_message: string | null;
  last_checked_at: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SetupStepsTable {
  id: Generated<number>;
  key: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  message: string | null;
  updated_at: Timestamp;
}

export interface ProjectsTable {
  id: Generated<number>;
  name: string;
  postgres_version: string;
  database_name: string;
  app_user: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BranchesTable {
  id: Generated<number>;
  project_id: number;
  name: string;
  dataset: string;
  port: number | null;
  status: 'creating' | 'running' | 'stopped' | 'error';
  source_replay_at: string | null;
  connection_url: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface JobsTable {
  id: Generated<number>;
  type: string;
  status: 'queued' | 'running' | 'done' | 'error';
  input_json: string | null;
  error: string | null;
  created_at: Timestamp;
  started_at: string | null;
  finished_at: string | null;
  updated_at: Timestamp;
}

export interface JobLogsTable {
  id: Generated<number>;
  job_id: number;
  level: 'info' | 'error';
  message: string;
  created_at: Timestamp;
}

export interface DB {
  settings: SettingsTable;
  servers: ServersTable;
  setup_steps: SetupStepsTable;
  projects: ProjectsTable;
  branches: BranchesTable;
  jobs: JobsTable;
  job_logs: JobLogsTable;
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
