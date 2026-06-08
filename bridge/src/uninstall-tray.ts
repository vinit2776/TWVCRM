/**
 * Removes the TWV Tally Bridge tray app from Windows startup.
 * Run: node dist/uninstall-tray.js
 */

import fs   from "fs";
import path from "path";

const STARTUP_DIR = path.join(
  process.env["APPDATA"] ?? "C:\\Users\\Default\\AppData\\Roaming",
  "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
);
const VBS_PATH = path.join(STARTUP_DIR, "twv-tray-startup.vbs");

function main(): void {
  if (fs.existsSync(VBS_PATH)) {
    fs.unlinkSync(VBS_PATH);
    console.log(`✓ Tray startup removed: ${VBS_PATH}`);
  } else {
    console.log("Tray startup was not installed — nothing to remove.");
  }
}

main();
