// eslint-disable-next-line @typescript-eslint/no-require-imports
const Service = require("node-windows").Service as new (opts: Record<string, unknown>) => {
  uninstall(): void;
  on(event: string, cb: () => void): void;
};
import path from "path";

const svc = new Service({
  name:   "TWV Tally Bridge",
  script: path.join(__dirname, "index.js"),
});

svc.on("uninstall", () => console.log("Service uninstalled."));
svc.uninstall();
