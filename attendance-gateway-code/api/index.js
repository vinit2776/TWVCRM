// Vercel serverless entry point.
//
// The whole app is one catch-all function: vercel.json rewrites every path to
// here, and req.url still carries the original path, so the existing router in
// server.js handles it unchanged. server.js is imported (not run), so its
// standalone HTTP listener and setInterval never start — see the
// `require.main === module` guard there.
//
// Required Vercel environment variables:
//   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN  — the libSQL/Turso connection
//   PUNCH_API_KEY, ZK_DEVICE_SN           — punch + device auth (as before)
//   CRON_SECRET                           — protects /internal/auto-checkout
//   ADMIN_BOOTSTRAP_PASSWORD              — first-run admin password, on an empty
//                                           database only; remove once rotated
// SEED_DEMO_DATA must stay unset here — it creates publicly-known credentials.
// See .env.example for the full list, including the optional LocationIQ and
// office-WiFi settings.
// (Timezone is forced to Asia/Kolkata in server.js — Vercel runs UTC and reserves
//  the TZ env var, so it's set in code rather than as an env var.)
const { serve, ensureInit } = require('../server.js');

module.exports = async (req, res) => {
  try {
    await ensureInit(); // create schema / seed once per cold start, before any query
  } catch (err) {
    console.error('init failed:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Server not ready' }));
    return;
  }
  await serve(req, res);
};
