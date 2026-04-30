export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SshTarget {
  host: string;
  user: string;
  keyPath: string;
}

export async function runCommand(command: string[], timeoutMs = 15000): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timeout = setTimeout(function killProcess() {
    proc.kill();
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timeout);

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

export async function runSshCommand(
  target: SshTarget,
  remoteCommand: string,
  timeoutMs = 15000
): Promise<CommandResult> {
  return runCommand([
    'ssh',
    '-i',
    target.keyPath,
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=8',
    `${target.user}@${target.host}`,
    remoteCommand,
  ], timeoutMs);
}
