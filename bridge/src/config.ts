/**
 * Config loader — reads config.json from the same directory as the binary.
 * All values validated at startup so the bridge fails fast on bad config,
 * not partway through a job.
 */

import { z } from "zod";
import fs from "fs";
import path from "path";

const ConfigSchema = z.object({
  crm_base_url:          z.string().url(),
  agent_token:           z.string().min(16),
  tally_host:            z.string().default("localhost"),
  tally_port:            z.number().int().default(9000),
  tally_company_gstin:   z.string().min(15).max(15),
  poll_interval_ms:      z.number().int().min(30_000).default(120_000),
  heartbeat_interval_ms: z.number().int().min(30_000).default(60_000),
  lease_seconds:         z.number().int().default(120),
  irn_alarm_hours:       z.number().default(4),
  log_dir:               z.string().default("./logs"),
  status_port:           z.number().int().default(7788),
  instance_id:           z.string().default("twv-tally-bridge"),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const configPath = path.join(process.cwd(), "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `config.json not found at ${configPath}.\n` +
      `Copy config.example.json to config.json and fill in your values.`
    );
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`config.json is invalid:\n${result.error.toString()}`);
  }

  _config = result.data;
  return _config;
}
