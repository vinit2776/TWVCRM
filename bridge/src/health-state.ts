/**
 * Shared in-process health state — read by heartbeat sender + status page.
 */

export const healthState = {
  tallyConnected:     false,
  tallyCompanyName:   null as string | null,
  tallyCompanyGstin:  null as string | null,
  pendingCount:       0,
  failedCount:        0,
  lastSyncAt:         null as string | null,
  lastError:          null as string | null,
  startedAt:          new Date().toISOString(),
  // Rolling today counter — incremented on every completed job, reset at midnight.
  completedToday:     0,
  completedTodayDate: new Date().toDateString(), // "Mon Jun 09 2025"
};

/** Increment the today counter, resetting it first if the date has rolled over. */
export function incrementCompletedToday(): void {
  const today = new Date().toDateString();
  if (healthState.completedTodayDate !== today) {
    healthState.completedToday     = 0;
    healthState.completedTodayDate = today;
  }
  healthState.completedToday++;
}
