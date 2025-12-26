import chalk from 'chalk';
import { $ } from 'bun';
import * as fs from 'fs/promises';
import { CLI_NAME, TOOL_NAME } from '../config/constants';
import { DEFAULTS } from '../config/defaults';

/**
 * Setup command - grants ZFS permissions and configures Docker access
 * This command runs as a normal user and uses sudo internally for operations that need elevated privileges
 */
export async function setupCommand() {
  // Get the current user
  const actualUser = process.env.USER;

  if (!actualUser || actualUser === 'root') {
    console.log();
    console.log('✗ Please run this command as a regular user, not as root');
    console.log();
    console.log('Usage:');
    console.log(`  ${CLI_NAME} setup`);
    console.log();
    process.exit(1);
  }

  console.log();
  console.log(chalk.bold(`${TOOL_NAME} Permission Setup`));
  console.log(chalk.dim('═'.repeat(60)));
  console.log();
  console.log(`User: ${chalk.bold(actualUser)}`);
  console.log();

  // Step 1: Check ZFS
  console.log(chalk.bold('[1/5]'), 'Checking ZFS installation...');

  try {
    // Try standard locations for ZFS binaries
    // Bun's $ shell in compiled binaries might not have PATH set correctly
    try {
      await $`sudo /usr/sbin/zpool status`.quiet();
    } catch (error) {
      // Fallback to PATH-based command
      await $`sudo zpool status`.quiet();
    }
    console.log('✓', 'ZFS is installed');
  } catch (error) {
    console.log('✗', 'ZFS is not installed');
    console.log();
    console.log('Install ZFS first:');
    console.log('  Ubuntu/Debian: sudo apt install zfsutils-linux');
    console.log();
    process.exit(1);
  }
  console.log();

  // Step 2: Detect ZFS pool
  console.log(chalk.bold('[2/5]'), 'Detecting ZFS pools...');

  let pool: string;
  try {
    // Use full path to ensure it works in compiled binary
    const poolsOutput = await $`sudo /usr/sbin/zpool list -H -o name`.text();
    const pools = poolsOutput.trim().split('\n').filter(p => p);

    if (pools.length === 0) {
      console.log('✗', 'No ZFS pools found');
      console.log();
      console.log('Create a ZFS pool first:');
      console.log('  Testing: sudo truncate -s 10G /tmp/zfs-pool.img && sudo zpool create tank /tmp/zfs-pool.img');
      console.log('  Production: sudo zpool create tank /dev/sdb');
      console.log();
      process.exit(1);
    }

    if (pools.length === 1) {
      pool = pools[0]!; // Safe: we checked length === 1
      console.log('✓', `Found pool: ${pool}`);
    } else {
      console.log('Multiple pools found:');
      pools.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
      console.log();

      // Prompt for pool selection
      const stdin = Bun.stdin.stream();
      const reader = stdin.getReader();

      process.stdout.write(`Enter pool name to use for ${CLI_NAME}: `);

      const { value } = await reader.read();
      reader.releaseLock();

      const input = new TextDecoder().decode(value).trim();

      if (!pools.includes(input)) {
        console.log('✗', `Pool '${input}' not found`);
        process.exit(1);
      }

      pool = input;
      console.log('✓', `Using pool: ${pool}`);
    }
  } catch (error) {
    console.log('✗', 'Failed to detect ZFS pools');
    process.exit(1);
  }
  console.log();

  // Step 3: Grant ZFS permissions
  console.log(chalk.bold('[3/5]'), 'Granting ZFS delegation permissions...');

  try {
    // Check if delegation is enabled
    const delegation = await $`sudo /usr/sbin/zpool get -H -o value delegation ${pool}`.text();

    if (delegation.trim() !== 'on') {
      console.log('Enabling ZFS delegation on pool...');
      await $`sudo /usr/sbin/zpool set delegation=on ${pool}`;
    }

    // Create base dataset if needed
    const baseDataset = `${pool}/${CLI_NAME}`;
    try {
      await $`sudo /usr/sbin/zfs list ${baseDataset}`.quiet();
    } catch (error) {
      console.log(`Creating base dataset: ${baseDataset}`);
      await $`sudo /usr/sbin/zfs create ${baseDataset}`;
    }

    // Create databases dataset if needed
    const databasesDataset = `${pool}/${DEFAULTS.zfs.datasetBase}`;
    try {
      await $`sudo /usr/sbin/zfs list ${databasesDataset}`.quiet();
    } catch (error) {
      console.log(`Creating databases dataset: ${databasesDataset}`);
      await $`sudo /usr/sbin/zfs create ${databasesDataset}`;
    }

    // Grant permissions
    console.log(`Granting permissions to user '${actualUser}'...`);
    await $`sudo /usr/sbin/zfs allow ${actualUser} create,destroy,snapshot,clone,mount ${databasesDataset}`;
    await $`sudo /usr/sbin/zfs allow ${actualUser} promote,send,receive ${databasesDataset}`;
    await $`sudo /usr/sbin/zfs allow ${actualUser} compression,recordsize,mountpoint,atime ${databasesDataset}`;

    console.log('✓', 'ZFS permissions granted');
  } catch (error) {
    console.log('✗', 'Failed to grant ZFS permissions');
    console.error(error);
    process.exit(1);
  }
  console.log();

  // Step 4: Configure Docker
  console.log(chalk.bold('[4/5]'), 'Configuring Docker access...');

  try {
    await $`command -v docker`.quiet();

    // Check if docker group exists
    try {
      await $`getent group docker`.quiet();
    } catch (error) {
      console.log('Creating docker group...');
      await $`sudo groupadd docker`;
    }

    // Check if user is in docker group
    const groups = await $`groups ${actualUser}`.text();

    if (!groups.includes('docker')) {
      console.log(`Adding user '${actualUser}' to docker group...`);
      await $`sudo usermod -aG docker ${actualUser}`;
      console.log('✓', 'User added to docker group');
    } else {
      console.log('✓', 'User already in docker group');
    }
  } catch (error) {
    console.log('⚠', 'Docker not installed (optional)');
    console.log(`Install Docker before using ${CLI_NAME}: https://docs.docker.com/engine/install/`);
  }
  console.log();

  // Step 5: Install sudoers config
  console.log(chalk.bold('[5/5]'), 'Installing sudoers configuration...');

  try {
    // Remove old sudoers file if it exists (to avoid ownership issues)
    const sudoersPath = `/etc/sudoers.d/${CLI_NAME}`;
    try {
      await $`sudo rm -f ${sudoersPath}`.quiet();
    } catch (error) {
      // Ignore errors if file doesn't exist
    }

    // Create group if needed
    try {
      await $`getent group ${CLI_NAME}`.quiet();
      console.log('✓', `${CLI_NAME} group exists`);
    } catch (error) {
      console.log(`Creating ${CLI_NAME} group...`);
      await $`sudo groupadd ${CLI_NAME}`;
      console.log('✓', `${CLI_NAME} group created`);
    }

    // Add user to group
    const groups = await $`groups ${actualUser}`.text();

    if (!groups.includes(CLI_NAME)) {
      console.log(`Adding user '${actualUser}' to ${CLI_NAME} group...`);
      await $`sudo usermod -aG ${CLI_NAME} ${actualUser}`;
      console.log('✓', `User added to ${CLI_NAME} group`);
    } else {
      console.log('✓', `User already in ${CLI_NAME} group`);
    }

    // Get home directory for certificate path (must be absolute, no tilde expansion in sudoers)
    const homeDir = await $`getent passwd ${actualUser}`.text().then(s => s.trim().split(':')[5]);

    // Create sudoers file
    const sudoersContent = `# ${TOOL_NAME} - PostgreSQL database branching tool
# This file grants minimal sudo permissions for required operations

# Allow ${CLI_NAME} group members to run ZFS mount/unmount commands without password
%${CLI_NAME} ALL=(ALL) NOPASSWD: /sbin/zfs mount *
%${CLI_NAME} ALL=(ALL) NOPASSWD: /sbin/zfs unmount *

# Allow chown for SSL certificates (PostgreSQL requires specific ownership)
%${CLI_NAME} ALL=(ALL) NOPASSWD: /usr/bin/chown 70\\:70 ${homeDir}/.${CLI_NAME}/certs/*/server.key
%${CLI_NAME} ALL=(ALL) NOPASSWD: /usr/bin/chown 70\\:70 ${homeDir}/.${CLI_NAME}/certs/*/server.crt

# Allow chown for WAL archive directories (PostgreSQL requires write access)
%${CLI_NAME} ALL=(ALL) NOPASSWD: /usr/bin/chown 70\\:70 ${homeDir}/.${CLI_NAME}/wal-archive/*

# Allow rm for SSL certificate cleanup (files may be owned by UID 70)
%${CLI_NAME} ALL=(ALL) NOPASSWD: /usr/bin/rm -rf ${homeDir}/.${CLI_NAME}/certs/*

# Security notes:
# - Only mount/unmount commands are allowed (not create, destroy, etc.)
# - chown is restricted to certificate and WAL archive paths with specific UID:GID (70:70)
# - rm is restricted to certificate directory only
# - All other ZFS operations use delegation (no sudo required)
# - This is much more secure than granting full sudo access
`;

    // Write sudoers file with sudo
    const tmpFile = `/tmp/${CLI_NAME}-sudoers-${Date.now()}`;
    await fs.writeFile(tmpFile, sudoersContent);
    await $`sudo mv ${tmpFile} ${sudoersPath}`;
    await $`sudo chown root:root ${sudoersPath}`;
    await $`sudo chmod 0440 ${sudoersPath}`;

    // Verify sudoers syntax
    try {
      await $`sudo visudo -c -f ${sudoersPath}`.quiet();
      console.log('✓', 'Sudoers configuration installed');
    } catch (error) {
      console.log('✗', 'Sudoers syntax error');
      await $`sudo rm ${sudoersPath}`;
      process.exit(1);
    }
  } catch (error) {
    console.log('✗', 'Failed to configure sudoers');
    console.error(error);
    process.exit(1);
  }
  console.log();

  // Success!
  console.log(chalk.dim('═'.repeat(60)));
  console.log(chalk.bold('✓ Setup Complete!'));
  console.log(chalk.dim('═'.repeat(60)));
  console.log();
  console.log('Configuration summary:');
  console.log(`  • ZFS pool: ${pool}`);
  console.log('  • ZFS delegation: create, destroy, snapshot, clone, promote, etc.');
  console.log(`  • Groups: docker, ${CLI_NAME}`);
  console.log(`  • Sudoers: /etc/sudoers.d/${CLI_NAME} (ZFS mount/unmount + cert ownership)`);
  console.log();
  console.log(chalk.bold('IMPORTANT: Log out and log back in now!'));
  console.log(`Group membership (docker, ${CLI_NAME}) requires a new login session.`);
  console.log();
  console.log(chalk.bold('After re-logging in:'));
  console.log(`  1. Verify setup: ${CLI_NAME} doctor`);
  console.log(`  2. Create first project: ${CLI_NAME} project create myapp`);
  console.log();
  console.log(chalk.bold('Security Note:'));
  console.log(`${TOOL_NAME} uses sudo only for:`);
  console.log('  • ZFS mount/unmount (Linux kernel limitation)');
  console.log('  • Certificate ownership (PostgreSQL security requirement)');
  console.log('All other operations use ZFS delegation - much more secure than full sudo.');
  console.log();
}
