import chalk from 'chalk';
import { migrateDatabase } from '../db/migrate';

export async function webCommand(options: { port?: string; host?: string } = {}) {
  migrateDatabase();

  const host = options.host || '0.0.0.0';
  const port = options.port || '3000';

  console.log();
  console.log(chalk.bold('Starting Velo web UI'));
  console.log(chalk.dim(`  http://${host}:${port}`));
  console.log();

  const proc = Bun.spawn(['bun', '--bun', 'vite', 'dev', '--host', host, '--port', port], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
}
