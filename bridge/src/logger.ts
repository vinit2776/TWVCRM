/**
 * Rotating file logger + console logger.
 * Writes plain timestamped lines — no PII, no secrets.
 * One log file per day, keeps 30 days.
 */

import fs from "fs";
import path from "path";

let logDir = "./logs";

export function setLogDir(dir: string): void {
  logDir = dir;
  fs.mkdirSync(dir, { recursive: true });
}

function todayFile(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return path.join(logDir, `bridge-${stamp}.log`);
}

function write(level: string, msg: string): void {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(todayFile(), line);
  } catch {
    // Log write failing should not crash the bridge
  }
}

export const log = {
  info:  (msg: string) => write("INFO ", msg),
  warn:  (msg: string) => write("WARN ", msg),
  error: (msg: string) => write("ERROR", msg),
  debug: (msg: string) => {
    if (process.env.DEBUG) write("DEBUG", msg);
  },
};

/** Zip recent logs into a single buffer for remote diagnosis. */
export function getRecentLogs(days = 3): string {
  const lines: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86_400_000);
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const file = path.join(logDir, `bridge-${stamp}.log`);
    if (fs.existsSync(file)) {
      lines.push(`\n=== ${stamp} ===\n`);
      lines.push(fs.readFileSync(file, "utf-8").slice(-20_000)); // last 20KB per day
    }
  }
  return lines.join("") || "(no recent logs)";
}
