import chalk from 'chalk';
import { parseNamespace } from '../../utils/namespace';
import { formatRelativeTime } from '../../utils/time';
import { formatBytes } from '../../utils/helpers';
import { getDatasetName } from '../../utils/naming';
import { initializeServices, getBranchWithProject } from '../../utils/service-factory';

export async function walInfoCommand(branchName?: string) {
  const { state, wal } = await initializeServices();

  console.log();
  console.log(chalk.bold('WAL Archive Status'));
  console.log();

  if (branchName) {
    // Show info for specific branch
    const target = parseNamespace(branchName);
    const { branch } = await getBranchWithProject(state, branchName);

    const datasetName = getDatasetName(target.project, target.branch);
    const info = await wal.getArchiveInfo(datasetName);

    console.log(chalk.bold(`Branch: ${branch.name}`));
    console.log();
    console.log(chalk.dim('Archive path:  '), info.path);
    console.log(chalk.dim('File count:    '), info.fileCount);
    console.log(chalk.dim('Total size:    '), formatBytes(info.sizeBytes));

    if (info.oldestWAL && info.oldestTimestamp) {
      console.log(chalk.dim('Oldest WAL:    '), info.oldestWAL);
      console.log(chalk.dim('               '), formatRelativeTime(info.oldestTimestamp));
    }

    if (info.newestWAL && info.newestTimestamp) {
      console.log(chalk.dim('Newest WAL:    '), info.newestWAL);
      console.log(chalk.dim('               '), formatRelativeTime(info.newestTimestamp));
    }

    console.log();

    // Check integrity
    const integrity = await wal.verifyArchiveIntegrity(datasetName);
    if (integrity.valid) {
      console.log('✓ No gaps detected in WAL archive');
    } else {
      console.log('⚠ Gaps detected in WAL archive:');
      for (const gap of integrity.gaps) {
        console.log(chalk.dim('  -'), gap);
      }
    }
    console.log();
  } else {
    // Show info for all projects
    const projects = state.getState().projects || [];

    if (projects.length === 0) {
      console.log(chalk.dim('No projects found'));
      console.log();
      return;
    }

    for (const proj of projects) {
      console.log(chalk.bold(proj.name));

      for (const branch of proj.branches) {
        const namespace = parseNamespace(branch.name);
        const datasetName = getDatasetName(namespace.project, namespace.branch);
        const info = await wal.getArchiveInfo(datasetName);

        console.log(chalk.dim(`  ${branch.name}`));
        console.log(chalk.dim(`    Files: ${info.fileCount} | Size: ${formatBytes(info.sizeBytes)}`));

        if (info.oldestTimestamp && info.newestTimestamp) {
          const coverage = formatRelativeTime(info.oldestTimestamp) + ' to ' + formatRelativeTime(info.newestTimestamp);
          console.log(chalk.dim(`    Coverage: ${coverage}`));
        }
      }

      console.log();
    }
  }
}
