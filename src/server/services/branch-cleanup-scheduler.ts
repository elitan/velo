import { runExpiredBranchCleanup } from './branch-service';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startBranchCleanupScheduler(): void {
  if (interval || process.env.NODE_ENV !== 'production') {
    return;
  }

  void checkExpiredBranches();
  interval = setInterval(function checkBranches() {
    void checkExpiredBranches();
  }, CHECK_INTERVAL_MS);
}

export function stopBranchCleanupScheduler(): void {
  if (!interval) {
    return;
  }

  clearInterval(interval);
  interval = null;
}

async function checkExpiredBranches(): Promise<void> {
  if (running) {
    return;
  }

  running = true;

  try {
    await runExpiredBranchCleanup();
  } catch (error) {
    console.error('[branches] cleanup failed', error);
  } finally {
    running = false;
  }
}
