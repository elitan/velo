import chalk from 'chalk';
import { ZFSManager } from '../../managers/zfs';
import { DockerManager } from '../../managers/docker';
import { StateManager } from '../../managers/state';
import { WALManager } from '../../managers/wal';
import { CertManager } from '../../managers/cert';
import { generateUUID, generatePassword } from '../../utils/helpers';
import type { Project, Branch } from '../../types/state';
import { PATHS } from '../../utils/paths';
import { buildNamespace, validateName } from '../../utils/namespace';
import { DEFAULTS } from '../../config/defaults';
import { getZFSPool } from '../../utils/zfs-pool';
import { validateAllPermissions } from '../../utils/zfs-permissions';
import { requireSetup } from '../../utils/setup-check';
import { UserError } from '../../errors';
import { withProgress } from '../../utils/progress';
import * as fs from 'fs/promises';
import { getContainerName, getDatasetName } from '../../utils/naming';
import { getPublicIP, formatConnectionString } from '../../utils/network';
import { ResourceService } from '../../services/resource-service';
import { OperationRunner } from '../../utils/operation-runner';

interface CreateOptions {
  pool?: string;
  version?: string;
  image?: string;
}

export async function projectCreateCommand(name: string, options: CreateOptions = {}) {
  // Validate name FIRST before any operations
  validateName(name, 'project');

  // Check if setup has been completed
  await requireSetup();

  // Validate flags
  if (options.version && options.image) {
    throw new UserError(
      'Cannot specify both --version and --image',
      'Use one or the other'
    );
  }

  // Determine Docker image to use
  let dockerImage: string;
  if (options.image) {
    dockerImage = options.image;
  } else if (options.version) {
    dockerImage = `postgres:${options.version}-alpine`;
  } else {
    dockerImage = DEFAULTS.postgres.defaultImage;
  }

  console.log();
  console.log(`Creating project ${chalk.bold(name)}...`);
  console.log();

  // Load state
  const state = new StateManager(PATHS.STATE);
  await state.load();

  // Auto-detect or validate ZFS pool
  let pool: string;
  if (options.pool) {
    pool = await withProgress(`Validate ZFS pool ${options.pool}`, async () => {
      return await getZFSPool(options.pool);
    });
  } else {
    pool = await withProgress('Detect ZFS pool', async () => {
      return await getZFSPool();
    });
  }

  // Validate permissions before proceeding
  await withProgress('Validate permissions', async () => {
    await validateAllPermissions(pool, DEFAULTS.zfs.datasetBase);
  });

  // Auto-initialize state if needed (first project create)
  if (!state.isInitialized()) {
    await withProgress('Initialize velo', async () => {
      // Create WAL archive directory
      await fs.mkdir(PATHS.WAL_ARCHIVE, { recursive: true });

      // Initialize state
      await state.autoInitialize(pool, DEFAULTS.zfs.datasetBase);
    });
  }

  // Check if project already exists
  const existing = state.projects.getByName(name);
  if (existing) {
    throw new UserError(`Project '${name}' already exists`);
  }

  // Get ZFS config from state
  const stateData = state.getState();
  const fullDatasetBase = stateData.zfsDatasetBase; // e.g., "velo/databases"

  // Initialize managers
  const zfs = new ZFSManager(pool, fullDatasetBase);
  const docker = new DockerManager();
  const wal = new WALManager();
  const cert = new CertManager();
  const resources = new ResourceService(docker, zfs, wal);

  // Use port 0 to let Docker dynamically assign an available port
  let port = 0;

  // Create ZFS dataset for main branch
  const mainBranchName = buildNamespace(name, 'main');
  const mainDatasetName = getDatasetName(name, 'main');
  const mainContainerName = getContainerName(name, 'main');

  const operation = new OperationRunner();

  let password = '';
  let certPaths: { certDir: string };
  let containerID: string;
  let sizeBytes: number;

  await operation.run(async function runOperation() {
    await operation.step(`Create dataset ${mainBranchName}`, async function createDataset() {
      await zfs.createDataset(mainDatasetName, {
        compression: DEFAULTS.zfs.compression,
        recordsize: DEFAULTS.zfs.recordsize,
        atime: DEFAULTS.zfs.atime,
      });
    }, async function rollbackDataset() {
      await resources.destroyDataset(mainDatasetName);
    });

    // Mount the dataset (requires sudo on Linux due to kernel restrictions)
    await operation.step('Mount dataset', async function mountDataset() {
      await zfs.mountDataset(mainDatasetName);
    });

    // Get dataset mountpoint
    const mountpoint = await zfs.getMountpoint(mainDatasetName);

    // Generate SSL certificates
    certPaths = await operation.step('Generate SSL certificates', async function generateCerts() {
      return await cert.generateCerts(name);
    }, async function rollbackCerts() {
      await cert.deleteCerts(name);
    });

    // Generate credentials
    password = generatePassword();

    // Pull PostgreSQL image if needed (no rollback - images can be reused)
    const imageExists = await docker.imageExists(dockerImage);
    if (!imageExists) {
      await operation.step(`Pull ${dockerImage}`, async function pullImage() {
        await docker.pullImage(dockerImage);
      });
    }

    const walArchivePath = await operation.step('Prepare WAL archive', async function prepareWalArchive() {
      return await resources.recreateWalArchive(mainDatasetName);
    }, async function rollbackWalArchive() {
      await resources.deleteWalArchive(mainDatasetName);
    });

    // Create and start Docker container for main branch
    containerID = await operation.step('PostgreSQL ready', async function startPostgres() {
      const id = await docker.createContainer({
        name: mainContainerName,
        image: dockerImage,
        port,
        dataPath: mountpoint,
        walArchivePath,
        sslCertDir: certPaths.certDir,
        password,
        username: 'postgres',
        database: 'postgres',
      });

      operation.addRollback(async function rollbackContainer() {
        await docker.removeContainer(id);
      });

      await docker.startContainer(id);
      await docker.waitForHealthy(id);

      return id;
    });

    // Get the dynamically assigned port from Docker
    port = await docker.getContainerPort(containerID);

    // Get dataset size
    sizeBytes = await zfs.getUsedSpace(mainDatasetName);

    // Create main branch
    const mainBranch: Branch = {
      id: generateUUID(),
      name: mainBranchName,
      projectName: name,
      parentBranchId: null, // main has no parent
      isPrimary: true,
      snapshotName: null, // main has no snapshot
      zfsDataset: mainDatasetName,
      containerName: mainContainerName,
      port,
      createdAt: new Date().toISOString(),
      sizeBytes,
      status: 'running',
    };

    // Create project record with main branch
    const project: Project = {
      id: generateUUID(),
      name: name,
      dockerImage,
      sslCertDir: certPaths.certDir,
      createdAt: new Date().toISOString(),
      credentials: {
        username: 'postgres',
        password,
        database: 'postgres',
      },
      branches: [mainBranch],
    };

    await state.projects.add(project);
  });

  // Get public IP for remote connection info
  const publicIP = await getPublicIP();

  console.log();
  console.log(chalk.bold(`Project '${name}' created`));
  console.log();
  console.log(chalk.bold('Connection:'));
  console.log(formatConnectionString(
    'postgres',
    password,
    port,
    'postgres',
    publicIP
  ));
  console.log();
}
