export const OPEN_API_TAGS = {
  branches: 'Branches',
  recovery: 'Recovery',
  data: 'Data',
  apiKeys: 'API Keys',
  dashboard: 'Dashboard',
  jobs: 'Jobs',
  servers: 'Servers',
  backup: 'Backup',
  updates: 'Updates',
} as const;

export const OPEN_API_TAG_DEFINITIONS = [
  {
    name: OPEN_API_TAGS.branches,
    description: 'Create and manage database branches.',
  },
  {
    name: OPEN_API_TAGS.recovery,
    description: 'Restore branches and inspect historic data.',
  },
  {
    name: OPEN_API_TAGS.data,
    description: 'Browse tables, edit rows, and run SQL.',
  },
  {
    name: OPEN_API_TAGS.apiKeys,
    description: 'Create and revoke bearer API keys.',
  },
  {
    name: OPEN_API_TAGS.dashboard,
    description: 'Read dashboard state.',
  },
  {
    name: OPEN_API_TAGS.jobs,
    description: 'Track long-running control plane work.',
  },
  {
    name: OPEN_API_TAGS.servers,
    description: 'Configure and check Velo servers.',
  },
  {
    name: OPEN_API_TAGS.backup,
    description: 'Configure backup storage.',
  },
  {
    name: OPEN_API_TAGS.updates,
    description: 'Check and apply Velo updates.',
  },
];
