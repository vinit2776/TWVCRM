/**
 * Local status HTTP server — http://localhost:7788
 * Minimal health page visible to anyone on the server (no external exposure needed).
 * Phase 1 alternative to the full tray icon (D4: tray deferred to later).
 */

import http from "http";
import { healthState } from "./health-state";
import { getRecentLogs } from "./logger";
import { VERSION } from "./version";

function statusDot(ok: boolean): string {
  return ok ? "🟢" : "🔴";
}

function htmlPage(): string {
  const h = healthState;
  const uptime = Math.floor((Date.now() - new Date(h.startedAt).getTime()) / 1000);
  const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;
  const overall = h.tallyConnected && !h.lastError && h.failedCount === 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="30">
  <title>TWV ↔ Tally Bridge</title>
  <style>
    body { font-family: monospace; padding: 24px; background: #0f0f0f; color: #e0e0e0; max-width: 640px; }
    h1   { font-size: 1.1rem; margin-bottom: 1rem; color: #fff; }
    .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #222; }
    .key { color: #888; }
    .ok  { color: #4ade80; }
    .err { color: #f87171; }
    .warn{ color: #fbbf24; }
    pre  { background: #1a1a1a; padding: 12px; font-size: 0.75rem; overflow-x: auto; max-height: 300px; white-space: pre-wrap; }
    .badge { padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; }
    .badge-ok  { background: #14532d; color: #4ade80; }
    .badge-err { background: #450a0a; color: #f87171; }
  </style>
</head>
<body>
  <h1>TWV ↔ Tally Bridge&nbsp;&nbsp;
    <span class="badge ${overall ? "badge-ok" : "badge-err"}">${overall ? "HEALTHY" : "DEGRADED"}</span>
  </h1>

  <div class="row"><span class="key">Version</span>       <span>${VERSION}</span></div>
  <div class="row"><span class="key">Uptime</span>        <span>${uptimeStr}</span></div>
  <div class="row"><span class="key">Started</span>       <span>${h.startedAt}</span></div>
  <div class="row"><span class="key">Tally</span>         <span class="${h.tallyConnected ? "ok" : "err"}">${statusDot(h.tallyConnected)} ${h.tallyConnected ? "Connected" : "Unreachable"}</span></div>
  <div class="row"><span class="key">Company</span>       <span>${h.tallyCompanyName ?? "—"}</span></div>
  <div class="row"><span class="key">Company GSTIN</span> <span>${h.tallyCompanyGstin ?? "—"}</span></div>
  <div class="row"><span class="key">Pending jobs</span>  <span class="${h.pendingCount > 0 ? "warn" : "ok"}">${h.pendingCount}</span></div>
  <div class="row"><span class="key">Failed jobs</span>   <span class="${h.failedCount > 0 ? "err" : "ok"}">${h.failedCount}</span></div>
  <div class="row"><span class="key">Last sync</span>     <span>${h.lastSyncAt ?? "never"}</span></div>
  <div class="row"><span class="key">Last error</span>    <span class="${h.lastError ? "err" : "ok"}">${h.lastError ?? "none"}</span></div>

  <br/>
  <details>
    <summary style="cursor:pointer;color:#888">Recent logs (last 3 days)</summary>
    <pre>${escapeHtml(getRecentLogs(3))}</pre>
  </details>

  <p style="color:#444;font-size:0.7rem;margin-top:1rem">Auto-refreshes every 30s</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function jsonPayload(): object {
  const h = healthState;
  const overall = h.tallyConnected && !h.lastError && h.failedCount === 0;
  return {
    version:          VERSION,
    state:            !h.tallyConnected || h.failedCount > 0 ? (h.failedCount > 0 ? "degraded" : "offline") : "healthy",
    healthy:          overall,
    tallyConnected:   h.tallyConnected,
    tallyCompanyName: h.tallyCompanyName,
    pendingCount:     h.pendingCount,
    failedCount:      h.failedCount,
    completedToday:   h.completedToday,
    lastSyncAt:       h.lastSyncAt,
    lastError:        h.lastError,
    startedAt:        h.startedAt,
  };
}

export function startHealthServer(port: number): void {
  const server = http.createServer((req, res) => {
    if (req.url === "/json") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(jsonPayload()));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlPage());
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Bridge status page: http://localhost:${port}`);
  });
}
