import Dockerode from 'dockerode';
import { BACKUP_LABEL_PREFIX } from '../config/constants';
import { SystemError } from '../errors';

export interface PostgresConfig {
  name: string;
  image: string;  // Full Docker image name (e.g., postgres:17-alpine, ankane/pgvector:17)
  port: number;
  dataPath: string;
  walArchivePath: string;
  sslCertDir: string;  // Path to SSL certificates directory
  password: string;
  username: string;
  database: string;
}

export interface ContainerStatus {
  id: string;
  name: string;
  state: 'running' | 'exited' | 'created' | 'paused';
  uptime: number;
  startedAt: Date | null;
}

export class DockerManager {
  private docker: Dockerode;

  constructor() {
    this.docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
  }

  // Container lifecycle
  async createContainer(config: PostgresConfig): Promise<string> {
    const container = await this.docker.createContainer({
      Image: config.image,
      name: config.name,
      Env: [
        `POSTGRES_PASSWORD=${config.password}`,
        `POSTGRES_USER=${config.username}`,
        `POSTGRES_DB=${config.database}`,
        'PGDATA=/var/lib/postgresql/data/pgdata',
      ],
      Cmd: [
        'postgres',
        '-c', 'wal_level=replica',
        '-c', 'archive_mode=on',
        '-c', "archive_command=test ! -f /wal-archive/%f && cp %p /wal-archive/%f",
        '-c', 'max_wal_senders=3',
        '-c', 'wal_keep_size=1GB',
        '-c', 'restore_command=cp /wal-archive/%f %p',
        '-c', 'ssl=on',
        '-c', 'ssl_cert_file=/etc/ssl/certs/postgresql/server.crt',
        '-c', 'ssl_key_file=/etc/ssl/certs/postgresql/server.key',
      ],
      ExposedPorts: {
        '5432/tcp': {},
      },
      HostConfig: {
        PortBindings: {
          // Bind to all interfaces (0.0.0.0) to make databases publicly accessible
          // Use port 0 to let Docker assign an available port, or use specific port if provided
          '5432/tcp': [{
            HostIp: '0.0.0.0',
            HostPort: config.port === 0 ? '' : config.port.toString()
          }],
        },
        Binds: [
          `${config.dataPath}:/var/lib/postgresql/data`,
          `${config.walArchivePath}:/wal-archive`,
          `${config.sslCertDir}:/etc/ssl/certs/postgresql:ro`,
        ],
        RestartPolicy: {
          Name: 'unless-stopped',
        },
      },
      // No health check configured - we do our own readiness checking in waitForHealthy()
      // This avoids ongoing CPU overhead from frequent health checks
    });

    return container.id;
  }

  async startContainer(containerID: string): Promise<void> {
    const container = this.docker.getContainer(containerID);
    await container.start();
  }

  async stopContainer(containerID: string, timeout = 10): Promise<void> {
    const container = this.docker.getContainer(containerID);
    await container.stop({ t: timeout });
  }

  async removeContainer(containerID: string): Promise<void> {
    const container = this.docker.getContainer(containerID);
    await container.remove({ force: true });
  }

  async restartContainer(containerID: string): Promise<void> {
    const container = this.docker.getContainer(containerID);
    await container.restart();
  }

  // Container inspection
  async getContainerStatus(containerID: string): Promise<ContainerStatus> {
    const container = this.docker.getContainer(containerID);
    const info = await container.inspect();

    return {
      id: info.Id,
      name: info.Name.replace('/', ''),
      state: info.State.Status as ContainerStatus['state'],
      uptime: info.State.StartedAt
        ? Date.now() - new Date(info.State.StartedAt).getTime()
        : 0,
      startedAt: info.State.StartedAt ? new Date(info.State.StartedAt) : null,
    };
  }

  async containerExists(name: string): Promise<boolean> {
    try {
      const containers = await this.docker.listContainers({ all: true });
      return containers.some(c => c.Names.includes(`/${name}`));
    } catch {
      return false;
    }
  }

  async getContainerByName(name: string): Promise<string | null> {
    const containers = await this.docker.listContainers({ all: true });
    const container = containers.find(c => c.Names.includes(`/${name}`));
    return container ? container.Id : null;
  }

  async getContainerPort(containerID: string): Promise<number> {
    const container = this.docker.getContainer(containerID);
    const info = await container.inspect();

    const portBinding = info.NetworkSettings.Ports['5432/tcp'];
    if (!portBinding || !portBinding[0]?.HostPort) {
      throw new SystemError('Container port binding not found');
    }

    return parseInt(portBinding[0].HostPort, 10);
  }

