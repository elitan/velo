import packageJsonRaw from '../../package.json';

interface PackageJson {
  name: string;
  version: string;
  cliName?: string;
  displayName?: string;
  containerPrefix?: string;
}

const packageJson = packageJsonRaw as PackageJson;

/**
 * CLI name - used for technical identifiers (paths, containers, datasets)
 * Derived from package.json "cliName" field, fallback to "name"
 */
export const CLI_NAME = packageJson.cliName || packageJson.name;

/**
 * Tool display name - used for user-facing messages and branding
 * Derived from package.json "displayName" field, fallback to CLI_NAME
 */
export const TOOL_NAME = packageJson.displayName || CLI_NAME;

/**
 * Container prefix for Docker containers
 * Format: {CONTAINER_PREFIX}-{project}-{branch}
 */
export const CONTAINER_PREFIX = packageJson.containerPrefix || CLI_NAME.replace(/[@/]/g, '');

/**
 * Backup label prefix for PostgreSQL backup mode
 */
export const BACKUP_LABEL_PREFIX = CLI_NAME;
