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
};
