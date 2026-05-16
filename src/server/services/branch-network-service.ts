export function shouldExposeBranchPostgres(publicAccess?: boolean | null): boolean {
  return publicAccess === true;
}

export function getBranchConnectionHost(devHost: string | null | undefined, publicAccess?: boolean | null): string {
  if (shouldExposeBranchPostgres(publicAccess)) {
    return devHost || 'localhost';
  }

  return 'localhost';
}
