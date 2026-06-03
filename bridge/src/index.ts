/**
 * TWV Tally Bridge — entry point.
 *
 * Starts:
 *   1. Config validation
 *   2. Local health status page (http://localhost:7788)
 *   3. Heartbeat sender (every 60s)
 *   4. Polling loop (every 2 min)
 */

import { loadConfig } from "./config";
import { setLogDir, log } from "./logger";
import { CrmClient, HeartbeatPayload } from "./crm-client";
import { TallyClient } from "./tally-client";
import { Poller } from "./poller";
import { startHealthServer } from "./health-server";
import { healthState } from "./health-state";
import { VERSION } from "./version";

async function main(): Promise<void> {
  // 1. Load + validate config
  const config = loadConfig();
  setLogDir(config.log_dir);

  log.info(`TWV Tally Bridge v${VERSION} starting up`);
  log.info(`CRM: ${config.crm_base_url}`);
  log.info(`Tally: ${config.tally_host}:${config.tally_port}`);
  log.info(`Poll interval: ${config.poll_interval_ms / 1000}s`);

  // 2. Local status page
  startHealthServer(config.status_port);

  const crm    = new CrmClient(config);
  const tally  = new TallyClient(config);
  const poller = new Poller(config, crm, tally);

  // 3. Initial connectivity check
  const tallyAlive = await tally.ping();
  if (!tallyAlive) {
    log.warn("Tally not reachable at startup — will retry on next poll. Check Tally is open.");
  } else {
    log.info("Tally gateway reachable ✓");
  }

  // 4. Heartbeat loop — sends health to CRM every heartbeat_interval_ms
  const sendHeartbeat = async (): Promise<void> => {
    const payload: HeartbeatPayload = {
      bridge_instance_id:   config.instance_id,
      version:              VERSION,
      tally_connected:      healthState.tallyConnected,
      tally_company_name:   healthState.tallyCompanyName,
      tally_company_gstin:  healthState.tallyCompanyGstin,
      crm_connected:        true,
      pending_count:        healthState.pendingCount,
      failed_count:         healthState.failedCount,
      last_sync_at:         healthState.lastSyncAt,
      last_error:           healthState.lastError,
    };
    const result = await crm.heartbeat(payload);
    if (result.gstin_mismatch && result.warning) {
      log.warn(result.warning);
    }
  };

  // Fire immediately, then on interval
  await sendHeartbeat();
  setInterval(() => { void sendHeartbeat(); }, config.heartbeat_interval_ms);

  // 5. Polling loop
  log.info("Starting polling loop…");
  // Fire immediately
  await poller.poll();

  setInterval(() => { void poller.poll(); }, config.poll_interval_ms);

  log.info("Bridge running. Status page: http://localhost:" + config.status_port);
}

main().catch((err: unknown) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
