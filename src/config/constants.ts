import packageJsonRaw from '../../package.json';

interface PackageJson {
  name: string;
  version: string;
  displayName?: string;
  containerPrefix?: string;
}

const packageJson = packageJsonRaw as PackageJson;

export const APP_SLUG = packageJson.name.replace(/^@[^/]+\//, '');

export const TOOL_NAME = packageJson.displayName || APP_SLUG;

export const CONTAINER_PREFIX = packageJson.containerPrefix || APP_SLUG;

export const BACKUP_LABEL_PREFIX = APP_SLUG;
