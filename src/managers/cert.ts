import { $ } from 'bun';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { APP_SLUG } from '../config/constants';
import { SystemError } from '../errors';

export interface CertPaths {
  certDir: string;
  serverKey: string;
  serverCert: string;
}

export class CertManager {
  private baseDir: string;

  constructor(baseDir: string = join(process.env.HOME || '/root', `.${APP_SLUG}/certs`)) {
    this.baseDir = baseDir;
  }

  /**
   * Get certificate paths for a project
   */
  getCertPaths(projectName: string): CertPaths {
    const certDir = join(this.baseDir, projectName);
    return {
      certDir,
      serverKey: join(certDir, 'server.key'),
      serverCert: join(certDir, 'server.crt'),
    };
  }

  /**
   * Generate self-signed SSL certificates for a project
   */
  async generateCerts(projectName: string): Promise<CertPaths> {
    const paths = this.getCertPaths(projectName);

    // Check if valid certificates already exist
    if (await this.validateCerts(projectName)) {
      return paths;
    }

    // If certs exist but are invalid, remove them first
    if (existsSync(paths.serverKey) || existsSync(paths.serverCert)) {
      await this.deleteCerts(projectName);
    }

    // Create certificate directory
    await mkdir(paths.certDir, { recursive: true, mode: 0o755 });

    // Generate private key (2048-bit RSA)
    try {
      await $`openssl genrsa -out ${paths.serverKey} 2048`.quiet();
    } catch (error: any) {
      throw new SystemError(`Failed to generate private key: ${error.message}`);
    }

    // Generate self-signed certificate (valid for 10 years)
    try {
      await $`openssl req -new -x509 -days 3650 \
        -key ${paths.serverKey} \
        -out ${paths.serverCert} \
        -subj "/CN=velo-postgres/O=velo/C=US"`.quiet();
    } catch (error: any) {
      throw new SystemError(`Failed to generate certificate: ${error.message}`);
    }

    // Set proper permissions BEFORE changing ownership
    // (PostgreSQL requires 0600 for private key)
    try {
      await $`chmod 600 ${paths.serverKey}`.quiet();
      await $`chmod 644 ${paths.serverCert}`.quiet();
    } catch (error: any) {
      throw new SystemError(`Failed to set permissions: ${error.message}`);
    }

    // Set ownership to match PostgreSQL user in container
    // PostgreSQL alpine image runs as user 'postgres' with UID 70
    try {
      await $`sudo chown 70:70 ${paths.serverKey} ${paths.serverCert}`;
    } catch (error: any) {
      console.error('chown error:', error.message);
      throw error;
    }

    return paths;
  }

  /**
   * Validate that certificates exist and are readable
   */
  async validateCerts(projectName: string): Promise<boolean> {
    const paths = this.getCertPaths(projectName);

    // Check if both files exist
    if (!existsSync(paths.serverKey) || !existsSync(paths.serverCert)) {
      return false;
    }

    // Try to verify the certificate is valid
    try {
      await $`openssl x509 -in ${paths.serverCert} -noout -text`.quiet();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove certificates for a project
   */
  async deleteCerts(projectName: string): Promise<void> {
    const paths = this.getCertPaths(projectName);

    if (existsSync(paths.certDir)) {
      // Use sudo to remove files that might be owned by postgres user (UID 70)
      try {
        await $`sudo rm -rf ${paths.certDir}`.quiet();
      } catch {
        // Fallback to regular rm if sudo fails
        await $`rm -rf ${paths.certDir}`.quiet();
      }
    }
  }
}
