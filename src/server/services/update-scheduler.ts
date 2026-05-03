import { runAutoUpdateCheck } from './update-service';

const CHECK_INTERVAL_MS = 60 * 1000;

let interval: ReturnType<typeof setInterval> | null = null;

export function startUpdateScheduler(): void {
  if (interval || process.env.NODE_ENV !== 'production') {
    return;
  }

  interval = setInterval(function checkUpdates() {
    runAutoUpdateCheck().catch(function logAutoUpdateError(error) {
      console.error('[updates] auto update failed', error);
    });
  }, CHECK_INTERVAL_MS);
}

export function stopUpdateScheduler(): void {
  if (!interval) {
    return;
  }

  clearInterval(interval);
  interval = null;
}
