export interface PostgresOwner {
  uid: string;
  gid: string;
}

export interface PostgresOwnerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type PostgresOwnerRunner = (image: string) => Promise<PostgresOwnerCommandResult>;

const ownerCache = new Map<string, PostgresOwner>();

export const DEFAULT_POSTGRES_OWNER: PostgresOwner = {
  uid: '70',
  gid: '70',
};

export function formatPostgresOwner(owner: PostgresOwner): string {
  return `${owner.uid}:${owner.gid}`;
}

export function parsePostgresOwner(output: string): PostgresOwner {
  const [uid, gid] = output.trim().split(':');

  if (!uid || !gid || !/^\d+$/.test(uid) || !/^\d+$/.test(gid)) {
    throw new Error(`Invalid postgres owner: ${output.trim()}`);
  }

  return { uid, gid };
}

export async function resolvePostgresOwner(
  image: string,
  runner: PostgresOwnerRunner = runDockerOwnerProbe
): Promise<PostgresOwner> {
  const cached = ownerCache.get(image);
  if (cached) {
    return cached;
  }

  const result = await runner(image);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `failed to resolve postgres owner for ${image}`);
  }

  const owner = parsePostgresOwner(result.stdout);
  ownerCache.set(image, owner);
  return owner;
}

async function runDockerOwnerProbe(image: string): Promise<PostgresOwnerCommandResult> {
  const proc = Bun.spawn([
    'docker',
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    image,
    '-lc',
    'printf "%s:%s\\n" "$(id -u postgres)" "$(id -g postgres)"',
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return {
    exitCode: await proc.exited,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}
