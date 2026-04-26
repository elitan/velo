export interface State {
  version: string;
  initializedAt: string;
  zfsPool: string;
  zfsDatasetBase: string;
  projects: Project[];
  snapshots: Snapshot[];
}

export interface Project {
  id: string;
  name: string;
  dockerImage: string;           // Docker image used (e.g., postgres:17-alpine, ankane/pgvector:17)
  postgresVersion?: string;      // Optional, for display purposes only
  sslCertDir: string;            // Path to SSL certificates directory
  createdAt: string;
  credentials: Credentials;
  branches: Branch[];
}

export interface Branch {
  id: string;
  name: string;                              // Namespaced name: <project>/<branch>
  projectName: string;                       // Parent project name
  parentBranchId: string | null;             // null for main branch
  isPrimary: boolean;                        // true for main branch, false for others
  snapshotName: string | null;               // null for main branch
  zfsDataset: string;                        // ZFS dataset name (e.g., api.dev)
  containerName?: string;
  port: number;
  createdAt: string;
  status: 'running' | 'stopped' | 'created';
  sizeBytes?: number;                        // Dataset size in bytes (optional, populated on create/reset)
}

export interface Credentials {
  username: string;
  password: string;
  database: string;
}

export interface Snapshot {
  id: string;
  branchId: string;
  branchName: string;  // Namespaced: <project>/<branch>
  projectName: string;
  zfsSnapshot: string; // Full ZFS snapshot name with @
  createdAt: string;
  label?: string;      // Optional user label
  sizeBytes?: number;  // Snapshot size in bytes (optional)
}
