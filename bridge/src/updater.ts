/**
 * Bridge self-updater (v1.4.1+).
 *
 * The CRM heartbeat response includes `{ update: { target_version, sha256 } }`
 * whenever an admin has published a newer bridge zip via the Publish Bridge
 * Update card on /admin/tally-sync. This module:
 *
 *   1. Fetches the zip from /api/tally/update-package (bearer-authed)
 *   2. Verifies SHA-256 against the value from the heartbeat
 *   3. Stages the zip in ./staging/
 *   4. Writes a detached PowerShell script that:
 *        - waits for this bridge process to exit
 *        - stops the "TWV Tally Bridge" Windows service
 *        - rotates the current dist/ → dist.prev/ (so a bad zip can be rolled back)
 *        - unzips the new code over the install dir
 *        - restarts the service
 *   5. Exits the bridge cleanly — SCM hands control to PowerShell.
 *
 * Safety rails:
 *   - SHA mismatch → abort, log loudly, never touch dist/.
 *   - Download failure → abort, retry next heartbeat.
 *   - lastAttempted guard → don't re-attempt the same target in this run
 *     after a failure (avoids tight retry loop on a corrupt zip).
 */

import { promises as fs } from "fs";
import { spawn } from "child_process";
import { createHash } from "crypto";
import path from "path";
import { log } from "./logger";
import { CrmClient } from "./crm-client";

const STAGING_DIR = path.join(process.cwd(), "staging");

let lastAttempted: string | null = null;

export async function maybeApplyUpdate(
  crm: CrmClient,
  update: { target_version: string; sha256: string },
  currentVersion: string
): Promise<void> {
  if (!update.target_version || !update.sha256) return;
  if (update.target_version === currentVersion) return;
  if (update.target_version === lastAttempted) return;
  lastAttempted = update.target_version;

  log.info(`Self-update available: ${currentVersion} → ${update.target_version}`);

  try {
    await fs.mkdir(STAGING_DIR, { recursive: true });
    const zipPath = path.join(STAGING_DIR, `bridge-v${update.target_version}.zip`);

    log.info("Downloading update zip from CRM…");
    const bytes = await crm.downloadUpdatePackage();
    log.info(`Downloaded ${bytes.length} bytes.`);

    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha.toLowerCase() !== update.sha256.toLowerCase()) {
      log.error(`SHA-256 mismatch — expected ${update.sha256}, got ${sha}. Aborting.`);
      return;
    }
    log.info("SHA-256 verified.");

    await fs.writeFile(zipPath, bytes);

    const installDir = process.cwd();
    const applyPs1 = path.join(STAGING_DIR, "apply.ps1");
    const log_ = path.join(STAGING_DIR, "apply.log");

    const ps1 = [
      '$ErrorActionPreference = "Stop"',
      `$ErrorView = "NormalView"`,
      `Start-Transcript -Path '${log_.replace(/'/g, "''")}' -Force | Out-Null`,
      "Start-Sleep -Seconds 4",
      `$installDir = '${installDir.replace(/'/g, "''")}'`,
      `$zip        = '${zipPath.replace(/'/g, "''")}'`,
      "Set-Location $installDir",
      'Write-Host "Stopping TWV Tally Bridge service…"',
      'try { Stop-Service -DisplayName "TWV Tally Bridge" -Force -ErrorAction Stop } catch { Write-Host "stop: $_" }',
      "Start-Sleep -Seconds 3",
      'if (Test-Path dist.prev) { Remove-Item dist.prev -Recurse -Force }',
      'if (Test-Path dist) { Rename-Item dist dist.prev }',
      'Write-Host "Unzipping update…"',
      "Expand-Archive -Path $zip -DestinationPath . -Force",
      'Write-Host "Starting service…"',
      'try { Start-Service -DisplayName "TWV Tally Bridge" -ErrorAction Stop } catch { Write-Host "start: $_" }',
      'Write-Host "Update applied."',
      "Stop-Transcript | Out-Null",
    ].join("\r\n");
    await fs.writeFile(applyPs1, ps1, "utf8");

    log.info("Spawning detached PowerShell. Bridge will exit; service manager + PS will restart on new code.");

    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", applyPs1],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.unref();

    setTimeout(() => process.exit(0), 1500);
  } catch (err) {
    log.error(`Self-update failed: ${String(err)}`);
  }
}
