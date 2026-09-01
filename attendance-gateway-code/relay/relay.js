'use strict';

// Office-LAN relay for the ZKTeco K40 Pro biometric device.
//
// The device pushes attendance logs over PLAIN HTTP to a local IP:port (the ADMS
// protocol). Once the app moved to the cloud (HTTPS + a domain), the device can't
// reach it directly — many ZKTeco firmwares only support HTTP to a bare IP. This
// tiny always-on proxy runs on the office Windows machine: it accepts the device's
// local HTTP pushes and forwards them verbatim to the cloud app over HTTPS, then
// returns the cloud's response back to the device.
//
// Reliability comes for free from passing the cloud's response straight through:
// the device only clears a log once it receives an "OK", so if the cloud or the
// internet is down, the relay returns an error, the device gets no OK, and it keeps
// the records and retries later. Nothing is lost across outages. The relay itself is
// stateless — it holds no queue; the device's own buffer is the durable store.
//
// Setup: point the K40 Pro's ADMS Server URL/Port at THIS machine's LAN IP and
// RELAY_PORT, and run this as an NSSM service (auto-start) — see relay/README.md.
//
// Env:
//   CLOUD_URL   the cloud app base URL, e.g. https://attendance.theworkvilla.com (required)
//   RELAY_PORT  local port to listen on (default 3001 — match the device's config)

const http = require('http');
const https = require('https');

const CLOUD_URL = process.env.CLOUD_URL;
const RELAY_PORT = Number(process.env.RELAY_PORT) || 3001;

if (!CLOUD_URL) {
  console.error('CLOUD_URL is required, e.g. CLOUD_URL=https://attendance.theworkvilla.com');
  process.exit(1);
}
const cloud = new URL(CLOUD_URL);
if (cloud.protocol !== 'https:') {
  console.warn(`WARNING: CLOUD_URL is not https (${cloud.protocol}); the device data will not be encrypted in transit.`);
}
const transport = cloud.protocol === 'http:' ? http : https;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const options = {
      hostname: cloud.hostname,
      port: cloud.port || (cloud.protocol === 'http:' ? 80 : 443),
      path: req.url, // preserves the device's path + ?SN=... query verbatim
      method: req.method,
      // Forward the device's headers, but rewrite Host to the cloud domain so the
      // platform (Vercel) routes the request to the right project.
      headers: { ...req.headers, host: cloud.host },
      timeout: 20000,
    };
    const upstream = transport.request(options, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (err) => {
      console.error(`[relay] forward failed for ${req.method} ${req.url}: ${err.message}`);
      // 502 (not 200) so the device treats the push as undelivered and retries later.
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('relay: upstream unreachable');
      } else {
        res.destroy();
      }
    });
    if (body.length) upstream.write(body);
    upstream.end();
    console.log(`[relay] ${req.method} ${req.url} -> ${CLOUD_URL} (${body.length}b)`);
  });
  req.on('error', (err) => {
    console.error(`[relay] inbound error: ${err.message}`);
    res.destroy();
  });
});

server.listen(RELAY_PORT, '0.0.0.0', () => {
  console.log(`ADMS relay listening on :${RELAY_PORT}, forwarding to ${CLOUD_URL}`);
});
