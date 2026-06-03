/**
 * Install the bridge as a Windows Service using node-windows.
 * Run once: node dist/install-service.js
 *
 * The service auto-starts with Windows and restarts on crash.
 * To uninstall: node dist/uninstall-service.js
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Service = require("node-windows").Service as new (opts: Record<string, unknown>) => {
  install():   void;
  uninstall(): void;
  on(event: string, cb: () => void): void;
};

import path from "path";

const svc = new Service({
  name:        "TWV Tally Bridge",
  description: "TWV CRM ↔ Tally Prime sync agent",
  script:      path.join(__dirname, "index.js"),
  nodeOptions: [],
  env: [
    { name: "NODE_ENV", value: "production" },
  ],
});

svc.on("install", () => {
  console.log("Service installed. Starting…");
  (svc as unknown as { start(): void }).start();
});

svc.on("alreadyinstalled", () => {
  console.log("Service already installed. Run uninstall-service first if you want to reinstall.");
});

svc.install();