  async waitForHealthy(containerID: string, timeout = 120000): Promise<void> {
    const startTime = Date.now();
    const container = this.docker.getContainer(containerID);

    while (Date.now() - startTime < timeout) {
      const info = await container.inspect();

      // Container must be running first
      if (info.State.Status !== 'running') {
        await Bun.sleep(100);
        continue;
      }

      // Try pg_isready directly for fast readiness detection using Bun.spawn
      try {
        const containerName = info.Name.replace('/', '');
        const proc = Bun.spawn([
          'docker',
          'exec',
          containerName,
          'pg_isready',
          '-U', 'postgres'
        ], {
          stdout: 'pipe',
          stderr: 'pipe'
        });

        await proc.exited;

        if (proc.exitCode === 0) {
          return; // PostgreSQL is ready
        }
      } catch {
        // pg_isready failed, continue polling
      }

      await Bun.sleep(100);  // Poll every 100ms for fast detection
    }

    throw new SystemError(`Container ${containerID} failed to become healthy within ${timeout}ms`);
  }

  // Image management
  async pullImage(image: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);

        this.docker.modem.followProgress(stream, (err, output) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      const images = await this.docker.listImages();
      return images.some(img =>
        img.RepoTags?.some(tag => tag === image || tag.startsWith(image + ':'))
      );
    } catch {
      return false;
    }
  }

  // Utility
  async listContainers(filter?: Record<string, string>): Promise<ContainerStatus[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: filter ? JSON.stringify(filter) : undefined,
    });

    return containers.map(c => ({
      id: c.Id,
      name: c.Names[0]?.replace('/', '') || '',
      state: c.State as ContainerStatus['state'],
      uptime: Date.now() - (c.Created * 1000),
      startedAt: new Date(c.Created * 1000),
    }));
  }

  // PostgreSQL utilities
  async execSQL(containerID: string, sql: string, username = 'postgres', database = 'postgres'): Promise<string> {
    // Use Bun's shell instead of Dockerode exec to avoid stream issues
    const container = this.docker.getContainer(containerID);
    const info = await container.inspect();
    const containerName = info.Name.replace('/', '');

    try {
      const proc = Bun.spawn([
        'docker',
        'exec',
        containerName,
        'psql',
        '-U', username,
        '-d', database,
        '-t',  // Tuples only
        '-A',  // Unaligned
        '-c', sql
      ], {
        stdout: 'pipe',
        stderr: 'pipe'
      });

      const output = await new Response(proc.stdout).text();
      const error = await new Response(proc.stderr).text();
      await proc.exited;

      if (proc.exitCode !== 0) {
        throw new Error(error.trim() || `Command failed with exit code ${proc.exitCode}`);
      }

      return output.trim();
    } catch (error: any) {
      throw new Error(`SQL execution failed: ${error.message}`);
    }
  }

  async startBackupMode(containerID: string, username = 'postgres'): Promise<string> {
    // PostgreSQL 15+ renamed to pg_backup_start, older versions use pg_start_backup
    // Try modern naming first, fall back to legacy
    try {
      const sql = `SELECT pg_backup_start('${BACKUP_LABEL_PREFIX}-snapshot', false);`;
      const lsn = await this.execSQL(containerID, sql, username);
      return lsn.trim();
    } catch (error: any) {
      if (error.message.includes('does not exist')) {
        // Try legacy pg_start_backup for PostgreSQL < 15
        const sql = `SELECT pg_start_backup('${BACKUP_LABEL_PREFIX}-snapshot', false, false);`;
        const lsn = await this.execSQL(containerID, sql, username);
        return lsn.trim();
      }
      throw error;
    }
  }

  async stopBackupMode(containerID: string, username = 'postgres'): Promise<string> {
    // PostgreSQL 15+ renamed to pg_backup_stop, older versions use pg_stop_backup
    // Try modern naming first, fall back to legacy
    try {
      // pg_backup_stop() returns a record, so we need to extract the lsn field
      const sql = "SELECT lsn FROM pg_backup_stop();";
      const lsn = await this.execSQL(containerID, sql, username);
      return lsn.trim();
    } catch (error: any) {
      if (error.message.includes('does not exist')) {
        // Try legacy pg_stop_backup for PostgreSQL < 15
        const sql = "SELECT pg_stop_backup(false);";
        const lsn = await this.execSQL(containerID, sql, username);
        return lsn.trim();
      }
      throw error;
    }
  }
}
