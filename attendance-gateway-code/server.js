// Attendance/shift math uses local-time Date methods, so the process timezone must
// be IST. The hosting platform (Vercel) runs in UTC *and* sets TZ=UTC itself (and
// reserves the TZ env var), so this must be an UNCONDITIONAL assignment — a
// `|| fallback` would keep Vercel's UTC. Override via APP_TZ if ever needed, since
// TZ can't be set on Vercel. Node honors process.env.TZ set before any Date use.
process.env.TZ = process.env.APP_TZ || 'Asia/Kolkata';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');
const {
  createAttendanceLogic,
  pad, todayStr, parseTimeToMinutes, timeOfDayMinutes, isSunday, isSaturday, saturdayOccurrenceInMonth,
} = require('./attendance-logic');
const { t } = require('./i18n');

// Only employee accounts can be in Tamil — admin pages always render in English,
// regardless of what's stored in users.language (the toggle never shows for admins,
// so that column stays 'en' for them in practice anyway).
function langOf(user) {
  return (user && user.role !== 'admin' && user.language === 'ta') ? 'ta' : 'en';
}

const PORT = process.env.PORT || 3001;
const DB_FILE = path.join(__dirname, 'attendance.db');
const AUTO_CHECKOUT_HOUR = 19; // 7 PM, local time

// PWA icons are static files generated once (public/icons/); read into memory at
// startup so requests don't hit disk, same as everything else in this app.
const ICONS_DIR = path.join(__dirname, 'public', 'icons');
const ICON_FILES = {
  'icon-192.png': 'image/png',
  'icon-512.png': 'image/png',
  'icon-512-maskable.png': 'image/png',
  'apple-touch-icon.png': 'image/png',
};
const iconBuffers = {};
for (const file of Object.keys(ICON_FILES)) {
  // On Vercel these are served statically from public/ and may not be bundled into
  // the function, so a missing file here is fine — don't crash module load over it.
  try { iconBuffers[file] = fs.readFileSync(path.join(ICONS_DIR, file)); } catch { /* served statically */ }
}

const MANIFEST = {
  name: 'Attendance Gateway',
  short_name: 'Attendance',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#F5F6F8',
  theme_color: '#1565C0',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

// Shared <head> tags for installability — every independently-rendered page
// (pageShell, login, change-password) needs these, since any of them can be the
// entry point a browser fetches first.
// viewport-fit=cover is what makes env(safe-area-inset-*) resolve to non-zero
// values at all — without it every safe-area-inset-* below is silently 0, even
// on a notched/cutout phone.
const PWA_HEAD_TAGS = `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#1565C0">
    <link rel="manifest" href="/manifest.json">
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="default">
    <meta name="apple-mobile-web-app-title" content="Attendance">
    <script>if ('serviceWorker' in navigator) { window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js')); }</script>`;

// iOS Safari has no native "install this PWA" prompt (Android/Chrome supplies
// one automatically), so the app shows its own one-time nudge instead. Gated to
// iOS Safari specifically — Chrome/Firefox-on-iOS also match the UA's "Safari"
// substring, hence the CriOS/FxiOS/EdgiOS/OPiOS exclusions — and skipped once the
// app is already running standalone (installed) or the employee has dismissed it.
const IOS_INSTALL_SHEET_HTML = `<div id="iosInstallSheet" style="display:none;position:fixed;left:0;right:0;bottom:0;max-width:480px;margin:0 auto;background:#fff;border-radius:20px 20px 0 0;box-shadow:0 -10px 28px rgba(15,20,25,0.16);padding:18px 20px calc(24px + env(safe-area-inset-bottom));box-sizing:border-box;z-index:1000;">
      <button onclick="dismissIosInstallSheet()" aria-label="Dismiss" style="position:absolute;top:12px;right:14px;width:22px;height:22px;border-radius:50%;background:#F0F2F4;border:none;display:flex;align-items:center;justify-content:center;font-size:13px;color:#7C8896;cursor:pointer;">&times;</button>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <img src="/icons/icon-192.png" width="44" height="44" style="border-radius:11px;flex-shrink:0;">
        <div>
          <div style="font-weight:700;font-size:15px;color:#1B2430;">Install Attendance Gateway</div>
          <div style="font-size:12px;color:#7C8896;margin-top:1px;">Full-screen access, right from your Home Screen.</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;align-items:center;gap:10px;font-size:12.5px;color:#1B2430;">
          <div style="width:26px;height:26px;border-radius:8px;background:#E3F2FD;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#1565C0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"></path><path d="M8 7l4-4 4 4"></path><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"></path></svg>
          </div>
          <span>Tap <strong>Share</strong> in Safari's toolbar</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;font-size:12.5px;color:#1B2430;">
          <div style="width:26px;height:26px;border-radius:8px;background:#E3F2FD;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#1565C0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"></rect><path d="M12 8v8"></path><path d="M8 12h8"></path></svg>
          </div>
          <span>Choose <strong>Add to Home Screen</strong></span>
        </div>
      </div>
    </div>
    <script>
      function dismissIosInstallSheet() {
        const el = document.getElementById('iosInstallSheet');
        if (el) el.style.display = 'none';
        try { localStorage.setItem('iosInstallSheetDismissed', '1'); } catch (e) {}
      }
      (function() {
        try {
          const ua = navigator.userAgent || '';
          const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
          const isSafari = /^((?!chrome|android|crios|fxios|edgios|opios).)*safari/i.test(ua);
          const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
          if (!isIOS || !isSafari || isStandalone || localStorage.getItem('iosInstallSheetDismissed')) return;
          const el = document.getElementById('iosInstallSheet');
          if (el) el.style.display = 'block';
        } catch (e) {}
      })();
    </script>`;

const OFFLINE_HTML = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline</title>
  <style>body{font-family:-apple-system,"Segoe UI",sans-serif;background:#F5F6F8;color:#1B2430;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px;box-sizing:border-box;}
  .box{max-width:320px;}h2{margin-bottom:8px;}p{color:#7C8896;font-size:0.92em;}</style></head>
  <body><div class="box"><h2>You're offline</h2><p>Punches and attendance data need a connection. Reconnect and try again.</p></div></body></html>`;

// Cache-first for the static shell (icons/manifest), network-first with an offline
// fallback for everything else — attendance data is per-request and must stay fresh,
// so there's no app-shell page caching beyond this.
const SERVICE_WORKER_JS = `
const CACHE = 'attendance-shell-v1';
const SHELL_ASSETS = ['/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/offline.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
    return;
  }
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
  }
});
`;

// --- Runtime settings -------------------------------------------------------
//
// Operational configuration that has to be changeable after the app is live, without
// a redeploy: the office's public IP moves when the ISP reassigns it, the biometric
// device's serial is not known until the device is installed, and API keys get
// rotated. Each setting resolves in this order:
//
//   1. the app_settings table, edited by an admin at /admin/settings
//   2. the matching environment variable, as a deploy-time default
//   3. the built-in fallback below
//
// Env vars therefore still work exactly as before for anything never set in the UI,
// which is what keeps a fresh deploy bootable before anyone has logged in.
//
// Deliberately NOT here: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN (needed to read this
// table at all), CRON_SECRET (must be verifiable before any DB access, on a route
// that has no admin to fix it), and ADMIN_BOOTSTRAP_PASSWORD (used before an admin
// account exists). Those stay environment-only by necessity.
const SETTING_DEFS = [
  {
    key: 'OFFICE_WIFI_IPS',
    label: 'Office public IP addresses',
    help: "Comma-separated. The self-service punch button only succeeds when the employee's public IP matches one of these — there is no browser API for reading the WiFi SSID, so this is how a web app can tell \"on the office network\". Leave empty to hide the punch button entirely rather than show one that can never succeed. Add every ISP if the office has more than one.",
    fallback: '',
    parse: (raw) => new Set(String(raw).split(',').map(x => x.trim()).filter(Boolean)),
  },
  {
    key: 'OFFICE_WIFI_SSID',
    label: 'Office WiFi name',
    help: 'Shown under the punch button so an employee knows which network to join. Display only — it has no effect on whether a punch is accepted.',
    fallback: 'Workvilla_LGF',
  },
  {
    key: 'ZK_DEVICE_SN',
    label: 'Biometric device serial number',
    help: "The ZKTeco ADMS push protocol has no header authentication — the device is identified only by this serial, which makes it the sole credential on /iclock/*. While it is empty those endpoints reject every push, so leave it blank until the device is installed. Setting it to the wrong value silently drops real punches.",
    fallback: '',
  },
  {
    key: 'DEVICE_CLOCK_OFFSET_MINUTES',
    label: 'Device clock correction (minutes)',
    help: 'Subtracted from every timestamp the biometric device reports. The current K40 Pro auto-syncs its clock over the network with no way to disable it, and lands exactly 150 minutes ahead of IST (it applies GMT+8 instead of GMT+5:30). Set to 0 once the device keeps correct time.',
    fallback: '150',
    parse: (raw) => { const n = Number(raw); return Number.isFinite(n) ? n : 150; },
  },
  {
    key: 'PUNCH_API_KEY',
    label: 'Punch API key',
    help: 'Shared secret the biometric device or its middleware sends as the X-API-Key header on /api/punch. While empty a random key is generated per server process, which changes on every restart — no device can authenticate against that, so it must be set before the device is connected.',
    secret: true,
    fallback: '',
  },
  {
    key: 'LOCATIONIQ_API_KEY',
    label: 'LocationIQ API key',
    help: 'Powers the field-trip address type-ahead, road distance, and on-site reverse geocoding. While empty the Field Trips tab is hidden entirely. Nothing else depends on it.',
    secret: true,
    fallback: '',
  },
  {
    key: 'LOCATIONIQ_BASE_URL',
    label: 'LocationIQ base URL',
    help: 'Only change this to point at a different LocationIQ region, or at a stub during testing.',
    fallback: 'https://us1.locationiq.com/v1',
  },
  {
    key: 'PLACES_COUNTRY',
    label: 'Address search country code',
    help: 'Two-letter code restricting address suggestions to one country. Empty searches worldwide.',
    fallback: 'in',
  },
  {
    key: 'PLACES_VIEWBOX',
    label: 'Address search bounding box',
    help: 'lon1,lat1,lon2,lat2 — biases address suggestions to one city so other cities do not clutter results. Default covers Chennai. Empty disables the restriction.',
    fallback: '79.95,12.75,80.35,13.35',
  },
];
const SETTING_DEFS_BY_KEY = Object.fromEntries(SETTING_DEFS.map(d => [d.key, d]));

// Last-resort punch key. Regenerated per process when neither the database nor the
// environment supplies one, so an unconfigured deployment is unusable by a device
// rather than open to one — an attacker cannot guess it, and it changes every restart.
const EPHEMERAL_PUNCH_API_KEY = crypto.randomBytes(24).toString('hex');

// Resolved settings, refreshed once per request (see loadSettings). Seeded from env
// and fallbacks so that any code path reached before the first refresh — a crash
// during init, a log line at startup — still sees sane values rather than undefined.
const CONFIG = {};
function applySettings(overrides = {}) {
  for (const def of SETTING_DEFS) {
    const raw = overrides[def.key] !== undefined && overrides[def.key] !== null && overrides[def.key] !== ''
      ? overrides[def.key]
      : (process.env[def.key] || def.fallback);
    CONFIG[def.key] = def.parse ? def.parse(raw) : raw;
  }
  if (!CONFIG.PUNCH_API_KEY) CONFIG.PUNCH_API_KEY = EPHEMERAL_PUNCH_API_KEY;
}
applySettings();

// Re-read from the database at most this often. A serverless instance would otherwise
// issue an extra query on every request; the cost of the cache is that a settings
// change takes up to this long to reach instances other than the one that saved it.
const SETTINGS_CACHE_TTL_MS = 30 * 1000;
let _settingsLoadedAt = 0;
async function loadSettings({ force = false } = {}) {
  if (!force && Date.now() - _settingsLoadedAt < SETTINGS_CACHE_TTL_MS) return;
  try {
    const rows = await db.prepare('SELECT key, value FROM app_settings').all();
    applySettings(Object.fromEntries(rows.map(r => [r.key, r.value])));
    _settingsLoadedAt = Date.now();
  } catch (err) {
    // Never let a settings read take the whole app down: env values and fallbacks are
    // already in CONFIG, so serving with those beats returning 500 to everyone. The
    // timestamp is left alone so the next request retries rather than caching failure.
    console.error('settings load failed, continuing with environment defaults:', err.message);
  }
}

// Startup warnings, emitted once per process after settings first resolve rather than
// at import time — at import time only the environment is known, so an operator who had
// correctly configured everything in the admin UI would still be warned that nothing
// was set.
let _warnedAboutSettings = false;
function warnAboutUnsetSettings() {
  if (_warnedAboutSettings) return;
  _warnedAboutSettings = true;
  if (!process.env.PUNCH_API_KEY && CONFIG.PUNCH_API_KEY === EPHEMERAL_PUNCH_API_KEY) {
    console.warn(`PUNCH_API_KEY is not configured. Generated a temporary key for this process only:\n  ${CONFIG.PUNCH_API_KEY}\nIt changes on every restart, so no device can authenticate. Set it at /admin/settings.`);
  }
  if (!CONFIG.ZK_DEVICE_SN) {
    console.warn('ZK_DEVICE_SN is not configured: the /iclock ADMS endpoints are disabled and reject every push. Set the device serial at /admin/settings once the K40 Pro is installed.');
  }
  if (CONFIG.OFFICE_WIFI_IPS.size === 0) {
    console.warn('OFFICE_WIFI_IPS is not configured: the WiFi punch button stays hidden. Set the office public IP at /admin/settings.');
  }
}

// Vercel proxies every request — req.socket.remoteAddress there is Vercel's own edge
// address, not the caller's. x-forwarded-for (client, proxy1, proxy2, ...) carries the
// real IP first when present; falls back to the socket for local/non-proxied runs.
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const ip = xff ? String(xff).split(',')[0].trim() : (req.socket.remoteAddress || '');
  return ip.replace(/^::ffff:/, '');
}

function logSecurityEvent(type, details = {}) {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), type, ...details }));
}

const _dbClient = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
// Thin async adapter over the libSQL/Turso client, presenting node:sqlite's
// prepare().get/all/run shape so call sites only needed an `await` added. undefined
// args are coerced to null (libSQL rejects undefined); .get returns undefined for no row.
function _bindArgs(a) { return a.map(v => (v === undefined ? null : v)); }
const db = {
  prepare(sql) {
    return {
      async get(...a) { const r = await _dbClient.execute({ sql, args: _bindArgs(a) }); return r.rows[0]; },
      async all(...a) { const r = await _dbClient.execute({ sql, args: _bindArgs(a) }); return r.rows; },
      async run(...a) {
        const r = await _dbClient.execute({ sql, args: _bindArgs(a) });
        return { changes: Number(r.rowsAffected), lastInsertRowid: r.lastInsertRowid == null ? undefined : Number(r.lastInsertRowid) };
      },
    };
  },
  exec(sql) { return _dbClient.executeMultiple(sql); },
};

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    shift_start TEXT NOT NULL,
    shift_end TEXT NOT NULL,
    onsite_enabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS punches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    direction TEXT NOT NULL,
    source TEXT NOT NULL,
    note TEXT DEFAULT '',
    location TEXT DEFAULT '',
    marked_by TEXT DEFAULT '',
    location_address TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS holidays (
    date TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS leave_balances (
    employee_id TEXT NOT NULL,
    leave_type TEXT NOT NULL,
    balance REAL NOT NULL,
    PRIMARY KEY (employee_id, leave_type)
  );
  CREATE TABLE IF NOT EXISTS leave_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    leave_type TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    reason TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    employee_id TEXT
  );
  CREATE TABLE IF NOT EXISTS permission_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    date TEXT NOT NULL,
    leave_time TEXT NOT NULL,
    reason TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS overtime_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    date TEXT NOT NULL,
    planned_hours REAL,
    reason TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    ip TEXT NOT NULL,
    attempted_at TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_username TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    details TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    role TEXT NOT NULL,
    employee_id TEXT,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
  );
  -- Recorded field trips for fuel reimbursement — just the distance and where/when, for
  -- the accounts team to review. No fuel-cost calculation, by design.
  CREATE TABLE IF NOT EXISTS field_trips (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id  TEXT NOT NULL,
    date         TEXT NOT NULL,
    recorded_at  TEXT NOT NULL,
    from_address TEXT NOT NULL,
    to_address   TEXT NOT NULL,
    distance_km  REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_field_trips_emp ON field_trips(employee_id, id);
  -- Admin-editable runtime configuration; see SETTING_DEFS. Only keys defined there
  -- are ever read, so a stale row from a removed setting is inert rather than harmful.
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS breaks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    start_ts TEXT NOT NULL,
    end_ts TEXT
  );
`;

const {
  getEmployee, getPunchesForDay, getBreaksForDay, getShiftForDate, getHoliday,
  getApprovedLeaveForDate, getApprovedPermissionForDate, computeDayStatus,
} = createAttendanceLogic(db);

const LEAVE_TYPES = ['Casual Leave', 'Sick Leave', 'Comp Off'];
// Casual/Sick are no longer a depleting annual pool — each resets every calendar
// month, capped at MONTHLY_PAID_LEAVE_CAP paid days; anything beyond that in the
// same month is unpaid (always allowed, just not paid). Comp Off is unaffected —
// still a running balance, since it's already-earned time rather than a benefit.
const MONTHLY_PAID_LEAVE_TYPES = ['Casual Leave', 'Sick Leave'];
const MONTHLY_PAID_LEAVE_CAP = 1;
// Only leave types still on the old balance-pool model get a leave_balances row.
const BALANCE_POOL_LEAVE_TYPES = LEAVE_TYPES.filter(t => !MONTHLY_PAID_LEAVE_TYPES.includes(t));
const DEFAULT_LEAVE_BALANCE = { 'Comp Off': 0 };
// Employment type, not job title — see `designation` for the free-text position name.
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Hourly basis', 'Contract'];
// Placeholder names — real branch names/locations to replace these later.
const BRANCHES = ['Branch 1', 'Branch 2', 'Branch 3'];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return attempt.length === expected.length && crypto.timingSafeEqual(attempt, expected);
}

// Keyed on username+IP together, not username alone — a username-only lockout would let
// anyone lock a real user out of their account with 5 bad requests from any network.
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
async function isLoginRateLimited(username, ip) {
  const windowStart = formatTimestamp(new Date(Date.now() - LOGIN_RATE_LIMIT_WINDOW_MS));
  const row = await db.prepare(
    'SELECT COUNT(*) AS c FROM login_attempts WHERE username = ? AND ip = ? AND success = 0 AND attempted_at >= ?'
  ).get(username, ip, windowStart);
  return row.c >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS;
}
async function recordLoginAttempt(username, ip, success) {
  await db.prepare('INSERT INTO login_attempts (username, ip, attempted_at, success) VALUES (?, ?, ?, ?)')
    .run(username, ip, formatTimestamp(new Date()), success ? 1 : 0);
}
async function requiresPasswordChange(userId) {
  const row = await db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(userId);
  return !!(row && row.must_change_password);
}

// Demo seed: five placeholder employees (EMP-001..5 / "password123") plus an
// "admin" / "admin123" account. These are fixed, publicly-known credentials, so they
// must never exist on an internet-reachable deployment — must_change_password=1 only
// forces a rotation *after* someone logs in, which is a race the attacker can win.
// Opt-in via SEED_DEMO_DATA=true for local development only; leave it unset everywhere else.
const SEED_DEMO_DATA = process.env.SEED_DEMO_DATA === 'true';

// Production bootstrap: with the demo seed off, a fresh database has no accounts at
// all and nobody can log in. Setting ADMIN_BOOTSTRAP_PASSWORD creates exactly one
// "admin" account with that password (and must_change_password=1) the first time the
// users table is found empty — so the first credential in production is one only you
// know. Unset it again once you have logged in and rotated the password.
const ADMIN_BOOTSTRAP_PASSWORD = process.env.ADMIN_BOOTSTRAP_PASSWORD || '';

// One-time async setup: create schema, run column migrations, sweep long-dead
// sessions, and seed first-run data. Runs once before the server accepts requests
// (CommonJS can't top-level await, and the libSQL client is async).
async function init() {
  await db.exec(SCHEMA_SQL);

  // Column migrations for databases created before these columns existed.
  for (const col of ["location TEXT DEFAULT ''", "marked_by TEXT DEFAULT ''", "location_address TEXT DEFAULT ''"]) {
    try { await db.exec(`ALTER TABLE punches ADD COLUMN ${col}`); } catch { /* already exists */ }
  }
  try { await db.exec('ALTER TABLE employees ADD COLUMN onsite_enabled INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
  try { await db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
  // The biometric device's own enrolled user ID (small integer, e.g. "1"), distinct
  // from this app's EMP-00N id, so ADMS pushes can be matched to an employee.
  try { await db.exec('ALTER TABLE employees ADD COLUMN device_pin TEXT'); } catch { /* already exists */ }
  // Existing employees (seeded before this column existed) will have date_joined = NULL —
  // the dashboard/admin views treat that as "unknown", not an error.
  try { await db.exec('ALTER TABLE employees ADD COLUMN date_joined TEXT'); } catch { /* already exists */ }
  try { await db.exec('ALTER TABLE employees ADD COLUMN role TEXT'); } catch { /* already exists */ }
  // References employees.id (the manager), nullable for anyone with no manager
  // (e.g. the most senior person). No FK constraint — SQLite/libSQL enforcement
  // of it would complicate deletes; the registration form only offers real IDs.
  try { await db.exec('ALTER TABLE employees ADD COLUMN reports_to TEXT'); } catch { /* already exists */ }
  try {
    await db.exec('ALTER TABLE employees ADD COLUMN designation TEXT');
    // One-time backfill, only reachable the moment this column is first created: `role`
    // used to be a free-text job title before it was repurposed into a fixed
    // employment-type dropdown (see EMPLOYMENT_TYPES) — preserve any existing value as
    // `designation` instead of silently losing it, then clear the now-stale `role`.
    await db.exec("UPDATE employees SET designation = role, role = NULL WHERE role IS NOT NULL");
  } catch { /* already exists */ }
  try { await db.exec('ALTER TABLE employees ADD COLUMN branch TEXT'); } catch { /* already exists */ }
  // Employee-chosen UI language (English/Tamil) — admin accounts never set this away
  // from the default, since the toggle only renders for role 'employee'.
  try { await db.exec("ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en'"); } catch { /* already exists */ }
  // Field trips used to be reimbursed on the honor system — any trip an employee logged
  // was final. Existing rows backfill to 'approved' so past reimbursements aren't
  // silently un-approved by this migration; only new trips start 'pending'. Each ALTER
  // gets its own try/catch (not one shared block) so they stay independently safe to
  // re-run on every cold start, regardless of which one landed in an earlier deploy.
  try {
    await db.exec("ALTER TABLE field_trips ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
    await db.exec("UPDATE field_trips SET status = 'approved'");
  } catch { /* already exists */ }
  try { await db.exec('ALTER TABLE field_trips ADD COLUMN decided_at TEXT'); } catch { /* already exists */ }

  // India's three compulsory national holidays (Republic Day, Independence Day, Gandhi
  // Jayanti) — fixed Gregorian dates, mandated nationwide regardless of state, unlike
  // festival/gazetted holidays which vary by region and aren't seeded here. Idempotent
  // (INSERT OR IGNORE on the date primary key) so this is safe to run every startup;
  // covers a fixed multi-year range rather than just the current year.
  for (let year = 2024; year <= 2030; year++) {
    const nationalHolidays = [
      [`${year}-01-26`, 'Republic Day'],
      [`${year}-08-15`, 'Independence Day'],
      [`${year}-10-02`, 'Gandhi Jayanti'],
    ];
    for (const [date, name] of nationalHolidays) {
      await db.prepare('INSERT OR IGNORE INTO holidays (date, name) VALUES (?, ?)').run(date, name);
    }
  }

  // Sweep sessions already past the absolute TTL so restarts don't leave dead rows.
  await db.prepare('DELETE FROM sessions WHERE created_at < ?').run(Date.now() - SESSION_ABSOLUTE_TTL_MS);

  // First-run account setup. Two mutually exclusive paths, both keyed on the database
  // being empty so neither can ever overwrite real data on a later cold start:
  //   - SEED_DEMO_DATA=true         -> the full demo fixture (local development only)
  //   - ADMIN_BOOTSTRAP_PASSWORD    -> a single admin account with a password only you know
  // With neither set, a fresh database stays empty and logs a warning rather than
  // silently creating a well-known credential on a public URL.
  const employeeCount = (await db.prepare('SELECT COUNT(*) AS c FROM employees').get()).c;
  const userCount = (await db.prepare('SELECT COUNT(*) AS c FROM users').get()).c;

  if (SEED_DEMO_DATA && employeeCount === 0) {
    console.warn('SEED_DEMO_DATA=true: seeding demo employees and the admin/admin123 account. Never enable this on a deployment reachable from the internet.');
    for (let i = 1; i <= 5; i++) {
      const id = `EMP-00${i}`;
      await db.prepare('INSERT INTO employees (id, name, shift_start, shift_end) VALUES (?, ?, ?, ?)').run(id, `Employee ${i}`, '09:30', '18:30');
      for (const type of BALANCE_POOL_LEAVE_TYPES) {
        await db.prepare('INSERT INTO leave_balances (employee_id, leave_type, balance) VALUES (?, ?, ?)').run(id, type, DEFAULT_LEAVE_BALANCE[type]);
      }
      await db.prepare('INSERT INTO users (username, password_hash, role, employee_id, must_change_password) VALUES (?, ?, ?, ?, 1)').run(id, hashPassword('password123'), 'employee', id);
    }
    await db.prepare('INSERT INTO users (username, password_hash, role, employee_id, must_change_password) VALUES (?, ?, ?, ?, 1)').run('admin', hashPassword('admin123'), 'admin', null);
  } else if (ADMIN_BOOTSTRAP_PASSWORD && userCount === 0) {
    // Gated on there being no users at all, not just no admin, so this cannot mint a
    // second admin on a database that is already in use.
    await db.prepare('INSERT INTO users (username, password_hash, role, employee_id, must_change_password) VALUES (?, ?, ?, ?, 1)')
      .run('admin', hashPassword(ADMIN_BOOTSTRAP_PASSWORD), 'admin', null);
    console.warn('Bootstrapped the initial "admin" account from ADMIN_BOOTSTRAP_PASSWORD. Log in, change the password, then remove that environment variable.');
  } else if (userCount === 0) {
    console.warn('No user accounts exist and no bootstrap is configured. Set ADMIN_BOOTSTRAP_PASSWORD to create the first admin, or SEED_DEMO_DATA=true for local development.');
  }
}

function formatTimestamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function parseTimestamp(raw) {
  const [datePart, timePart] = raw.split(' ');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi, s] = timePart.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi, s);
}
// See the DEVICE_CLOCK_OFFSET_MINUTES setting — shifts a device-reported "YYYY-MM-DD HH:MM:SS"
// timestamp back by that offset, correctly rolling over date/month/year boundaries.
function correctDeviceTimestamp(raw) {
  const asDate = parseTimestamp(raw);
  asDate.setMinutes(asDate.getMinutes() - CONFIG.DEVICE_CLOCK_OFFSET_MINUTES);
  return formatTimestamp(asDate);
}
async function lastPunch(employeeId) {
  return await db.prepare('SELECT * FROM punches WHERE employee_id = ? ORDER BY timestamp DESC LIMIT 1').get(employeeId);
}
// A retried device push or a double-tapped on-site button can submit the same
// punch twice; treat two punches for the same employee within a few seconds of
// each other as one event rather than two. Deliberately ignores direction: when
// the caller doesn't specify one (the ADMS device path), it's inferred from
// whatever the last recorded punch is — so a retry landing after the first
// attempt's insert would infer the opposite direction and slip past a
// direction-scoped check entirely, which defeats the point of deduping retries.
const PUNCH_DEDUP_WINDOW_SECONDS = 5;
async function isDuplicatePunch(employeeId, timestamp) {
  const target = parseTimestamp(timestamp).getTime();
  const windowStart = formatTimestamp(new Date(target - PUNCH_DEDUP_WINDOW_SECONDS * 1000));
  const windowEnd = formatTimestamp(new Date(target + PUNCH_DEDUP_WINDOW_SECONDS * 1000));
  const existing = await db.prepare(
    'SELECT 1 FROM punches WHERE employee_id = ? AND timestamp BETWEEN ? AND ? LIMIT 1'
  ).get(employeeId, windowStart, windowEnd);
  return !!existing;
}
// Returns whether a new row was actually inserted — false means an existing
// punch within the dedup window already covers this one, so it was skipped.
async function recordPunch(employeeId, timestamp, direction, source, note = '', location = '', markedBy = '', locationAddress = '') {
  if (await isDuplicatePunch(employeeId, timestamp)) return false;
  await db.prepare('INSERT INTO punches (employee_id, timestamp, direction, source, note, location, marked_by, location_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(employeeId, timestamp, direction, source, note, location, markedBy, locationAddress);
  return true;
}
async function getEmployeeByDevicePin(pin) {
  return await db.prepare('SELECT * FROM employees WHERE device_pin = ?').get(String(pin));
}
// Same in/out inference /api/punch uses when the caller doesn't say which — kept
// separate rather than shared, since /api/punch's version also honors an explicit
// direction override from the request body, which ADMS pushes never provide.
async function ingestBiometricPunch(employeeId, timestamp) {
  const last = await lastPunch(employeeId);
  const direction = (last && last.direction === 'in') ? 'out' : 'in';
  const inserted = await recordPunch(employeeId, timestamp, direction, 'biometric');
  return { direction, inserted };
}
async function createNotification(employeeId, message) {
  await db.prepare('INSERT INTO notifications (employee_id, message, created_at, read) VALUES (?, ?, ?, 0)')
    .run(employeeId, message, formatTimestamp(new Date()));
}
async function logAdminAction(actorUsername, action, targetType, targetId, details = '') {
  await db.prepare(
    'INSERT INTO admin_audit_log (actor_username, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(actorUsername, action, targetType, String(targetId), details, formatTimestamp(new Date()));
}
async function getAdminAuditLog(limit = 200) {
  return await db.prepare('SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
}
async function getNotifications(employeeId) {
  return await db.prepare('SELECT * FROM notifications WHERE employee_id = ? ORDER BY created_at DESC').all(employeeId);
}
async function getAllNotifications() {
  return await db.prepare('SELECT * FROM notifications ORDER BY created_at DESC').all();
}
async function unreadNotificationCount(employeeId) {
  return await db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE employee_id = ? AND read = 0').get(employeeId).c;
}
async function unreadNotificationCountAll() {
  return await db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE read = 0').get().c;
}
// Casual/Sick are computed
// fresh each call from this calendar month's approved requests (no stored balance to
// read); Comp Off still reads its running balance from leave_balances, unchanged.
async function getLeaveBalanceDisplay(employeeId) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const monthStr = String(month).padStart(2, '0');
  const monthStart = `${year}-${monthStr}-01`;
  const monthEnd = `${year}-${monthStr}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;

  const result = [];
  for (const type of MONTHLY_PAID_LEAVE_TYPES) {
    const requests = await db.prepare(
      "SELECT start_date, end_date FROM leave_requests WHERE employee_id = ? AND leave_type = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?"
    ).all(employeeId, type, monthEnd, monthStart);
    let takenThisMonth = 0;
    for (const r of requests) {
      const clippedStart = r.start_date < monthStart ? monthStart : r.start_date;
      const clippedEnd = r.end_date > monthEnd ? monthEnd : r.end_date;
      takenThisMonth += countLeaveDays(clippedStart, clippedEnd);
    }
    const unpaidThisMonth = Math.max(0, takenThisMonth - MONTHLY_PAID_LEAVE_CAP);
    result.push({
      leave_type: type,
      balance: Math.max(0, MONTHLY_PAID_LEAVE_CAP - takenThisMonth),
      unpaidDays: unpaidThisMonth,
      caption: unpaidThisMonth > 0
        ? `Paid left this month — ${unpaidThisMonth} unpaid day${unpaidThisMonth === 1 ? '' : 's'} taken`
        : 'Paid left this month',
    });
  }
  for (const type of BALANCE_POOL_LEAVE_TYPES) {
    const row = await db.prepare('SELECT balance FROM leave_balances WHERE employee_id = ? AND leave_type = ?').get(employeeId, type);
    result.push({ leave_type: type, balance: row ? row.balance : 0, caption: null });
  }
  return result;
}
async function getLeaveRequests(employeeId) {
  return await db.prepare('SELECT * FROM leave_requests WHERE employee_id = ? ORDER BY requested_at DESC').all(employeeId);
}
async function getAllLeaveRequests() {
  return await db.prepare('SELECT * FROM leave_requests ORDER BY requested_at DESC').all();
}
function countLeaveDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  return Math.round((end - start) / 86400000) + 1;
}
async function getPermissionRequests(employeeId) {
  return await db.prepare('SELECT * FROM permission_requests WHERE employee_id = ? ORDER BY requested_at DESC').all(employeeId);
}
async function getAllPermissionRequests() {
  return await db.prepare('SELECT * FROM permission_requests ORDER BY requested_at DESC').all();
}
async function getPermissionForDate(employeeId, dateStr) {
  return await db.prepare(
    'SELECT * FROM permission_requests WHERE employee_id = ? AND date = ? ORDER BY requested_at DESC LIMIT 1'
  ).get(employeeId, dateStr);
}
async function getOvertimeRequests(employeeId) {
  return await db.prepare('SELECT * FROM overtime_requests WHERE employee_id = ? ORDER BY requested_at DESC').all(employeeId);
}
async function getAllOvertimeRequests() {
  return await db.prepare('SELECT * FROM overtime_requests ORDER BY requested_at DESC').all();
}
async function getApprovedOvertimeForDate(employeeId, dateStr) {
  return await db.prepare(
    "SELECT * FROM overtime_requests WHERE employee_id = ? AND date = ? AND status = 'approved'"
  ).get(employeeId, dateStr);
}


const OVERTIME_ROUND_MINUTES = 15; // ignore anything under a quarter-hour past shift end

// Overtime is computed independently of await computeDayStatus() — it's a separate signal
// (authorized/unauthorized hours worked beyond the shift), not an attendance status,
// so it never overrides or interacts with Late/Half Day/Present.
async function computeOvertimeMinutes(employee, dateStr) {
  const punches = await getPunchesForDay(employee.id, dateStr);
  // Unresolved day (no punches, or an odd count — still "in progress" or a punch error):
  // no verified overtime until the day actually resolves to a real checkout.
  if (punches.length === 0 || punches.length % 2 !== 0) return 0;
  const checkIn = punches[0];
  const checkOut = punches[punches.length - 1];
  // A synthetic auto-checkout is not a real punch — never count it as verified overtime,
  // or "forgot to punch out" quietly becomes free overtime hours.
  if (checkOut.source === 'auto') return 0;

  const shift = getShiftForDate(employee, dateStr);
  const scheduledMinutes = parseTimeToMinutes(shift.end) - parseTimeToMinutes(shift.start);
  const inMs = new Date(checkIn.timestamp.replace(' ', 'T')).getTime();
  const outMs = new Date(checkOut.timestamp.replace(' ', 'T')).getTime();
  const workedMinutes = (outMs - inMs) / 60000;
  const rawOvertime = Math.max(0, workedMinutes - scheduledMinutes);
  return Math.floor(rawOvertime / OVERTIME_ROUND_MINUTES) * OVERTIME_ROUND_MINUTES;
}

async function isOvertimeAuthorized(employeeId, dateStr) {
  return !!(await getApprovedOvertimeForDate(employeeId, dateStr));
}

function formatMinutesAsHM(minutes) {
  if (!minutes) return '0h';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// hoursWorked is stored as decimal hours (e.g. 0.16) — hard to read at a glance, so
// the dashboard/daily-table clock displays convert it to HH:MM instead, matching the
// live in-progress timer's own H:MM:SS style rather than showing raw decimals.
function formatHoursAsClock(hours) {
  const totalMinutes = Math.round((hours || 0) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Cumulative overtime for one employee across a month, split authorized vs unauthorized.
// Mirrors the day-by-day iteration await renderCalendar() already does for await computeDayStatus().
async function computeMonthlyOvertimeSummary(employee, year, month) {
  const monthStr = String(month).padStart(2, '0');
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = todayStr();
  const dateStrs = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${monthStr}-${String(d).padStart(2, '0')}`;
    if (dateStr <= today) dateStrs.push(dateStr); // don't project overtime for future days
  }
  // Same fix as Calendar/Reports: each day's own pair of calls (minutes, then
  // authorized-if-positive) stays sequential, but different days now run
  // concurrently instead of one after another across the whole month.
  const perDay = await Promise.all(dateStrs.map(async dateStr => {
    const minutes = await computeOvertimeMinutes(employee, dateStr);
    if (minutes <= 0) return { minutes: 0, authorized: false };
    return { minutes, authorized: await isOvertimeAuthorized(employee.id, dateStr) };
  }));
  let authorizedMinutes = 0;
  let unauthorizedMinutes = 0;
  for (const { minutes, authorized } of perDay) {
    if (minutes <= 0) continue;
    if (authorized) authorizedMinutes += minutes;
    else unauthorizedMinutes += minutes;
  }
  return { authorizedMinutes, unauthorizedMinutes };
}

// Permission hours are tracked/shown, not enforced — same philosophy as leave balances
// in this app: nothing blocks a request, admin sees the numbers and decides.
const PERMISSION_MONTHLY_CAP_HOURS = 4;
const PERMISSION_DAILY_CAP_HOURS = 2;

// A permission request models "leaving early, not returning for the rest of the shift" —
// hours are derived from the gap between the leave time and shift end, not a separate
// field, so they can never drift out of sync with what was actually requested.
function computePermissionHours(employee, dateStr, leaveTime) {
  const shift = getShiftForDate(employee, dateStr);
  const minutes = parseTimeToMinutes(shift.end) - parseTimeToMinutes(leaveTime);
  return Math.max(0, Math.round((minutes / 60) * 100) / 100);
}

async function computeMonthlyPermissionSummary(employeeId, year, month) {
  const employee = await getEmployee(employeeId);
  const monthStr = String(month).padStart(2, '0');
  const approved = await db.prepare(
    "SELECT date, leave_time FROM permission_requests WHERE employee_id = ? AND status = 'approved' AND date LIKE ?"
  ).all(employeeId, `${year}-${monthStr}-%`);
  const usedHours = Math.round(
    approved.reduce((sum, r) => sum + computePermissionHours(employee, r.date, r.leave_time), 0) * 100
  ) / 100;
  return { usedHours, remainingHours: Math.round((PERMISSION_MONTHLY_CAP_HOURS - usedHours) * 100) / 100 };
}

// --- Admin monthly reports: per-employee punch-in and leave summaries, for the
// admin to review on-screen and export as CSV to send to accounts. ---
function parseMonthParam(parsed) {
  const raw = parsed.searchParams.get('month');
  if (raw && /^\d{4}-\d{2}$/.test(raw)) {
    const [y, m] = raw.split('-').map(Number);
    return { year: y, month: m, monthStr: raw };
  }
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  return { year, month, monthStr: `${year}-${String(month).padStart(2, '0')}` };
}

// Mirrors the day-by-day iteration computeMonthlyOvertimeSummary() already does —
// same "skip future days" rule, so a report run mid-month doesn't count Upcoming
// days as Absent.
// Shared by all three day-level reports below (summary/grid/muster) — each used to
// independently re-walk every employee x day itself (calling computeDayStatus 3x per
// day, sequentially), which is what made the Reports page slow. computeDayStatus does
// 2-4 of its own DB round-trips internally, so tripling it per day compounded fast.
// This computes each employee x day status ONCE, and fires every employee's day-walk
// concurrently instead of one employee after another.
async function computeMonthlyStatusGrid(year, month) {
  const monthStr = String(month).padStart(2, '0');
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = todayStr();
  const employees = await allEmployees();
  const dateStrs = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${monthStr}-${String(d).padStart(2, '0')}`;
    if (dateStr <= today) dateStrs.push(dateStr);
  }
  const perEmployee = await Promise.all(employees.map(async employee => {
    const statuses = await Promise.all(dateStrs.map(dateStr => computeDayStatus(employee.id, dateStr)));
    const overtimeMinutesByDay = await Promise.all(dateStrs.map(dateStr => computeOvertimeMinutes(employee, dateStr)));
    return { employee, statuses, overtimeMinutesByDay };
  }));
  return { daysInMonth, perEmployee };
}

function computePunchInReport(grid) {
  return grid.perEmployee.map(({ employee, statuses, overtimeMinutesByDay }) => {
    let present = 0, late = 0, halfDay = 0, absent = 0, totalHours = 0;
    for (const status of statuses) {
      if (status.status === 'Present') present++;
      else if (status.status === 'Late') late++;
      else if (status.status === 'Half Day') halfDay++;
      else if (status.status === 'Absent') absent++;
      totalHours += status.hoursWorked || 0;
    }
    const overtimeMinutes = overtimeMinutesByDay.reduce((sum, m) => sum + m, 0);
    return {
      id: employee.id, name: employee.name, present, late, halfDay, absent,
      totalHours: Math.round(totalHours * 100) / 100,
      overtimeHours: Math.round((overtimeMinutes / 60) * 100) / 100,
    };
  });
}

async function computeLeaveReport(year, month) {
  const monthStr = String(month).padStart(2, '0');
  const monthStart = `${year}-${monthStr}-01`;
  const monthEnd = `${year}-${monthStr}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
  const employees = await allEmployees();
  const rows = await Promise.all(employees.map(async employee => {
    const requests = await db.prepare(
      "SELECT leave_type, start_date, end_date FROM leave_requests WHERE employee_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?"
    ).all(employee.id, monthEnd, monthStart);
    const perType = {};
    for (const type of LEAVE_TYPES) perType[type] = 0;
    for (const r of requests) {
      // Clip the request to the report month — a leave spanning month-end shouldn't
      // count days that fall outside the month being reported.
      const clippedStart = r.start_date < monthStart ? monthStart : r.start_date;
      const clippedEnd = r.end_date > monthEnd ? monthEnd : r.end_date;
      perType[r.leave_type] = (perType[r.leave_type] || 0) + countLeaveDays(clippedStart, clippedEnd);
    }
    const totalDays = Object.values(perType).reduce((sum, v) => sum + v, 0);
    // Casual/Sick beyond the monthly paid cap is unpaid — see MONTHLY_PAID_LEAVE_TYPES.
    const unpaidDays = MONTHLY_PAID_LEAVE_TYPES.reduce((sum, t) => sum + Math.max(0, (perType[t] || 0) - MONTHLY_PAID_LEAVE_CAP), 0);
    return { id: employee.id, name: employee.name, perType, totalDays, unpaidDays };
  }));
  return rows;
}

function formatHHMM(timestamp) {
  return timestamp ? timestamp.split(' ')[1].slice(0, 5) : null;
}

// Shared between the Punch-In and Muster grids: compact status codes and a
// background tint per status, so both reports read the same way at a glance.
// Late is a brighter pastel yellow than the rest — deliberately more attention-
// grabbing than the app's usual amber, since it's the one admins scan for first.
const MUSTER_STATUS_CODE = {
  'Present': 'P', 'Late': 'L', 'Half Day': 'HD', 'Absent': 'A',
  'Week Off': 'WO', 'Holiday': 'H', 'Punch Error': 'PE', 'Active': 'AC', 'On Leave': 'OL',
};
const GRID_CELL_COLOR = {
  'Present': '#E8F5E9',
  'Late': '#FFF9C4',
  'Half Day': '#FBE7DE',
  'Absent': '#FDECEA',
  'Week Off': '#F0F0F0',
  'Holiday': '#E0F2F1',
  'Punch Error': '#FDE4E1',
  'Active': '#E3F2FD',
  'On Leave': '#F3E5F5',
  'Upcoming': 'transparent',
};
// Present/Late/Half Day/Active all mean "showed up in some form" for headcount purposes.
const MUSTER_PRESENT_STATUSES = new Set(['Present', 'Late', 'Half Day', 'Active']);

// Grid, not a log: one row per employee, one column per day of the month — each cell
// is that day's check-in/check-out ("L " prefix = late), or the day's status code
// (WO/H/OL/A/...) on days with no punches. Mirrors the Muster report's shape.
function computePunchInGrid(grid) {
  const rows = grid.perEmployee.map(({ employee, statuses }) => {
    const cells = statuses.map(status => {
      let text;
      if (status.checkIn) {
        const inStr = formatHHMM(status.checkIn);
        const outStr = status.checkOut ? formatHHMM(status.checkOut) : '?';
        text = `${status.late ? 'L ' : ''}${inStr}-${outStr}`;
      } else {
        text = MUSTER_STATUS_CODE[status.status] ?? status.status;
      }
      return { text, status: status.status };
    });
    // Days after today (rest of the month) have no status yet — pad so every row
    // still has one cell per calendar day, matching the header.
    while (cells.length < grid.daysInMonth) cells.push({ text: '', status: 'Upcoming' });
    return { id: employee.id, name: employee.name, cells };
  });
  return { daysInMonth: grid.daysInMonth, rows };
}

// Muster roll: every employee x every day of the month as a compact status grid,
// with a per-day "how many were in" headcount row — the classic attendance-register
// format, distinct from the Punch-In reports' per-employee totals/times.
function computeMusterReport(grid) {
  const dailyPresentCounts = new Array(grid.daysInMonth).fill(0);
  const rows = grid.perEmployee.map(({ employee, statuses }) => {
    const cells = statuses.map((status, i) => {
      if (MUSTER_PRESENT_STATUSES.has(status.status)) dailyPresentCounts[i]++;
      return { code: MUSTER_STATUS_CODE[status.status] ?? status.status, status: status.status };
    });
    const presentDays = cells.filter(c => MUSTER_PRESENT_STATUSES.has(c.status)).length;
    while (cells.length < grid.daysInMonth) cells.push({ code: '', status: 'Upcoming' });
    return { id: employee.id, name: employee.name, cells, presentDays };
  });
  return { daysInMonth: grid.daysInMonth, rows, dailyPresentCounts };
}

// --- Auto-checkout: unmatched punch-in gets a synthetic punch-out once per day at/after AUTO_CHECKOUT_HOUR ---
let lastAutoCheckoutDate = null;
async function performAutoCheckout() {
  const today = todayStr();
  // Vercel's Hobby cron only guarantees per-hour precision, so this can actually run
  // any time in the 19:00-19:59 window. Pin the recorded time to AUTO_CHECKOUT_HOUR
  // sharp rather than stamping whenever the invocation happened to land.
  const cutoff = new Date();
  cutoff.setHours(AUTO_CHECKOUT_HOUR, 0, 0, 0);
  const cutoffTs = formatTimestamp(cutoff);
  const employees = await db.prepare('SELECT id FROM employees').all();
  for (const emp of employees) {
    const punches = await getPunchesForDay(emp.id, today);
    if (punches.length % 2 !== 0) {
      await recordPunch(emp.id, cutoffTs, 'out', 'auto', 'auto-checkout');
      await createNotification(emp.id, `You were auto-checked out at ${AUTO_CHECKOUT_HOUR}:00. Make sure that you check out next time.`);
      console.log(`Auto-checked-out ${emp.id} (forgot to punch out)`);
    }
    // Also close out any break left open past end of day, so it doesn't linger open
    // forever and keep skewing tomorrow's queries (breaks are looked up by start_ts).
    // Same pinned cutoff as above, so a break never appears to end after the
    // synthetic checkout it's attached to.
    await db.prepare("UPDATE breaks SET end_ts = ? WHERE employee_id = ? AND end_ts IS NULL AND start_ts LIKE ?")
      .run(cutoffTs, emp.id, `${today}%`);
  }
}
async function checkAndRunAutoCheckout() {
  const now = new Date();
  const today = todayStr(now);
  if (lastAutoCheckoutDate === today) return;
  if (now.getHours() < AUTO_CHECKOUT_HOUR) return;
  await performAutoCheckout();
  lastAutoCheckoutDate = today;
}
// The catch-up call and interval are started after init() (see startup at the bottom),
// since the DB schema isn't ready at module load anymore.

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATUS_STYLE = {
  'Present':     { fg: '#2E7D32', bg: '#E8F5E9' },
  'Late':        { fg: '#B26A00', bg: '#FFF3E0' },
  'Half Day':    { fg: '#C24914', bg: '#FBE7DE' },
  'Absent':      { fg: '#C62828', bg: '#FDECEA' },
  'Week Off':    { fg: '#616161', bg: '#F0F0F0' },
  'Holiday':     { fg: '#00695C', bg: '#E0F2F1' },
  'Punch Error': { fg: '#B71C1C', bg: '#FDE4E1' },
  'Active':      { fg: '#1565C0', bg: '#E3F2FD' },
  'Upcoming':    { fg: '#9E9E9E', bg: '#FAFAFA' },
  'On Leave':    { fg: '#6A1B9A', bg: '#F3E5F5' },
};
// `label`, when given, is already caller-composed display text (e.g. a holiday name or
// "Pending (14:00)") and is used verbatim — only the bare status word (the fallback when
// label is omitted) gets translated, since that's the one guaranteed to be one of the
// fixed STATUS_STYLE keys rather than freeform text.
// Shared by the Dashboard's and Leave page's balance-card rows — leave_type/caption
// come back from getLeaveBalanceDisplay() as canonical English, translated only here
// at render time so the DB/logic side never has to know about language.
function leaveBalanceCardsHtml(balances, lang) {
  return balances.map(b => {
    const label = t(lang, `leave_type.${b.leave_type}`);
    const caption = b.caption == null ? null
      : (b.unpaidDays > 0 ? t(lang, 'leave.caption_paid_left_unpaid', { n: b.unpaidDays }) : t(lang, 'leave.caption_paid_left'));
    return `
    <div style="background:#F5F6F8;border-radius:10px;padding:14px 18px;min-width:130px;">
      <div style="font-size:1.6em;font-weight:700;">${b.balance}</div>
      <div style="color:#7C8896;font-size:0.85em;">${escapeHtml(label)}</div>
      ${caption ? `<div style="color:#9AA5B1;font-size:0.7em;margin-top:2px;">${escapeHtml(caption)}</div>` : ''}
    </div>`;
  }).join('');
}
function statusBadge(status, label, lang = 'en') {
  const s = STATUS_STYLE[status] || STATUS_STYLE['Upcoming'];
  return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:0.82em;font-weight:600;color:${s.fg};background:${s.bg};">${escapeHtml(label || t(lang, `status.${status}`))}</span>`;
}

// A punch's location cell: shows the reverse-geocoded address when available (falling
// back to raw coords), always linking to the exact coordinates on a map for precision.
function locationCell(p) {
  const label = p.location_address || p.location;
  if (!label) return '—';
  const mapQuery = p.location || p.location_address;
  return `<a href="https://www.google.com/maps?q=${encodeURIComponent(mapQuery)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
}

// A same-origin POST wrapped to look and sit like the plain text links it replaces —
// state-changing actions must be POST (see docs/designs/security-hardening.md, item 2),
// so a bare <a href> can no longer trigger them.
function actionButton(actionPath, fields, label, color, marginRight = false) {
  const inputs = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(String(v))}">`).join('');
  return `<form method="POST" action="${actionPath}" style="display:inline-block;${marginRight ? 'margin-right:12px;' : ''}">${inputs}<button type="submit" style="background:none;border:none;padding:0;font:inherit;cursor:pointer;color:${color};font-weight:600;text-decoration:none;">${escapeHtml(label)}</button></form>`;
}

async function allEmployees() {
  return await db.prepare('SELECT * FROM employees ORDER BY id').all();
}

async function employeeSwitcher(currentId, basePath) {
  const options = (await allEmployees()).map(e =>
    `<option value="${escapeHtml(e.id)}" ${e.id === currentId ? 'selected' : ''}>${escapeHtml(e.name)} (${escapeHtml(e.id)})</option>`
  ).join('');
  return `<select onchange="location.href='${basePath}?employee_id=' + this.value" style="font-size:0.95em;padding:6px 10px;border-radius:6px;border:1px solid #D0D5DA;">${options}</select>`;
}

const ADMIN_TABLE_VIEWS = ['dashboard', 'leave', 'onsite', 'permission', 'overtime', 'notifications', 'device-pins', 'field-trip', 'employee-registration', 'reports', 'calendar-company', 'settings']; // table pages — no single-employee switcher here

async function pageShell(title, employeeId, activeNav, bodyHtml, user) {
  const isAdmin = user && user.role === 'admin';
  const lang = langOf(user);
  const showSwitcher = isAdmin && !ADMIN_TABLE_VIEWS.includes(activeNav);
  // A same-page-return POST toggle, same pattern as calendarViewToggle — no separate
  // settings page, just flips the account's language and redirects right back.
  const currentPath = `/${activeNav === 'calendar-company' ? 'calendar' : activeNav}?employee_id=${encodeURIComponent(employeeId)}`;
  const langToggle = (!isAdmin && user) ? `
    <form method="POST" action="/settings/language?return=${encodeURIComponent(currentPath)}" style="display:flex;gap:6px;">
      <button type="submit" name="lang" value="en" style="flex:1;padding:5px 0;border-radius:6px;border:1px solid ${lang === 'en' ? '#1565C0' : '#D0D5DA'};background:${lang === 'en' ? '#E3F2FD' : '#fff'};color:${lang === 'en' ? '#1565C0' : '#4C5A68'};font-weight:700;font-size:0.82em;cursor:pointer;">EN</button>
      <button type="submit" name="lang" value="ta" style="flex:1;padding:5px 0;border-radius:6px;border:1px solid ${lang === 'ta' ? '#1565C0' : '#D0D5DA'};background:${lang === 'ta' ? '#E3F2FD' : '#fff'};color:${lang === 'ta' ? '#1565C0' : '#4C5A68'};font-weight:700;font-size:0.82em;cursor:pointer;">தமிழ்</button>
    </form>` : '';
  const rightSide = isAdmin
    ? `${showSwitcher ? await employeeSwitcher(employeeId, '/' + activeNav) : ''}<a href="/logout" style="color:#4C5A68;font-size:0.9em;text-decoration:none;">Logout (${escapeHtml(user.username)})</a>`
    : `<span style="color:#4C5A68;font-size:0.9em;">${escapeHtml((user && user.username) || '')}</span><a href="/logout" style="color:#4C5A68;font-size:0.9em;text-decoration:none;">${t(lang, 'nav.logout')}</a>`;
  return `<html lang="${lang}"><head><title>${escapeHtml(title)}</title>
    ${PWA_HEAD_TAGS}
    <style>
      body { font-family: -apple-system, "Segoe UI", sans-serif; background: #F5F6F8; color: #1B2430; margin: 0; }
      /* .main spans the space right of the sidebar and centers .wrap within it,
         rather than .wrap just starting flush against the sidebar's edge. */
      .main { margin-left: 208px; display: flex; justify-content: center; }
      .wrap { max-width: 720px; width: 100%; padding: 24px; box-sizing: border-box; }
      /* Desktop/tablet default: nav is a persistent left sidebar (not an overlay) —
         .main's margin-left reserves its column. Collapses into an off-canvas rail
         under 641px instead, see the media query below. */
      nav {
        position: fixed; left: 0; top: 0; bottom: 0; width: 208px;
        display: flex; flex-direction: column; gap: 4px;
        background: #fff; border-right: 1px solid #E1E5E9;
        padding: 20px 14px; overflow-y: auto; box-sizing: border-box; z-index: 10;
      }
      nav .brand { font-weight: 700; font-size: 1.05em; padding: 0 8px 18px; }
      nav .links { display: flex; flex-direction: column; gap: 2px; flex: 1; }
      nav .links a {
        display: flex; align-items: center; gap: 10px;
        text-decoration: none; color: #4C5A68; font-weight: 600; font-size: 0.9em;
        padding: 9px 10px; border-radius: 8px;
      }
      nav .links a.active { color: #1565C0; background: #E3F2FD; }
      nav .acct {
        border-top: 1px solid #EEF1F3; padding-top: 14px; margin-top: 10px;
        display: flex; flex-direction: column; gap: 10px; font-size: 0.9em;
      }
      nav .acct select { width: 100%; }
      /* Mobile-only duplicate of the same switcher/logout controls, shown as a top
         bar instead — the off-canvas rail is too narrow to hold them (see below). */
      .topbar-mobile { display: none; }
      .card { background: #fff; border: 1px solid #E1E5E9; border-radius: 12px; padding: 20px; margin-bottom: 16px; overflow-x: auto; }
      /* 16px stops iOS Safari's auto-zoom-on-focus; max-width keeps this app's
         several fixed-px-width inputs from overflowing on narrow phones. */
      input, select, button { font-size: 16px; max-width: 100%; box-sizing: border-box; }
      table { border-collapse: collapse; width: 100%; }
      th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #EEF1F3; font-size: 0.92em; }
      th { color: #7C8896; font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.04em; }
      /* Day-by-day report grids (Punch-In Detail, Muster): thin boxed cells, all the
         same size within a table (table-layout:fixed + widths on the header row),
         rather than the plain row-list styling above. */
      .grid-table { table-layout: fixed; width: auto; font-size: 0.85em; }
      .grid-table th, .grid-table td { border: 1px solid #E1E5E9; padding: 5px 4px; text-align: center; white-space: nowrap; }
      .grid-table th:first-child, .grid-table td:first-child { text-align: left; width: 170px; }
      #navToggle, #navBackdrop { display: none; }
      /* Phones: the sidebar becomes an off-canvas rail (translateX(-100%)) by
         default and only slides into view when #navToggle is tapped, so pages get
         full width back instead of permanently losing a column to it. It's a
         vertical rail rather than a bottom bar because a fixed bar along the
         *bottom* edge was tried first, and on an installed iOS home-screen app
         that edge is where the system's home-indicator swipe-up gesture lives —
         it was intercepting taps before they reached the links. */
      @media (max-width: 640px) {
        .main { margin-left: 0; }
        .wrap { padding: calc(56px + env(safe-area-inset-top)) 16px calc(24px + env(safe-area-inset-bottom)); }
        .topbar-mobile { display: flex; justify-content: flex-end; align-items: center; gap: 14px; margin-bottom: 10px; }
        nav {
          /* Top padding clears #navToggle's own height (40px + its 12px offset)
             plus a gap, so the first item (Dashboard) doesn't render underneath it. */
          padding: calc(64px + env(safe-area-inset-top)) 4px 14px calc(4px + env(safe-area-inset-left));
          width: calc(70px + env(safe-area-inset-left));
          overflow-x: hidden; -webkit-overflow-scrolling: touch;
          transform: translateX(-100%); transition: transform 0.22s ease;
          /* Must beat #navBackdrop's z-index (55) — nav inherits z-index:10 from the
             desktop-sidebar base rule otherwise, so the open backdrop would sit visually
             on top of the open rail and swallow every tap before it reached a link. */
          z-index: 56;
        }
        nav.open { transform: translateX(0); }
        /* No room for the brand/account controls in a 70px rail — the account
           controls reappear via .topbar-mobile above instead. */
        nav .brand, nav .acct { display: none; }
        #navToggle {
          display: flex; align-items: center; justify-content: center;
          position: fixed; z-index: 60;
          top: calc(12px + env(safe-area-inset-top)); left: calc(12px + env(safe-area-inset-left));
          width: 40px; height: 40px; border-radius: 10px;
          background: #fff; border: 1px solid #E1E5E9; font-size: 1.15em;
          box-shadow: 0 1px 4px rgba(0,0,0,0.1);
        }
        #navBackdrop.open {
          display: block; position: fixed; inset: 0; z-index: 55; background: rgba(15,20,25,0.35);
        }
        /* Fixed-height rows (icon over label) instead of squeezed inline text —
           flex:1 1 0 with nowrap text let 7 items overlap each other on narrow
           phones, since the box could shrink below the text's own width. */
        nav .links a {
          flex-direction: column; text-align: center; gap: 1px;
          padding: 8px 2px; border-radius: 10px;
        }
        nav .links a .ico { font-size: 1.2em; line-height: 1; }
        nav .links a .lbl { font-size: 0.6em; font-weight: 600; line-height: 1.15; white-space: nowrap; }
        /* 7 equal columns leave ~45px each on a phone — too tight for the
           dashboard's default padding/font to hold a word like "Upcoming". */
        .cal-grid { gap: 4px; }
        .cal-grid > div { padding: 5px 3px !important; min-height: 42px !important; font-size: 0.9em; }
        .cal-grid .cal-status { font-size: 0.62em !important; line-height: 1.15; }
      }
    </style></head>
    <body>
    <button id="navToggle" aria-label="Menu" onclick="document.querySelector('nav').classList.toggle('open');document.getElementById('navBackdrop').classList.toggle('open');">&#9776;</button>
    <div id="navBackdrop" onclick="document.querySelector('nav').classList.remove('open');this.classList.remove('open');"></div>
    <nav>
      <div class="brand">Attendance Gateway</div>
      <div class="links">
        <a href="/dashboard?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'dashboard' ? 'active' : ''}"><span class="ico">🏠</span> <span class="lbl">${t(lang, 'nav.dashboard')}</span></a>
        <a href="/calendar?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'calendar' || activeNav === 'calendar-company' ? 'active' : ''}"><span class="ico">📅</span> <span class="lbl">${t(lang, 'nav.calendar')}</span></a>
        <a href="/leave?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'leave' ? 'active' : ''}"><span class="ico">🌴</span> <span class="lbl">${t(lang, 'nav.leave')}</span></a>
        <a href="/permission?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'permission' ? 'active' : ''}"><span class="ico">🕓</span> <span class="lbl">${t(lang, 'nav.permission')}</span></a>
        <a href="/overtime?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'overtime' ? 'active' : ''}"><span class="ico">⏱</span> <span class="lbl">${t(lang, 'nav.overtime')}</span></a>
        <a href="/onsite?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'onsite' ? 'active' : ''}"><span class="ico">📍</span> <span class="lbl">${t(lang, 'nav.onsite')}</span></a>
        ${CONFIG.LOCATIONIQ_API_KEY ? `<a href="/field-trip?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'field-trip' ? 'active' : ''}"><span class="ico">🚗</span> <span class="lbl">${t(lang, 'nav.field_trips')}</span></a>` : ''}
        ${isAdmin ? `<a href="/admin/employee-registration" class="${activeNav === 'employee-registration' ? 'active' : ''}"><span class="ico">🧑‍💼</span> <span class="lbl">Employee Registration</span></a>` : ''}
        ${isAdmin ? `<a href="/admin/reports" class="${activeNav === 'reports' ? 'active' : ''}"><span class="ico">📊</span> <span class="lbl">Reports</span></a>` : ''}
        ${isAdmin ? `<a href="/admin/settings" class="${activeNav === 'settings' ? 'active' : ''}"><span class="ico">⚙️</span> <span class="lbl">Settings</span></a>` : ''}
        ${isAdmin
          ? `<a href="/notifications" class="${activeNav === 'notifications' ? 'active' : ''}"><span class="ico">🔔</span> <span class="lbl">Notifications${await unreadNotificationCountAll() ? ` (${await unreadNotificationCountAll()})` : ''}</span></a>`
          : `<a href="/notifications?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'notifications' ? 'active' : ''}"><span class="ico">🔔</span> <span class="lbl">${t(lang, 'nav.notifications')}${await unreadNotificationCount(employeeId) ? ` (${await unreadNotificationCount(employeeId)})` : ''}</span></a>`}
      </div>
      <div class="acct">${langToggle}${rightSide}</div>
    </nav>
    <div class="main">
      <div class="wrap">
        <div class="topbar-mobile">${langToggle}${rightSide}</div>
        ${bodyHtml}
      </div>
    </div>
    ${IOS_INSTALL_SHEET_HTML}
    </body></html>`;
}

function renderLogin(error) {
  return `<html lang="en"><head><title>Login</title>
    ${PWA_HEAD_TAGS}
    <style>
      body { font-family: -apple-system, "Segoe UI", sans-serif; background: #F5F6F8; color: #1B2430; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; box-sizing: border-box; }
      .box { background: #fff; border: 1px solid #E1E5E9; border-radius: 12px; padding: 32px; width: 320px; max-width: 100%; box-sizing: border-box; }
      input { width: 100%; padding: 9px; border-radius: 6px; border: 1px solid #D0D5DA; margin-top: 4px; box-sizing: border-box; font-size: 16px; }
      label { font-size: 0.85em; color: #7C8896; }
      button { width: 100%; margin-top: 18px; padding: 12px; border-radius: 8px; border: none; background: #1565C0; color: #fff; font-weight: 600; font-size: 1em; }
    </style></head>
    <body><div class="box">
      <h2 style="margin-top:0;">Attendance Gateway</h2>
      ${error ? `<p style="color:#C62828;font-size:0.9em;">${escapeHtml(error)}</p>` : ''}
      <form method="POST" action="/login">
        <label>Username</label>
        <input type="text" name="username" required autofocus>
        <label style="display:block;margin-top:10px;">Password</label>
        <input type="password" name="password" required>
        <button type="submit">Log in</button>
      </form>
    </div></body></html>`;
}

function renderChangePassword(error, username) {
  return `<html lang="en"><head><title>Change Password</title>
    ${PWA_HEAD_TAGS}
    <style>
      body { font-family: -apple-system, "Segoe UI", sans-serif; background: #F5F6F8; color: #1B2430; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; box-sizing: border-box; }
      .box { background: #fff; border: 1px solid #E1E5E9; border-radius: 12px; padding: 32px; width: 340px; max-width: 100%; box-sizing: border-box; }
      input { width: 100%; padding: 9px; border-radius: 6px; border: 1px solid #D0D5DA; margin-top: 4px; box-sizing: border-box; font-size: 16px; }
      label { font-size: 0.85em; color: #7C8896; }
      button { width: 100%; margin-top: 18px; padding: 12px; border-radius: 8px; border: none; background: #1565C0; color: #fff; font-weight: 600; font-size: 1em; }
    </style></head>
    <body><div class="box">
      <h2 style="margin-top:0;">Set a new password</h2>
      <p style="color:#7C8896;font-size:0.9em;margin-top:0;">Your account (${escapeHtml(username)}) still has its default password. Set a new one to continue.</p>
      ${error ? `<p style="color:#C62828;font-size:0.9em;">${escapeHtml(error)}</p>` : ''}
      <form method="POST" action="/change-password">
        <label>Current password</label>
        <input type="password" name="current_password" required autofocus>
        <label style="display:block;margin-top:10px;">New password</label>
        <input type="password" name="new_password" required minlength="8">
        <label style="display:block;margin-top:10px;">Confirm new password</label>
        <input type="password" name="confirm_password" required minlength="8">
        <button type="submit">Set password</button>
      </form>
    </div></body></html>`;
}

async function renderDashboard(employee, dayStatus, punches, user, overtimeMinutes = 0, overtimeAuthorized = false, leaveBalances = [], breaks = []) {
  const lang = langOf(user);
  const todayShift = getShiftForDate(employee, todayStr());
  const onBreak = !!dayStatus.onBreak;
  const timerBlock = dayStatus.status === 'Active'
    ? `<div id="liveTimer" style="font-size:2.4em;font-weight:700;font-variant-numeric:tabular-nums;">00:00:00</div>
       ${onBreak ? `<div style="margin-top:4px;font-size:0.95em;opacity:0.9;">${t(lang, 'dashboard.on_break')} <span id="breakTimer" style="font-variant-numeric:tabular-nums;">00:00:00</span></div>` : ''}
       <script>
         const checkInAt = new Date(${JSON.stringify(dayStatus.checkIn.replace(' ', 'T'))}).getTime();
         const completedBreakMs = ${dayStatus.breakMinutes || 0} * 60000;
         const onBreak = ${onBreak};
         const breakStartAt = ${onBreak ? `new Date(${JSON.stringify(dayStatus.breakStart.replace(' ', 'T'))}).getTime()` : 'null'};
         function fmt(ms) {
           const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
           const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
           const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
           return h + ':' + m + ':' + s;
         }
         function tick() {
           const now = Date.now();
           const currentBreakMs = onBreak ? Math.max(0, now - breakStartAt) : 0;
           const workedMs = Math.max(0, (now - checkInAt) - completedBreakMs - currentBreakMs);
           document.getElementById('liveTimer').textContent = fmt(workedMs);
           const bt = document.getElementById('breakTimer');
           if (bt) bt.textContent = fmt(currentBreakMs);
         }
         tick(); setInterval(tick, 1000);
       </script>`
    : `<div style="font-size:2.4em;font-weight:700;font-variant-numeric:tabular-nums;">${formatHoursAsClock(dayStatus.hoursWorked)}</div>
       ${dayStatus.breakMinutes > 0 ? `<div style="margin-top:4px;font-size:0.95em;opacity:0.9;">${t(lang, 'dashboard.break_label')} ${formatMinutesAsHM(dayStatus.breakMinutes)}</div>` : ''}`;

  // Break button lives right next to the punch button — a break only makes sense
  // while a work session is open, so it's hidden the rest of the time.
  const breakBlock = dayStatus.status === 'Active' ? `
      <div style="margin-top:14px;">
        <div id="breakStatus" style="font-size:0.85em;opacity:0.9;margin-bottom:8px;min-height:1.2em;"></div>
        <button id="breakBtn" onclick="toggleBreak()" style="padding:10px 22px;border-radius:8px;border:2px solid #fff;background:transparent;color:#fff;font-weight:700;cursor:pointer;">${onBreak ? t(lang, 'dashboard.resume_work') : t(lang, 'dashboard.take_break')}</button>
      </div>` : '';

  const activityEvents = [
    ...punches.map(p => ({ time: p.timestamp, label: p.direction === 'in' ? t(lang, 'dashboard.punch_in_event') : t(lang, 'dashboard.punch_out_event'), source: p.source })),
    ...breaks.map(b => [
      { time: b.start_ts, label: t(lang, 'dashboard.break_start'), source: '—' },
      ...(b.end_ts ? [{ time: b.end_ts, label: t(lang, 'dashboard.break_end'), source: '—' }] : []),
    ]).flat(),
  ].sort((a, b) => a.time.localeCompare(b.time));

  const punchRows = activityEvents.map(e => {
    const isAuto = e.source === 'auto';
    const rowStyle = isAuto ? ' style="color:#B26A00;font-weight:600;"' : '';
    const label = isAuto ? `${escapeHtml(e.label)} <span style="background:#FFF3E0;border-radius:6px;padding:1px 6px;font-size:0.72em;font-weight:700;">${t(lang, 'dashboard.auto_tag')}</span>` : escapeHtml(e.label);
    return `<tr${rowStyle}><td>${label}</td><td>${escapeHtml(e.time.split(' ')[1])}</td><td>${escapeHtml(e.source)}</td></tr>`;
  }).join('') || `<tr><td colspan="3" style="color:#9AA5B1;">${t(lang, 'dashboard.no_activity')}</td></tr>`;

  const leaveBalanceCards = leaveBalanceCardsHtml(leaveBalances, lang);

  const joinedLine = employee.date_joined
    ? `<div style="color:#7C8896;font-size:0.85em;margin-top:2px;">${t(lang, 'dashboard.joined', { date: escapeHtml(new Date(`${employee.date_joined}T00:00:00`).toLocaleDateString(lang === 'ta' ? 'ta-IN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })) })}</div>`
    : '';

  // No browser API exposes WiFi SSID, so "on the office network" is verified
  // server-side by IP — the button just stays hidden until that's configured,
  // same pattern as the Field Trips tab hiding until LOCATIONIQ_API_KEY is set.
  const wifiPunchBlock = CONFIG.OFFICE_WIFI_IPS.size > 0 ? `
      <div style="margin-top:14px;">
        <div id="wifiPunchStatus" style="font-size:0.85em;opacity:0.9;margin-bottom:8px;min-height:1.2em;"></div>
        <button id="wifiPunchBtn" onclick="wifiPunch()" style="padding:10px 22px;border-radius:8px;border:none;background:#fff;color:#1565C0;font-weight:700;cursor:pointer;">${dayStatus.status === 'Active' ? t(lang, 'dashboard.punch_out') : t(lang, 'dashboard.punch_in')}</button>
        <div style="font-size:0.75em;opacity:0.75;margin-top:6px;">${t(lang, 'dashboard.wifi_hint', { ssid: escapeHtml(CONFIG.OFFICE_WIFI_SSID) })}</div>
      </div>` : '';

  const autoCheckoutWarning = dayStatus.checkOutAuto ? `
    <div class="card" style="background:#FFF3E0;border:1px solid #FFCC80;color:#B26A00;">
      <strong>⚠ ${t(lang, 'dashboard.auto_checkout_warning', { time: escapeHtml(dayStatus.checkOut.split(' ')[1]) })}</strong> ${t(lang, 'dashboard.auto_checkout_reminder')}
    </div>` : '';

  const body = `
    ${autoCheckoutWarning}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <div style="color:#7C8896;font-size:0.9em;">${t(lang, 'dashboard.welcome_back')}</div>
          <div style="font-size:1.3em;font-weight:700;">${escapeHtml(employee.name)}</div>
          ${joinedLine}
        </div>
        ${statusBadge(dayStatus.status, dayStatus.label, lang)}
      </div>
    </div>
    <div class="card" style="background:#1565C0;color:#fff;">
      <div style="font-size:0.8em;letter-spacing:0.06em;text-transform:uppercase;opacity:0.85;">${t(lang, 'dashboard.working_hours')}</div>
      ${timerBlock}
      <div style="margin-top:12px;opacity:0.9;font-size:0.92em;">${t(lang, 'dashboard.shift', { start: escapeHtml(todayShift.start), end: escapeHtml(todayShift.end) })}</div>
      ${overtimeMinutes > 0 ? `
      <div style="margin-top:8px;font-size:0.92em;display:flex;align-items:center;gap:8px;">
        <span style="opacity:0.9;">${t(lang, 'dashboard.overtime', { time: formatMinutesAsHM(overtimeMinutes) })}</span>
        <span style="padding:2px 9px;border-radius:999px;font-size:0.8em;font-weight:600;background:rgba(255,255,255,0.2);">${overtimeAuthorized ? t(lang, 'dashboard.authorized') : t(lang, 'dashboard.unauthorized')}</span>
      </div>` : ''}
      ${wifiPunchBlock}
      ${breakBlock}
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">${t(lang, 'dashboard.todays_activity')}</div>
      <table><tr><th>${t(lang, 'dashboard.event')}</th><th>${t(lang, 'dashboard.time')}</th><th>${t(lang, 'dashboard.source')}</th></tr>${punchRows}</table>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="font-weight:700;">${t(lang, 'dashboard.leave_balance')}</div>
        <a href="/leave?employee_id=${escapeHtml(employee.id)}" style="font-size:0.85em;color:#1565C0;text-decoration:none;font-weight:600;">${t(lang, 'dashboard.apply_view_history')}</a>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">${leaveBalanceCards}</div>
    </div>
    <script>
      function wifiPunch() {
        const status = document.getElementById('wifiPunchStatus');
        const btn = document.getElementById('wifiPunchBtn');
        if (!status || !btn) return;
        btn.disabled = true;
        status.style.color = '';
        status.textContent = ${JSON.stringify(t(lang, 'dashboard.checking'))};
        fetch('/api/punch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ employee_id: ${JSON.stringify(employee.id)}, source: 'wifi' })
        }).then(async r => {
          const data = await r.json();
          if (!r.ok) {
            status.style.color = '#FFCDD2';
            status.textContent = data.error || ${JSON.stringify(t(lang, 'dashboard.punch_failed'))};
            btn.disabled = false;
            return;
          }
          status.style.color = '';
          status.textContent = data.direction === 'in' ? ${JSON.stringify(t(lang, 'dashboard.punched_in'))} : ${JSON.stringify(t(lang, 'dashboard.punched_out'))};
          setTimeout(() => window.location.reload(), 700);
        }).catch(() => {
          status.style.color = '#FFCDD2';
          status.textContent = ${JSON.stringify(t(lang, 'dashboard.something_wrong'))};
          btn.disabled = false;
        });
      }
      function toggleBreak() {
        const status = document.getElementById('breakStatus');
        const btn = document.getElementById('breakBtn');
        if (!status || !btn) return;
        btn.disabled = true;
        status.textContent = ${JSON.stringify(t(lang, 'dashboard.updating'))};
        fetch('/api/break', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ employee_id: ${JSON.stringify(employee.id)} })
        }).then(async r => {
          const data = await r.json();
          if (!r.ok) {
            status.textContent = data.error || ${JSON.stringify(t(lang, 'dashboard.break_update_failed'))};
            btn.disabled = false;
            return;
          }
          window.location.reload();
        }).catch(() => {
          status.textContent = ${JSON.stringify(t(lang, 'dashboard.something_wrong'))};
          btn.disabled = false;
        });
      }
    </script>`;
  return pageShell(t(lang, 'dashboard.title'), employee.id, 'dashboard', body, user);
}

async function renderCalendar(employee, year, month, user) {
  const lang = langOf(user);
  const monthStr = String(month).padStart(2, '0');
  const firstOfMonth = new Date(`${year}-${monthStr}-01T00:00:00`);
  const daysInMonth = new Date(year, month, 0).getDate();
  const startWeekday = firstOfMonth.getDay();

  // Weekday header cells and day cells share one grid (rather than two separate
  // grids stacked on top of each other) so their columns are guaranteed to line
  // up — two independent grids each auto-size their own 1fr columns from their
  // own content, and "Upcoming"/"Week Off" need more width than "Sun"/"Mon", so
  // they drift out of alignment on narrow screens where that content overflows.
  const headerCells = ['calendar.sun', 'calendar.mon', 'calendar.tue', 'calendar.wed', 'calendar.thu', 'calendar.fri', 'calendar.sat']
    .map(k => `<div style="color:#7C8896;font-size:0.75em;text-align:center;padding-bottom:6px;">${t(lang, k)}</div>`);

  // Same fix as the Reports page (see computeMonthlyStatusGrid): fire every day's
  // computeDayStatus concurrently instead of one after another. A month view was doing
  // up to ~31 sequential round-trips to Turso (2-4 queries each inside computeDayStatus),
  // which is what made Calendar slow — especially over a phone's higher-latency network.
  const dateStrs = [];
  for (let d = 1; d <= daysInMonth; d++) dateStrs.push(`${year}-${monthStr}-${String(d).padStart(2, '0')}`);
  const dayStatuses = await Promise.all(dateStrs.map(dateStr => computeDayStatus(employee.id, dateStr)));

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push('<div></div>');
  dayStatuses.forEach((status, i) => {
    const d = i + 1;
    const dateStr = dateStrs[i];
    const s = STATUS_STYLE[status.status] || STATUS_STYLE['Upcoming'];
    const isToday = dateStr === todayStr();
    cells.push(`<div style="background:${s.bg};color:${s.fg};border-radius:8px;padding:8px 6px;min-height:52px;overflow-wrap:break-word;${isToday ? 'outline:2px solid #1565C0;' : ''}">
      <div style="font-weight:700;">${d}</div>
      <div class="cal-status" style="font-size:0.72em;font-weight:600;overflow-wrap:break-word;hyphens:auto;">${escapeHtml(t(lang, `status.${status.status}`))}</div>
    </div>`);
  });

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const monthName = t(lang, `calendar.month.${month}`);

  const legend = Object.keys(STATUS_STYLE).map(status => `
    <span style="display:inline-flex;align-items:center;gap:5px;font-size:0.8em;margin-right:14px;margin-bottom:6px;">
      <span style="width:10px;height:10px;border-radius:50%;background:${STATUS_STYLE[status].fg};display:inline-block;"></span>${t(lang, `status.${status}`)}
    </span>`).join('');

  const body = `
    ${user && user.role === 'admin' ? calendarViewToggle(employee.id, 'mine') : ''}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <a href="/calendar?employee_id=${escapeHtml(employee.id)}&year=${prevYear}&month=${prevMonth}" style="text-decoration:none;font-size:1.2em;">&#8249;</a>
        <div style="font-weight:700;font-size:1.1em;">${monthName} ${year}</div>
        <a href="/calendar?employee_id=${escapeHtml(employee.id)}&year=${nextYear}&month=${nextMonth}" style="text-decoration:none;font-size:1.2em;">&#8250;</a>
      </div>
      <div class="cal-grid" style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;">${headerCells.join('')}${cells.join('')}</div>
    </div>
    <div class="card">${legend}</div>`;
  return pageShell(t(lang, 'calendar.title'), employee.id, 'calendar', body, user);
}

async function renderLeave(employee, balances, requests, user, error) {
  const isAdmin = user && user.role === 'admin';
  const lang = langOf(user);
  const balanceCards = leaveBalanceCardsHtml(balances, lang);

  const typeOptions = LEAVE_TYPES.map(lt => `<option value="${escapeHtml(lt)}">${escapeHtml(t(lang, `leave_type.${lt}`))}</option>`).join('');

  const pending = requests.filter(r => r.status === 'pending');
  const history = requests.filter(r => r.status !== 'pending');

  const pendingRows = pending.map(r => `
    <tr>
      <td>${escapeHtml(t(lang, `leave_type.${r.leave_type}`))}</td>
      <td>${escapeHtml(r.start_date)} &ndash; ${escapeHtml(r.end_date)}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>
        ${isAdmin
          ? actionButton('/leave/decide', { id: r.id, action: 'approve', employee_id: employee.id }, 'Approve', '#2E7D32', true) +
            actionButton('/leave/decide', { id: r.id, action: 'reject', employee_id: employee.id }, 'Reject', '#C62828')
          : statusBadge('Upcoming', t(lang, 'status.awaiting_approval'), lang)}
      </td>
    </tr>`).join('') || `<tr><td colspan="4" style="color:#9AA5B1;">${t(lang, 'leave.no_pending')}</td></tr>`;

  const historyRows = history.map(r => `
    <tr>
      <td>${escapeHtml(t(lang, `leave_type.${r.leave_type}`))}</td>
      <td>${escapeHtml(r.start_date)} &ndash; ${escapeHtml(r.end_date)}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>${statusBadge(r.status === 'approved' ? 'Present' : 'Absent', t(lang, `status.${r.status}`), lang)}</td>
    </tr>`).join('') || `<tr><td colspan="4" style="color:#9AA5B1;">${t(lang, 'leave.no_history')}</td></tr>`;

  const body = `
    ${error ? `<div class="card" style="color:#C62828;">${escapeHtml(error)}</div>` : ''}
    <div class="card">
      <div style="font-weight:700;margin-bottom:12px;">${t(lang, 'leave.balance')}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">${balanceCards}</div>
    </div>
    ${isAdmin ? `<div class="card" style="color:#7C8896;font-size:0.9em;">Employees apply for their own leave — admin can only review and approve/reject below.</div>` : `
    <div class="card">
      <div style="font-weight:700;margin-bottom:12px;">${t(lang, 'leave.apply_title')}</div>
      <form method="POST" action="/leave/apply" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <input type="hidden" name="employee_id" value="${escapeHtml(employee.id)}">
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'leave.type')}</label>
          <select name="leave_type" style="padding:7px;border-radius:6px;border:1px solid #D0D5DA;">${typeOptions}</select>
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'leave.from')}</label>
          <input type="date" name="start_date" required style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'leave.to')}</label>
          <input type="date" name="end_date" required style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div style="flex:1;min-width:140px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'leave.reason')}</label>
          <input type="text" name="reason" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
        </div>
        <button type="submit" style="padding:8px 16px;border-radius:6px;border:none;background:#1565C0;color:#fff;font-weight:600;">${t(lang, 'leave.apply_btn')}</button>
      </form>
    </div>`}
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">${t(lang, 'leave.pending')}</div>
      <table><tr><th>${t(lang, 'leave.type')}</th><th>${t(lang, 'leave.dates')}</th><th>${t(lang, 'leave.reason')}</th><th>${isAdmin ? 'Action' : t(lang, 'leave.status')}</th></tr>${pendingRows}</table>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">${t(lang, 'leave.history')}</div>
      <table><tr><th>${t(lang, 'leave.type')}</th><th>${t(lang, 'leave.dates')}</th><th>${t(lang, 'leave.reason')}</th><th>${t(lang, 'leave.status')}</th></tr>${historyRows}</table>
    </div>`;
  return pageShell(t(lang, 'leave.title'), employee.id, 'leave', body, user);
}

async function renderPermission(employee, requests, monthlySummary, user, error) {
  const lang = langOf(user);
  const pending = requests.filter(r => r.status === 'pending');
  const history = requests.filter(r => r.status !== 'pending');

  const hoursCell = r => {
    const h = computePermissionHours(employee, r.date, r.leave_time);
    return h > PERMISSION_DAILY_CAP_HOURS
      ? `<span style="color:#C62828;font-weight:600;">${h}h</span>`
      : `${h}h`;
  };

  const pendingRows = pending.map(r => `
    <tr>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(r.leave_time)}</td>
      <td>${hoursCell(r)}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>${statusBadge('Upcoming', t(lang, 'status.awaiting_approval'), lang)}</td>
    </tr>`).join('') || `<tr><td colspan="5" style="color:#9AA5B1;">${t(lang, 'permission.no_pending')}</td></tr>`;

  const historyRows = history.map(r => `
    <tr>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(r.leave_time)}</td>
      <td>${hoursCell(r)}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>${statusBadge(r.status === 'approved' ? 'Present' : 'Absent', t(lang, `status.${r.status}`), lang)}</td>
    </tr>`).join('') || `<tr><td colspan="5" style="color:#9AA5B1;">${t(lang, 'permission.no_history')}</td></tr>`;

  const summaryCard = `
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px;">${t(lang, 'permission.summary_title')}</div>
      <div style="display:flex;gap:24px;">
        <div>
          <div style="font-size:1.6em;font-weight:700;">${monthlySummary.usedHours}h</div>
          <div style="color:#7C8896;font-size:0.85em;">${t(lang, 'permission.used')}</div>
        </div>
        <div>
          <div style="font-size:1.6em;font-weight:700;${monthlySummary.remainingHours < 0 ? 'color:#C62828;' : ''}">${monthlySummary.remainingHours}h</div>
          <div style="color:#7C8896;font-size:0.85em;">${monthlySummary.remainingHours < 0 ? t(lang, 'permission.over_budget') : t(lang, 'permission.remaining')}</div>
        </div>
      </div>
    </div>`;

  const body = `
    ${error ? `<div class="card" style="color:#C62828;">${escapeHtml(error)}</div>` : ''}
    ${summaryCard}
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px;">${t(lang, 'permission.apply_title')}</div>
      <p style="color:#7C8896;font-size:0.9em;margin-top:0;">${t(lang, 'permission.apply_hint')}</p>
      <form method="POST" action="/permission/apply" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <input type="hidden" name="employee_id" value="${escapeHtml(employee.id)}">
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'permission.date')}</label>
          <input type="date" name="date" required style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'permission.leaving_at')}</label>
          <input type="time" name="leave_time" required style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div style="flex:1;min-width:140px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'permission.reason')}</label>
          <input type="text" name="reason" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
        </div>
        <button type="submit" style="padding:8px 16px;border-radius:6px;border:none;background:#1565C0;color:#fff;font-weight:600;">${t(lang, 'permission.apply_btn')}</button>
      </form>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">${t(lang, 'permission.pending')}</div>
      <table><tr><th>${t(lang, 'permission.col_date')}</th><th>${t(lang, 'permission.col_leaving_at')}</th><th>${t(lang, 'permission.col_hours')}</th><th>${t(lang, 'permission.col_reason')}</th><th>${t(lang, 'permission.col_status')}</th></tr>${pendingRows}</table>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">${t(lang, 'permission.history')}</div>
      <table><tr><th>${t(lang, 'permission.col_date')}</th><th>${t(lang, 'permission.col_leaving_at')}</th><th>${t(lang, 'permission.col_hours')}</th><th>${t(lang, 'permission.col_reason')}</th><th>${t(lang, 'permission.col_status')}</th></tr>${historyRows}</table>
    </div>`;
  return pageShell(t(lang, 'permission.title'), employee.id, 'permission', body, user);
}

async function renderOvertime(employee, requests, todayOvertimeMinutes, todayAuthorized, user, error) {
  const lang = langOf(user);
  const pending = requests.filter(r => r.status === 'pending');
  const history = requests.filter(r => r.status !== 'pending');

  const pendingRows = pending.map(r => `
    <tr>
      <td>${escapeHtml(r.date)}</td>
      <td>${r.planned_hours != null ? escapeHtml(String(r.planned_hours)) + 'h' : '—'}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>${statusBadge('Upcoming', t(lang, 'status.awaiting_approval'), lang)}</td>
    </tr>`).join('') || `<tr><td colspan="4" style="color:#9AA5B1;">${t(lang, 'overtime.no_pending')}</td></tr>`;

  const historyRows = history.map(r => `
    <tr>
      <td>${escapeHtml(r.date)}</td>
      <td>${r.planned_hours != null ? escapeHtml(String(r.planned_hours)) + 'h' : '—'}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>${statusBadge(r.status === 'approved' ? 'Present' : 'Absent', t(lang, `status.${r.status}`), lang)}</td>
    </tr>`).join('') || `<tr><td colspan="4" style="color:#9AA5B1;">${t(lang, 'overtime.no_history')}</td></tr>`;

  const todayCard = todayOvertimeMinutes > 0 ? `
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px;">${t(lang, 'overtime.today_title')}</div>
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="font-size:1.6em;font-weight:700;">${formatMinutesAsHM(todayOvertimeMinutes)}</div>
        ${todayAuthorized
          ? statusBadge('Present', t(lang, 'status.authorized'), lang)
          : statusBadge('Absent', t(lang, 'status.unauthorized'), lang)}
      </div>
    </div>` : '';

  const body = `
    ${error ? `<div class="card" style="color:#C62828;">${escapeHtml(error)}</div>` : ''}
    ${todayCard}
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px;">${t(lang, 'overtime.request_title')}</div>
      <p style="color:#7C8896;font-size:0.9em;margin-top:0;">${t(lang, 'overtime.request_hint')}</p>
      <form method="POST" action="/overtime/apply" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <input type="hidden" name="employee_id" value="${escapeHtml(employee.id)}">
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'overtime.date')}</label>
          <input type="date" name="date" required style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'overtime.planned_hours')}</label>
          <input type="number" name="planned_hours" step="0.5" min="0.5" required style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:90px;">
        </div>
        <div style="flex:1;min-width:140px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'overtime.reason')}</label>
          <input type="text" name="reason" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
        </div>
        <button type="submit" style="padding:8px 16px;border-radius:6px;border:none;background:#1565C0;color:#fff;font-weight:600;">${t(lang, 'overtime.request_btn')}</button>
      </form>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">${t(lang, 'overtime.pending')}</div>
      <table><tr><th>${t(lang, 'overtime.col_date')}</th><th>${t(lang, 'overtime.col_planned_hours')}</th><th>${t(lang, 'overtime.col_reason')}</th><th>${t(lang, 'overtime.col_status')}</th></tr>${pendingRows}</table>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">${t(lang, 'overtime.history')}</div>
      <table><tr><th>${t(lang, 'overtime.col_date')}</th><th>${t(lang, 'overtime.col_planned_hours')}</th><th>${t(lang, 'overtime.col_reason')}</th><th>${t(lang, 'overtime.col_status')}</th></tr>${historyRows}</table>
    </div>`;
  return pageShell(t(lang, 'overtime.title'), employee.id, 'overtime', body, user);
}

async function renderOnsite(employee, recentPunches, user) {
  const lang = langOf(user);
  const rows = recentPunches.map(p => `
    <tr>
      <td>${p.direction === 'in' ? t(lang, 'onsite.punch_in') : t(lang, 'onsite.punch_out')}</td>
      <td>${escapeHtml(p.timestamp)}</td>
      <td>${escapeHtml(p.marked_by || '—')}</td>
      <td>${locationCell(p)}</td>
    </tr>`).join('') || `<tr><td colspan="4" style="color:#9AA5B1;">${t(lang, 'onsite.no_punches')}</td></tr>`;

  const punchCard = employee.onsite_enabled ? `
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px;">${t(lang, 'onsite.title')}</div>
      <p style="color:#7C8896;font-size:0.9em;margin-top:0;">${t(lang, 'onsite.hint')}</p>
      <div style="margin-bottom:10px;">
        <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'onsite.marked_by')}</label>
        <input id="markedBy" type="text" value="${escapeHtml(employee.name)}" style="padding:7px;border-radius:6px;border:1px solid #D0D5DA;width:240px;">
        <div style="font-size:0.78em;color:#9AA5B1;margin-top:4px;">${t(lang, 'onsite.marked_by_hint')}</div>
      </div>
      <div id="onsiteStatus" style="margin-bottom:10px;font-size:0.9em;color:#7C8896;"></div>
      <div id="manualLocationBox" style="display:none;margin-bottom:10px;">
        <input id="manualLocation" type="text" placeholder="${escapeHtml(t(lang, 'onsite.manual_location_placeholder'))}" style="padding:7px;border-radius:6px;border:1px solid #D0D5DA;width:280px;">
        <button onclick="submitManualLocation()" style="padding:7px 14px;border-radius:6px;border:none;background:#1565C0;color:#fff;font-weight:600;">${t(lang, 'onsite.submit')}</button>
      </div>
      <button id="onsitePunchBtn" onclick="onsitePunch()" style="padding:10px 20px;border-radius:8px;border:none;background:#1565C0;color:#fff;font-weight:600;">${t(lang, 'onsite.punch_btn')}</button>
    </div>` : `
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px;">${t(lang, 'onsite.title')}</div>
      <p style="color:#7C8896;font-size:0.9em;">${t(lang, 'onsite.disabled_hint')}</p>
    </div>`;

  const body = `
    ${punchCard}
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">${t(lang, 'onsite.recent_title')}</div>
      <table><tr><th>${t(lang, 'onsite.col_event')}</th><th>${t(lang, 'onsite.col_time')}</th><th>${t(lang, 'onsite.col_marked_by')}</th><th>${t(lang, 'onsite.col_location')}</th></tr>${rows}</table>
    </div>
    <script>
      function send(loc) {
        const status = document.getElementById('onsiteStatus');
        const markedBy = document.getElementById('markedBy').value;
        status.textContent = ${JSON.stringify(t(lang, 'onsite.submitting'))};
        fetch('/api/punch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ employee_id: ${JSON.stringify(employee.id)}, source: 'on-site', marked_by: markedBy, location: loc })
        }).then(r => r.json()).then(data => {
          status.textContent = data.direction === 'in' ? ${JSON.stringify(t(lang, 'onsite.punched_in'))} : ${JSON.stringify(t(lang, 'onsite.punched_out'))};
          setTimeout(() => window.location.reload(), 700);
        }).catch(() => { status.textContent = ${JSON.stringify(t(lang, 'onsite.something_wrong'))}; });
      }
      function onsitePunch() {
        const status = document.getElementById('onsiteStatus');
        if (navigator.geolocation) {
          status.textContent = ${JSON.stringify(t(lang, 'onsite.getting_location'))};
          navigator.geolocation.getCurrentPosition(
            pos => send(pos.coords.latitude.toFixed(5) + ', ' + pos.coords.longitude.toFixed(5)),
            () => {
              status.textContent = ${JSON.stringify(t(lang, 'onsite.location_unavailable'))};
              document.getElementById('manualLocationBox').style.display = 'block';
            },
            { timeout: 8000 }
          );
        } else {
          document.getElementById('onsiteStatus').textContent = ${JSON.stringify(t(lang, 'onsite.geolocation_unsupported'))};
          document.getElementById('manualLocationBox').style.display = 'block';
        }
      }
      function submitManualLocation() {
        send(document.getElementById('manualLocation').value || '');
      }
    </script>`;
  return pageShell(t(lang, 'onsite.title'), employee.id, 'onsite', body, user);
}

async function renderFieldTrip(employeeId, trips, user) {
  const lang = langOf(user);
  const recentRows = (trips || []).map(trip => {
    const statusCell = trip.status === 'pending'
      ? statusBadge('Upcoming', t(lang, 'status.awaiting_approval'), lang)
      : statusBadge(trip.status === 'approved' ? 'Present' : 'Absent', t(lang, `status.${trip.status}`), lang);
    return `
    <tr>
      <td>${escapeHtml(trip.date)}</td>
      <td>${escapeHtml(trip.from_address)}</td>
      <td>${escapeHtml(trip.to_address)}</td>
      <td style="white-space:nowrap;font-weight:600;">${escapeHtml(String(trip.distance_km))} km</td>
      <td>${statusCell}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" style="color:#9AA5B1;">${t(lang, 'fieldtrip.no_trips')}</td></tr>`;
  const body = `
    <style>
      .ac-wrap { position: relative; }
      .ac-drop { display:none; position:absolute; left:0; right:0; top:100%; z-index:20; background:#fff; border:1px solid #D0D5DA; border-radius:6px; margin-top:2px; max-height:220px; overflow-y:auto; box-shadow:0 4px 14px rgba(0,0,0,0.12); }
      .ac-item { padding:8px 10px; font-size:0.9em; cursor:pointer; }
      .ac-item:hover, .ac-item.active { background:#E3F2FD; }
    </style>
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px;">${t(lang, 'fieldtrip.title')}</div>
      <p style="color:#7C8896;font-size:0.9em;margin-top:0;">${t(lang, 'fieldtrip.hint')}</p>
      <button id="startTripBtn" onclick="showTripForm()" style="padding:10px 20px;border-radius:8px;border:none;background:#1565C0;color:#fff;font-weight:600;cursor:pointer;">${t(lang, 'fieldtrip.start_btn')}</button>
      <div id="tripForm" style="display:none;margin-top:14px;">
        <div class="ac-wrap" style="margin-bottom:10px;max-width:340px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'fieldtrip.from')}</label>
          <input id="tripFrom" type="text" autocomplete="off" placeholder="${escapeHtml(t(lang, 'fieldtrip.address_placeholder'))}" style="padding:7px;border-radius:6px;border:1px solid #D0D5DA;width:100%;box-sizing:border-box;">
          <input type="hidden" id="tripFromLat"><input type="hidden" id="tripFromLon">
          <div id="tripFromDrop" class="ac-drop"></div>
        </div>
        <div class="ac-wrap" style="margin-bottom:10px;max-width:340px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'fieldtrip.to')}</label>
          <input id="tripTo" type="text" autocomplete="off" placeholder="${escapeHtml(t(lang, 'fieldtrip.address_placeholder'))}" style="padding:7px;border-radius:6px;border:1px solid #D0D5DA;width:100%;box-sizing:border-box;">
          <input type="hidden" id="tripToLat"><input type="hidden" id="tripToLon">
          <div id="tripToDrop" class="ac-drop"></div>
        </div>
        <button id="calcTripBtn" onclick="calcTrip()" style="padding:9px 18px;border-radius:6px;border:none;background:#1565C0;color:#fff;font-weight:600;cursor:pointer;">${t(lang, 'fieldtrip.calculate_btn')}</button>
        <div id="tripResult" style="margin-top:12px;font-size:0.95em;"></div>
        <button id="recordTripBtn" onclick="recordTrip()" style="display:none;margin-top:12px;padding:9px 18px;border-radius:6px;border:none;background:#2E7D32;color:#fff;font-weight:600;cursor:pointer;">${t(lang, 'fieldtrip.record_btn')}</button>
      </div>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">${t(lang, 'fieldtrip.recent_title')}</div>
      <table><tr><th>${t(lang, 'fieldtrip.col_date')}</th><th>${t(lang, 'fieldtrip.col_from')}</th><th>${t(lang, 'fieldtrip.col_to')}</th><th>${t(lang, 'fieldtrip.col_distance')}</th><th>${t(lang, 'fieldtrip.col_status')}</th></tr>${recentRows}</table>
    </div>
    <script>
      function showTripForm() {
        document.getElementById('tripForm').style.display = 'block';
        document.getElementById('startTripBtn').style.display = 'none';
        document.getElementById('tripFrom').focus();
      }
      function escapeText(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
      // Wires LocationIQ type-ahead onto one input: debounced fetch, a suggestions dropdown,
      // keyboard (up/down/enter/esc) + mouse selection. Each suggestion carries lat/lon, which
      // we stash in hidden fields so the distance call can route between exact points.
      function attachAutocomplete(inputId, dropId, latId, lonId) {
        const input = document.getElementById(inputId);
        const drop = document.getElementById(dropId);
        const latEl = document.getElementById(latId);
        const lonEl = document.getElementById(lonId);
        let items = [], active = -1, timer = null;
        function close() { drop.style.display = 'none'; drop.innerHTML = ''; items = []; active = -1; }
        function render() {
          if (!items.length) { close(); return; }
          drop.innerHTML = items.map(function(s, i) {
            return '<div class="ac-item' + (i === active ? ' active' : '') + '" data-i="' + i + '">' + escapeText(s.description) + '</div>';
          }).join('');
          drop.style.display = 'block';
          Array.prototype.forEach.call(drop.children, function(el) {
            el.addEventListener('mousedown', function(e) { e.preventDefault(); select(parseInt(el.getAttribute('data-i'), 10)); });
          });
        }
        function select(i) {
          const s = items[i]; if (!s) return;
          input.value = s.description; latEl.value = s.lat || ''; lonEl.value = s.lon || '';
          close();
        }
        input.addEventListener('input', function() {
          latEl.value = ''; lonEl.value = ''; // typing after a pick invalidates the coords
          const q = input.value.trim();
          clearTimeout(timer);
          if (q.length < 3) { close(); return; }
          timer = setTimeout(function() {
            fetch('/api/places/autocomplete?q=' + encodeURIComponent(q))
              .then(function(r) { return r.json(); })
              .then(function(d) { items = d.suggestions || []; active = -1; render(); })
              .catch(function() { close(); });
          }, 250);
        });
        input.addEventListener('keydown', function(e) {
          if (drop.style.display !== 'block') return;
          if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
          else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); select(active); } }
          else if (e.key === 'Escape') { close(); }
        });
        input.addEventListener('blur', function() { setTimeout(close, 150); });
      }
      var lastTripPayload = null;
      ${(() => {
        const [drivingPrefix, drivingSuffix] = t(lang, 'fieldtrip.driving_about').split('{{duration}}');
        return `var DRIVING_PREFIX = ${JSON.stringify(drivingPrefix)}, DRIVING_SUFFIX = ${JSON.stringify(drivingSuffix)};`;
      })()}
      function calcTrip() {
        const from = document.getElementById('tripFrom').value.trim();
        const to = document.getElementById('tripTo').value.trim();
        const result = document.getElementById('tripResult');
        const btn = document.getElementById('calcTripBtn');
        const recBtn = document.getElementById('recordTripBtn');
        recBtn.style.display = 'none';
        if (!from || !to) { result.innerHTML = '<span style="color:#C62828;">' + ${JSON.stringify(t(lang, 'fieldtrip.enter_both'))} + '</span>'; return; }
        const payload = {
          from: from, to: to,
          from_lat: document.getElementById('tripFromLat').value, from_lon: document.getElementById('tripFromLon').value,
          to_lat: document.getElementById('tripToLat').value, to_lon: document.getElementById('tripToLon').value
        };
        result.textContent = ${JSON.stringify(t(lang, 'fieldtrip.calculating'))}; btn.disabled = true;
        fetch('/api/field-trip/distance', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(r => r.json().then(d => ({ ok: r.ok, d: d }))).then(({ ok, d }) => {
          btn.disabled = false;
          if (!ok) { result.innerHTML = '<span style="color:#C62828;">' + escapeText(d.error || ${JSON.stringify(t(lang, 'fieldtrip.could_not_calculate'))}) + '</span>'; return; }
          lastTripPayload = payload;
          result.innerHTML = '<div style="font-size:1.5em;font-weight:700;color:#1565C0;">' + escapeText(String(d.distanceKm)) + ' km</div>'
            + '<div style="color:#7C8896;font-size:0.85em;margin-top:4px;line-height:1.5;">'
            + (d.durationText ? DRIVING_PREFIX + escapeText(d.durationText) + DRIVING_SUFFIX + '<br>' : '')
            + '<strong>${escapeHtml(t(lang, 'fieldtrip.from_label'))}</strong> ' + escapeText(d.fromResolved) + '<br><strong>${escapeHtml(t(lang, 'fieldtrip.to_label'))}</strong> ' + escapeText(d.toResolved) + '</div>';
          recBtn.style.display = 'inline-block'; recBtn.disabled = false; recBtn.textContent = ${JSON.stringify(t(lang, 'fieldtrip.record_btn'))};
        }).catch(() => { btn.disabled = false; result.innerHTML = '<span style="color:#C62828;">' + ${JSON.stringify(t(lang, 'fieldtrip.something_wrong'))} + '</span>'; });
      }
      function recordTrip() {
        if (!lastTripPayload) return;
        const recBtn = document.getElementById('recordTripBtn');
        const result = document.getElementById('tripResult');
        recBtn.disabled = true; recBtn.textContent = ${JSON.stringify(t(lang, 'fieldtrip.recording'))};
        fetch('/api/field-trip/record', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(lastTripPayload)
        }).then(r => r.json().then(d => ({ ok: r.ok, d: d }))).then(({ ok, d }) => {
          if (!ok) { recBtn.disabled = false; recBtn.textContent = ${JSON.stringify(t(lang, 'fieldtrip.record_btn'))}; result.innerHTML += '<div style="color:#C62828;margin-top:8px;">' + escapeText(d.error || ${JSON.stringify(t(lang, 'fieldtrip.could_not_record'))}) + '</div>'; return; }
          recBtn.textContent = ${JSON.stringify(t(lang, 'fieldtrip.recorded'))};
          setTimeout(function () { window.location.reload(); }, 900); // refresh the recent-trips list
        }).catch(function () { recBtn.disabled = false; recBtn.textContent = ${JSON.stringify(t(lang, 'fieldtrip.record_btn'))}; });
      }
      attachAutocomplete('tripFrom', 'tripFromDrop', 'tripFromLat', 'tripFromLon');
      attachAutocomplete('tripTo', 'tripToDrop', 'tripToLat', 'tripToLon');
    </script>`;
  return pageShell(t(lang, 'nav.field_trips'), employeeId || '', 'field-trip', body, user);
}

// Accounts-team view: every recorded field trip, for fuel reimbursement.
async function renderAdminFieldTrips(trips, user) {
  const rows = (await Promise.all(trips.map(async trip => {
    const emp = await getEmployee(trip.employee_id);
    const statusCell = trip.status === 'pending'
      ? actionButton('/field-trip/decide', { id: trip.id, action: 'approve' }, 'Approve', '#2E7D32', true) +
        actionButton('/field-trip/decide', { id: trip.id, action: 'reject' }, 'Reject', '#C62828')
      : statusBadge(trip.status === 'approved' ? 'Present' : 'Absent', trip.status);
    return `
    <tr>
      <td><strong>${escapeHtml(emp ? emp.name : trip.employee_id)}</strong> <span style="color:#9AA5B1;">(${escapeHtml(trip.employee_id)})</span></td>
      <td>${escapeHtml(trip.date)}</td>
      <td>${escapeHtml(trip.from_address)}</td>
      <td>${escapeHtml(trip.to_address)}</td>
      <td style="white-space:nowrap;font-weight:600;">${escapeHtml(String(trip.distance_km))} km</td>
      <td>${statusCell}</td>
    </tr>`;
  }))).join('') || `<tr><td colspan="6" style="color:#9AA5B1;">No field trips recorded yet</td></tr>`;
  // Only approved distance counts toward the reimbursement total — pending/rejected
  // trips shouldn't inflate the number accounts actually pays out on.
  const approvedKm = Math.round(trips.filter(trip => trip.status === 'approved').reduce((s, trip) => s + (trip.distance_km || 0), 0) * 100) / 100;
  const body = `
    <div class="card" style="color:#7C8896;font-size:0.9em;">
      Distances recorded by employees for field trips (work travel away from the office), for fuel reimbursement.
      A trip only counts toward reimbursement once approved — reject any trip the office didn't ask for.
      Showing the ${trips.length} most recent — ${approvedKm} km approved so far.
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">Recorded Field Trips</div>
      <table><tr><th>Employee</th><th>Date</th><th>From</th><th>To</th><th>Distance</th><th>Status</th></tr>${rows}</table>
    </div>`;
  return pageShell('Field Trips', '', 'field-trip', body, user);
}

async function renderAdminAttendance(dateStr, rows, user, opts = {}) {
  const basePath = opts.basePath || '/dashboard';
  const title = opts.title || 'Dashboard';
  const activeNav = opts.activeNav || 'dashboard';
  const d = new Date(`${dateStr}T00:00:00`);
  const prevDate = new Date(d); prevDate.setDate(d.getDate() - 1);
  const nextDate = new Date(d); nextDate.setDate(d.getDate() + 1);
  const prevStr = todayStr(prevDate);
  const nextStr = todayStr(nextDate);
  const label = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const tableRows = (await Promise.all(rows.map(async r => {
    const inProgress = r.status.status === 'Active';
    const hoursCell = inProgress
      ? `<span class="liveHours" data-checkin="${escapeHtml(r.status.checkIn.replace(' ', 'T'))}">00:00:00</span>`
      : (r.status.hoursWorked ? formatHoursAsClock(r.status.hoursWorked) : '—');
    const checkOutCell = r.status.checkOut
      ? (r.status.checkOutAuto
          ? statusBadge('Late', `Auto ${r.status.checkOut.split(' ')[1]}`)
          : escapeHtml(r.status.checkOut.split(' ')[1]))
      : '—';
    const permission = await getPermissionForDate(r.employee.id, dateStr);
    let permissionCell = '<span style="color:#9AA5B1;">—</span>';
    if (permission) {
      if (permission.status === 'pending') {
        permissionCell = statusBadge('Upcoming', `Pending (${permission.leave_time})`);
      } else if (permission.status === 'approved') {
        permissionCell = statusBadge('Present', `Leave at ${permission.leave_time}`);
      } else {
        permissionCell = statusBadge('Absent', 'Rejected');
      }
    }
    const breakCell = r.status.breakMinutes > 0 || r.status.onBreak
      ? `${formatMinutesAsHM(r.status.breakMinutes || 0)}${r.status.onBreak ? ' <span style="color:#B26A00;font-weight:600;">(on break)</span>' : ''}`
      : '—';
    return `
    <tr>
      <td><a href="/calendar?employee_id=${escapeHtml(r.employee.id)}" style="color:#1B2430;text-decoration:none;font-weight:600;">${escapeHtml(r.employee.name)}</a> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(r.employee.id)})</span></td>
      <td>${statusBadge(r.status.status, r.status.label)}</td>
      <td>${r.status.checkIn ? escapeHtml(r.status.checkIn.split(' ')[1]) : '—'}</td>
      <td>${checkOutCell}</td>
      <td style="font-variant-numeric:tabular-nums;">${hoursCell}</td>
      <td>${breakCell}</td>
      <td>${permissionCell}</td>
      <td>${actionButton('/admin/toggle-onsite', { employee_id: r.employee.id, date: dateStr, return: basePath }, r.employee.onsite_enabled ? 'On ✓' : 'Off', r.employee.onsite_enabled ? '#2E7D32' : '#9AA5B1')}</td>
    </tr>`;
  }))).join('');

  const totalEmployees = rows.length;
  const workingNow = rows.filter(r => r.status.status === 'Active').length;
  const statsWidgets = opts.showStats ? `
    <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;">
      <div class="card" style="flex:1;min-width:160px;margin-bottom:0;">
        <div style="font-size:2em;font-weight:700;">${totalEmployees}</div>
        <div style="color:#7C8896;font-size:0.85em;">Total Employees</div>
      </div>
      <div class="card" style="flex:1;min-width:160px;margin-bottom:0;">
        <div style="font-size:2em;font-weight:700;color:#1565C0;">${workingNow}</div>
        <div style="color:#7C8896;font-size:0.85em;">Working Right Now</div>
      </div>
    </div>` : '';
  const devicePinsLink = opts.showStats
    ? `<div style="margin:-8px 0 16px;display:flex;gap:16px;flex-wrap:wrap;">
        <a href="/admin/device-pins" style="font-size:0.85em;color:#1565C0;text-decoration:none;font-weight:600;">Manage biometric device PIN mappings &rarr;</a>
      </div>`
    : '';

  const body = `
    ${statsWidgets}
    ${devicePinsLink}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
        <a href="${basePath}?date=${prevStr}" style="text-decoration:none;font-size:1.2em;">&#8249;</a>
        <div style="font-weight:700;">${label}</div>
        <a href="${basePath}?date=${nextStr}" style="text-decoration:none;font-size:1.2em;">&#8250;</a>
        <input type="date" value="${dateStr}" onchange="location.href='${basePath}?date=' + this.value" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
      </div>
      <table><tr><th>Employee</th><th>Status</th><th>Check In</th><th>Check Out</th><th>Hours</th><th>Break</th><th>Permission</th><th>On-Site Duty <span style="font-weight:400;">(tap to toggle)</span></th></tr>${tableRows}</table>
    </div>
    <script>
      function tickAll() {
        document.querySelectorAll('.liveHours').forEach(el => {
          const diff = Math.max(0, Date.now() - new Date(el.dataset.checkin).getTime());
          const h = String(Math.floor(diff / 3600000)).padStart(2, '0');
          const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
          const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
          el.textContent = h + ':' + m + ':' + s;
        });
      }
      tickAll(); setInterval(tickAll, 1000);
    </script>`;
  return pageShell(title, (rows[0] && rows[0].employee.id) || '', activeNav, body, user);
}

async function renderAdminLeave(requests, balanceRows, user) {
  const pending = requests.filter(r => r.status === 'pending');
  const history = requests.filter(r => r.status !== 'pending');

  const pendingRows = (await Promise.all(pending.map(async r => {
    const emp = await getEmployee(r.employee_id);
    return `
    <tr>
      <td><strong>${escapeHtml(emp ? emp.name : r.employee_id)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(r.employee_id)})</span></td>
      <td>${escapeHtml(r.leave_type)}</td>
      <td>${escapeHtml(r.start_date)} &ndash; ${escapeHtml(r.end_date)}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>
        ${actionButton('/leave/decide', { id: r.id, action: 'approve', employee_id: r.employee_id }, 'Approve', '#2E7D32', true)}
        ${actionButton('/leave/decide', { id: r.id, action: 'reject', employee_id: r.employee_id }, 'Reject', '#C62828')}
      </td>
    </tr>`;
  }))).join('') || `<tr><td colspan="5" style="color:#9AA5B1;">No pending requests</td></tr>`;

  const historyRows = (await Promise.all(history.map(async r => {
    const emp = await getEmployee(r.employee_id);
    return `
    <tr>
      <td>${escapeHtml(emp ? emp.name : r.employee_id)} <span style="color:#9AA5B1;">(${escapeHtml(r.employee_id)})</span></td>
      <td>${escapeHtml(r.leave_type)}</td>
      <td>${escapeHtml(r.start_date)} &ndash; ${escapeHtml(r.end_date)}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>${statusBadge(r.status === 'approved' ? 'Present' : 'Absent', r.status)}</td>
    </tr>`;
  }))).join('') || `<tr><td colspan="5" style="color:#9AA5B1;">No history yet</td></tr>`;

  const typeHeaders = LEAVE_TYPES.map(t => `<th>${escapeHtml(t)}</th>`).join('');
  const balanceTableRows = balanceRows.map(r => {
    const cells = LEAVE_TYPES.map(t => {
      const b = r.balances.find(x => x.leave_type === t);
      return `<td>${b ? b.balance : '—'}</td>`;
    }).join('');
    return `
    <tr>
      <td><strong>${escapeHtml(r.employee.name)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(r.employee.id)})</span></td>
      ${cells}
    </tr>`;
  }).join('');

  const body = `
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">Pending — All Employees</div>
      <table><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Reason</th><th>Action</th></tr>${pendingRows}</table>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">History — All Employees</div>
      <table><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Reason</th><th>Status</th></tr>${historyRows}</table>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px;">Leave Balances — All Employees</div>
      <p style="color:#7C8896;font-size:0.85em;margin-top:0;">
        Casual Leave / Sick Leave show paid days left this month (resets monthly, ${MONTHLY_PAID_LEAVE_CAP} paid day each —
        anything beyond that is still allowed, just unpaid). Comp Off is a running balance, unchanged.
      </p>
      <table><tr><th>Employee</th>${typeHeaders}</tr>${balanceTableRows}</table>
    </div>`;
  return pageShell('Leave', '', 'leave', body, user);
}

async function renderAdminPermission(requests, hoursReportRows, user) {
  const pending = requests.filter(r => r.status === 'pending');
  const history = requests.filter(r => r.status !== 'pending');

  const hoursCell = async r => {
    const emp = await getEmployee(r.employee_id);
    const h = emp ? computePermissionHours(emp, r.date, r.leave_time) : 0;
    return h > PERMISSION_DAILY_CAP_HOURS
      ? `<span style="color:#C62828;font-weight:600;">${h}h</span>`
      : `${h}h`;
  };

  const pendingRows = (await Promise.all(pending.map(async r => {
    const emp = await getEmployee(r.employee_id);
    return `
    <tr>
      <td><strong>${escapeHtml(emp ? emp.name : r.employee_id)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(r.employee_id)})</span></td>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(r.leave_time)}</td>
      <td>${await hoursCell(r)}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>
        ${actionButton('/permission/decide', { id: r.id, action: 'approve', employee_id: r.employee_id }, 'Approve', '#2E7D32', true)}
        ${actionButton('/permission/decide', { id: r.id, action: 'reject', employee_id: r.employee_id }, 'Reject', '#C62828')}
      </td>
    </tr>`;
  }))).join('') || `<tr><td colspan="6" style="color:#9AA5B1;">No pending requests</td></tr>`;

  const historyRows = (await Promise.all(history.map(async r => {
    const emp = await getEmployee(r.employee_id);
    return `
    <tr>
      <td>${escapeHtml(emp ? emp.name : r.employee_id)} <span style="color:#9AA5B1;">(${escapeHtml(r.employee_id)})</span></td>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(r.leave_time)}</td>
      <td>${await hoursCell(r)}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>${statusBadge(r.status === 'approved' ? 'Present' : 'Absent', r.status)}</td>
    </tr>`;
  }))).join('') || `<tr><td colspan="6" style="color:#9AA5B1;">No history yet</td></tr>`;

  const reportRows = hoursReportRows.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.employee.name)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(r.employee.id)})</span></td>
      <td>${r.usedHours}h</td>
      <td>${r.remainingHours < 0
        ? `<span style="color:#C62828;font-weight:600;">${r.remainingHours}h over</span>`
        : `${r.remainingHours}h`}</td>
    </tr>`).join('');

  const body = `
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">Pending — All Employees</div>
      <table><tr><th>Employee</th><th>Date</th><th>Leaving At</th><th>Hours</th><th>Reason</th><th>Action</th></tr>${pendingRows}</table>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">History — All Employees</div>
      <table><tr><th>Employee</th><th>Date</th><th>Leaving At</th><th>Hours</th><th>Reason</th><th>Status</th></tr>${historyRows}</table>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">Permission Hours — This Month</div>
      <table><tr><th>Employee</th><th>Used</th><th>Remaining</th></tr>${reportRows}</table>
    </div>`;
  return pageShell('Permission', '', 'permission', body, user);
}

async function renderAdminOvertime(requests, hoursReportRows, user, error) {
  const pending = requests.filter(r => r.status === 'pending');
  const history = requests.filter(r => r.status !== 'pending');
  const employeeOptions = (await allEmployees()).map(e =>
    `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)} (${escapeHtml(e.id)})</option>`
  ).join('');

  const pendingRows = (await Promise.all(pending.map(async r => {
    const emp = await getEmployee(r.employee_id);
    return `
    <tr>
      <td><strong>${escapeHtml(emp ? emp.name : r.employee_id)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(r.employee_id)})</span></td>
      <td>${escapeHtml(r.date)}</td>
      <td>${r.planned_hours != null ? escapeHtml(String(r.planned_hours)) + 'h' : '—'}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>
        ${actionButton('/overtime/decide', { id: r.id, action: 'approve', employee_id: r.employee_id }, 'Approve', '#2E7D32', true)}
        ${actionButton('/overtime/decide', { id: r.id, action: 'reject', employee_id: r.employee_id }, 'Reject', '#C62828')}
      </td>
    </tr>`;
  }))).join('') || `<tr><td colspan="5" style="color:#9AA5B1;">No pending requests</td></tr>`;

  const historyRows = (await Promise.all(history.map(async r => {
    const emp = await getEmployee(r.employee_id);
    return `
    <tr>
      <td>${escapeHtml(emp ? emp.name : r.employee_id)} <span style="color:#9AA5B1;">(${escapeHtml(r.employee_id)})</span></td>
      <td>${escapeHtml(r.date)}</td>
      <td>${r.planned_hours != null ? escapeHtml(String(r.planned_hours)) + 'h' : '—'}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>${statusBadge(r.status === 'approved' ? 'Present' : 'Absent', r.status)}</td>
    </tr>`;
  }))).join('') || `<tr><td colspan="5" style="color:#9AA5B1;">No history yet</td></tr>`;

  const reportRows = hoursReportRows.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.employee.name)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(r.employee.id)})</span></td>
      <td>${formatMinutesAsHM(r.authorizedMinutes)}</td>
      <td>${r.unauthorizedMinutes > 0
        ? `<span style="color:#C62828;font-weight:600;">${formatMinutesAsHM(r.unauthorizedMinutes)}</span>`
        : formatMinutesAsHM(r.unauthorizedMinutes)}</td>
    </tr>`).join('');

  const body = `
    ${error ? `<div class="card" style="color:#C62828;">${escapeHtml(error)}</div>` : ''}
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px;">Apply for Employee</div>
      <p style="color:#7C8896;font-size:0.9em;margin-top:0;">For staff who can't file their own request (no phone, etc). This is recorded as already authorized — no separate approval step.</p>
      <form method="POST" action="/overtime/apply" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Employee</label>
          <select name="employee_id" required style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">${employeeOptions}</select>
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Date</label>
          <input type="date" name="date" required style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Planned hours</label>
          <input type="number" name="planned_hours" step="0.5" min="0.5" required style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:90px;">
        </div>
        <div style="flex:1;min-width:140px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">Reason</label>
          <input type="text" name="reason" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
        </div>
        <button type="submit" style="padding:8px 16px;border-radius:6px;border:none;background:#1565C0;color:#fff;font-weight:600;">Record</button>
      </form>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">Pending — All Employees</div>
      <table><tr><th>Employee</th><th>Date</th><th>Planned Hours</th><th>Reason</th><th>Action</th></tr>${pendingRows}</table>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">History — All Employees</div>
      <table><tr><th>Employee</th><th>Date</th><th>Planned Hours</th><th>Reason</th><th>Status</th></tr>${historyRows}</table>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:4px;">Overtime Hours Worked — This Month</div>
      <p style="color:#7C8896;font-size:0.85em;margin-top:0;">Actual hours worked beyond shift end, from real punches only (auto-checkouts excluded). Unauthorized means hours were worked without an approved request covering that date.</p>
      <table><tr><th>Employee</th><th>Authorized</th><th>Unauthorized</th></tr>${reportRows}</table>
    </div>`;
  return pageShell('Overtime', '', 'overtime', body, user);
}

async function renderAdminOnsite(punches, user) {
  const rows = (await Promise.all(punches.map(async p => {
    const emp = await getEmployee(p.employee_id);
    return `
    <tr>
      <td><strong>${escapeHtml(emp ? emp.name : p.employee_id)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(p.employee_id)})</span></td>
      <td>${p.direction === 'in' ? 'Punch In' : 'Punch Out'}</td>
      <td>${escapeHtml(p.timestamp)}</td>
      <td>${escapeHtml(p.marked_by || '—')}</td>
      <td>${locationCell(p)}</td>
    </tr>`;
  }))).join('') || `<tr><td colspan="5" style="color:#9AA5B1;">No on-site duty punches yet</td></tr>`;

  const body = `
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">On-Site Duty Punches — All Employees</div>
      <table><tr><th>Employee</th><th>Event</th><th>Time</th><th>Marked By</th><th>Location</th></tr>${rows}</table>
    </div>
    <div class="card" style="color:#7C8896;font-size:0.9em;">To turn on-site duty on or off for someone, use the toggle on <a href="/dashboard" style="color:#1565C0;">Dashboard</a>.</div>`;
  return pageShell('On-Site', '', 'onsite', body, user);
}

// IDs are EMP-00N today, but padding shouldn't cap the count — padStart(3) just
// stops padding once the number itself is 3+ digits, it doesn't truncate.
async function nextEmployeeId() {
  const employees = await allEmployees();
  const maxN = employees.reduce((max, e) => {
    const n = parseInt(String(e.id).replace(/^EMP-0*/, ''), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `EMP-${String(maxN + 1).padStart(3, '0')}`;
}

async function renderEmployeeRegistration(user, error) {
  const existingEmployees = await allEmployees();
  const reportsToOptions = existingEmployees
    .map(e => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)} (${escapeHtml(e.id)})</option>`)
    .join('');
  const nextId = await nextEmployeeId();
  const employeeRows = existingEmployees.map(e => `
    <tr>
      <td><strong>${escapeHtml(e.name)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(e.id)})</span></td>
      <td>${escapeHtml(e.designation || '—')}</td>
      <td>${escapeHtml(e.branch || '—')}</td>
      <td>${escapeHtml(e.shift_start)}&ndash;${escapeHtml(e.shift_end)}</td>
      <td><a href="/admin/employee/edit?employee_id=${encodeURIComponent(e.id)}" style="color:#1565C0;text-decoration:none;font-weight:600;">Edit</a></td>
    </tr>`).join('') || `<tr><td colspan="5" style="color:#9AA5B1;">No employees yet</td></tr>`;

  const body = `
    ${error ? `<div class="card" style="color:#C62828;">${escapeHtml(error)}</div>` : ''}
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">Employee Registration</div>
      <p style="color:#7C8896;font-size:0.9em;margin-top:0;">New employee will be enrolled as <strong>${escapeHtml(nextId)}</strong>.</p>
      <form method="POST" action="/admin/employee-registration" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <div style="flex:1;min-width:180px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">Name</label>
          <input type="text" name="name" required style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Role</label>
          <select name="role" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
            ${EMPLOYMENT_TYPES.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1;min-width:160px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">Designation</label>
          <input type="text" name="designation" placeholder="e.g. Sales Associate" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Branch</label>
          <select name="branch" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
            ${BRANCHES.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1;min-width:180px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">Reports To</label>
          <select name="reports_to" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
            <option value="">&mdash; None &mdash;</option>
            ${reportsToOptions}
          </select>
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Shift Start</label>
          <input type="time" name="shift_start" required value="09:30" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Shift End</label>
          <input type="time" name="shift_end" required value="18:30" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Date Joined</label>
          <input type="date" name="date_joined" required value="${escapeHtml(todayStr())}" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <button type="submit" style="padding:8px 16px;border-radius:6px;border:none;background:#1565C0;color:#fff;font-weight:600;">Register Employee</button>
      </form>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">Existing Employees</div>
      <table><tr><th>Employee</th><th>Designation</th><th>Branch</th><th>Shift</th><th></th></tr>${employeeRows}</table>
    </div>
    <div class="card" style="color:#7C8896;font-size:0.9em;">
      A login is created automatically (username = employee ID, default password <code>password123</code>),
      with a forced password change on first sign-in. On-site access and biometric device PIN are set
      separately from <a href="/admin/device-pins" style="color:#1565C0;">Device PINs</a>. Company holidays
      are managed from the <a href="/calendar?view=company" style="color:#1565C0;">Calendar</a> tab.
    </div>`;
  return pageShell('Employee Registration', '', 'employee-registration', body, user);
}

async function renderEditEmployee(employee, user, error) {
  const reportsToOptions = (await allEmployees())
    .filter(e => e.id !== employee.id)
    .map(e => `<option value="${escapeHtml(e.id)}" ${e.id === employee.reports_to ? 'selected' : ''}>${escapeHtml(e.name)} (${escapeHtml(e.id)})</option>`)
    .join('');

  const body = `
    ${error ? `<div class="card" style="color:#C62828;">${escapeHtml(error)}</div>` : ''}
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">Edit Employee &mdash; ${escapeHtml(employee.id)}</div>
      <form method="POST" action="/admin/employee/edit" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <input type="hidden" name="employee_id" value="${escapeHtml(employee.id)}">
        <div style="flex:1;min-width:180px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">Name</label>
          <input type="text" name="name" required value="${escapeHtml(employee.name)}" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Role</label>
          <select name="role" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
            <option value="">&mdash; None &mdash;</option>
            ${EMPLOYMENT_TYPES.map(t => `<option value="${escapeHtml(t)}" ${t === employee.role ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1;min-width:160px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">Designation</label>
          <input type="text" name="designation" value="${escapeHtml(employee.designation || '')}" placeholder="e.g. Sales Associate" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Branch</label>
          <select name="branch" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
            <option value="">&mdash; None &mdash;</option>
            ${BRANCHES.map(b => `<option value="${escapeHtml(b)}" ${b === employee.branch ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1;min-width:180px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">Reports To</label>
          <select name="reports_to" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
            <option value="">&mdash; None &mdash;</option>
            ${reportsToOptions}
          </select>
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Shift Start</label>
          <input type="time" name="shift_start" required value="${escapeHtml(employee.shift_start)}" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Shift End</label>
          <input type="time" name="shift_end" required value="${escapeHtml(employee.shift_end)}" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Date Joined</label>
          <input type="date" name="date_joined" required value="${escapeHtml(employee.date_joined || todayStr())}" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <button type="submit" style="padding:8px 16px;border-radius:6px;border:none;background:#1565C0;color:#fff;font-weight:600;">Save Changes</button>
        <a href="/admin/employee-registration" style="padding:8px 16px;color:#7C8896;text-decoration:none;font-weight:600;">Cancel</a>
      </form>
    </div>`;
  return pageShell('Edit Employee', '', 'employee-registration', body, user);
}

async function renderReports(monthStr, punchInRows, punchInGrid, leaveRows, muster, user) {
  const punchInTableRows = punchInRows.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.name)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(r.id)})</span></td>
      <td>${r.present}</td>
      <td>${r.late}</td>
      <td>${r.halfDay}</td>
      <td>${r.absent}</td>
      <td>${r.totalHours}h</td>
      <td>${r.overtimeHours}h</td>
    </tr>`).join('') || `<tr><td colspan="7" style="color:#9AA5B1;">No employees</td></tr>`;

  const punchInDayHeaders = Array.from({ length: punchInGrid.daysInMonth }, (_, i) => `<th style="width:78px;">${i + 1}</th>`).join('');
  const punchInGridRows = punchInGrid.rows.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.name)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(r.id)})</span></td>
      ${r.cells.map(c => `<td style="background:${GRID_CELL_COLOR[c.status] || 'transparent'};">${escapeHtml(c.text)}</td>`).join('')}
    </tr>`).join('') || `<tr><td colspan="${punchInGrid.daysInMonth + 1}" style="color:#9AA5B1;">No employees</td></tr>`;

  const leaveTypeHeaders = LEAVE_TYPES.map(t => `<th>${escapeHtml(t)}</th>`).join('');
  const leaveTableRows = leaveRows.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.name)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(r.id)})</span></td>
      ${LEAVE_TYPES.map(t => `<td>${r.perType[t] || 0}</td>`).join('')}
      <td><strong>${r.totalDays}</strong></td>
      <td>${r.unpaidDays > 0 ? `<span style="color:#C62828;font-weight:600;">${r.unpaidDays}</span>` : '0'}</td>
    </tr>`).join('') || `<tr><td colspan="${LEAVE_TYPES.length + 3}" style="color:#9AA5B1;">No employees</td></tr>`;

  const musterDayHeaders = Array.from({ length: muster.daysInMonth }, (_, i) => `<th style="width:34px;">${i + 1}</th>`).join('');
  const musterTableRows = muster.rows.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.name)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(r.id)})</span></td>
      ${r.cells.map(c => `<td style="background:${GRID_CELL_COLOR[c.status] || 'transparent'};">${escapeHtml(c.code)}</td>`).join('')}
      <td><strong>${r.presentDays}</strong></td>
    </tr>`).join('') || `<tr><td colspan="${muster.daysInMonth + 2}" style="color:#9AA5B1;">No employees</td></tr>`;
  const musterCountRow = `
    <tr>
      <td><strong>Present Count</strong></td>
      ${muster.dailyPresentCounts.map(c => `<td><strong>${c}</strong></td>`).join('')}
      <td></td>
    </tr>`;

  const body = `
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">Reports</div>
      <label style="display:block;font-size:0.8em;color:#7C8896;">Month</label>
      <input type="month" value="${escapeHtml(monthStr)}" onchange="location.href='/admin/reports?month=' + this.value" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <div style="font-weight:700;">Muster Report</div>
        <a href="/admin/reports/muster.csv?month=${escapeHtml(monthStr)}" style="font-size:0.85em;color:#1565C0;text-decoration:none;font-weight:600;">Download CSV &darr;</a>
      </div>
      <p style="color:#7C8896;font-size:0.85em;margin-top:0;">
        P=Present, <span style="background:${GRID_CELL_COLOR['Late']};padding:1px 6px;border-radius:4px;">L=Late</span>, HD=Half Day, A=Absent, WO=Week Off, H=Holiday, OL=On Leave, AC=Active (in progress), PE=Punch Error.
        "Present Count" is the row at the bottom — how many employees showed up that day.
      </p>
      <table class="grid-table"><tr><th>Employee</th>${musterDayHeaders}<th style="width:90px;">Present Days</th></tr>${musterTableRows}${musterCountRow}</table>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <div style="font-weight:700;">Punch-In Detail</div>
        <a href="/admin/reports/punch-in-detail.csv?month=${escapeHtml(monthStr)}" style="font-size:0.85em;color:#1565C0;text-decoration:none;font-weight:600;">Download CSV &darr;</a>
      </div>
      <p style="color:#7C8896;font-size:0.85em;margin-top:0;">
        Each cell is that day's check-in&ndash;check-out (highlighted <span style="background:${GRID_CELL_COLOR['Late']};padding:1px 6px;border-radius:4px;">yellow</span> with an "L" prefix if late), or a status code
        on days with no punches: ${Object.entries(MUSTER_STATUS_CODE).map(([k, v]) => `${escapeHtml(v)}=${escapeHtml(k)}`).join(', ')}.
      </p>
      <table class="grid-table"><tr><th>Employee</th>${punchInDayHeaders}</tr>${punchInGridRows}</table>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <div style="font-weight:700;">Punch-In Summary</div>
        <a href="/admin/reports/punch-in.csv?month=${escapeHtml(monthStr)}" style="font-size:0.85em;color:#1565C0;text-decoration:none;font-weight:600;">Download CSV &darr;</a>
      </div>
      <table><tr><th>Employee</th><th>Present</th><th>Late</th><th>Half Day</th><th>Absent</th><th>Total Hours</th><th>Overtime</th></tr>${punchInTableRows}</table>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <div style="font-weight:700;">Leave Taken Report</div>
        <a href="/admin/reports/leave.csv?month=${escapeHtml(monthStr)}" style="font-size:0.85em;color:#1565C0;text-decoration:none;font-weight:600;">Download CSV &darr;</a>
      </div>
      <p style="color:#7C8896;font-size:0.85em;margin-top:0;">
        Casual/Sick beyond ${MONTHLY_PAID_LEAVE_CAP} paid day each per month counts as Unpaid Days.
      </p>
      <table><tr><th>Employee</th>${leaveTypeHeaders}<th>Total Days</th><th>Unpaid Days</th></tr>${leaveTableRows}</table>
    </div>`;
  return pageShell('Reports', '', 'reports', body, user);
}

async function renderDevicePins(user, error) {
  const rows = (await allEmployees()).map(e => `
    <tr>
      <td><strong>${escapeHtml(e.name)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(e.id)})</span></td>
      <td>
        <form method="POST" action="/admin/set-device-pin" style="display:flex;gap:8px;align-items:center;">
          <input type="hidden" name="employee_id" value="${escapeHtml(e.id)}">
          <input type="text" name="device_pin" value="${escapeHtml(e.device_pin || '')}" placeholder="e.g. 1" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100px;">
          <button type="submit" style="padding:6px 14px;border-radius:6px;border:none;background:#1565C0;color:#fff;font-weight:600;cursor:pointer;">Save</button>
        </form>
      </td>
    </tr>`).join('');

  const body = `
    ${error ? `<div class="card" style="color:#C62828;">${escapeHtml(error)}</div>` : ''}
    <div class="card" style="color:#7C8896;font-size:0.9em;">
      Each row's PIN is the numeric ID that employee was enrolled under on the biometric device
      (check the device's user list, not this app). Leave blank for anyone who doesn't punch in on
      the device. See <a href="/admin/attendance" style="color:#1565C0;">Dashboard</a> for on-site duty.
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">Biometric Device PIN Mappings</div>
      <table><tr><th>Employee</th><th>Device PIN</th></tr>${rows}</table>
    </div>`;
  return pageShell('Device PINs', '', 'device-pins', body, user);
}

// Admin-only runtime configuration (see SETTING_DEFS). Shows where each value is
// actually coming from — database, environment, or built-in default — because the
// most confusing failure here is a setting that looks right in the UI while an
// environment variable of the same name is what the app is really using.
async function renderAdminSettings(user, opts = {}) {
  const { error, notice, revealedKey, revealedValue } = opts;
  const rows = await db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings').all();
  const stored = Object.fromEntries(rows.map(r => [r.key, r]));

  const fields = SETTING_DEFS.map(def => {
    const row = stored[def.key];
    const inDb = !!(row && row.value !== '');
    const inEnv = !!process.env[def.key];
    const source = inDb ? 'Database' : (inEnv ? 'Environment variable' : 'Built-in default');
    const sourceColor = inDb ? '#1565C0' : (inEnv ? '#B26A00' : '#7C8896');
    const updated = row ? ` &middot; changed ${escapeHtml(row.updated_at)}${row.updated_by ? ` by ${escapeHtml(row.updated_by)}` : ''}` : '';

    // Secrets are never rendered back into the page. A blank submission leaves the
    // stored value alone, so an admin editing an unrelated field cannot wipe a key
    // by simply not retyping it; clearing one is an explicit checkbox.
    const input = def.secret
      ? `<input type="password" name="${def.key}" value="" autocomplete="new-password" placeholder="${inDb ? 'Set — leave blank to keep unchanged' : 'Not set'}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #D0D5DA;">
         <label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:0.82em;color:#7C8896;">
           <input type="checkbox" name="__clear__${def.key}" value="1" style="width:auto;"> Clear this value
         </label>`
      : `<input type="text" name="${def.key}" value="${escapeHtml(inDb ? row.value : '')}" placeholder="${escapeHtml(String(process.env[def.key] || def.fallback || ''))}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #D0D5DA;">`;

    const generate = def.key === 'PUNCH_API_KEY'
      ? `<div style="margin-top:8px;"><button type="submit" form="generateKeyForm" style="padding:6px 12px;border-radius:6px;border:1px solid #D0D5DA;background:#fff;color:#1565C0;font-weight:600;cursor:pointer;font-size:0.85em;">Generate a new key</button></div>`
      : '';

    return `
      <div style="padding:16px 0;border-bottom:1px solid #EEF1F3;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;">
          <label style="font-weight:700;">${escapeHtml(def.label)}</label>
          <span style="font-size:0.75em;color:${sourceColor};font-weight:600;">${source}${updated}</span>
        </div>
        <div style="color:#7C8896;font-size:0.85em;margin:6px 0 10px;">${escapeHtml(def.help)}</div>
        ${input}
        ${generate}
      </div>`;
  }).join('');

  const body = `
    ${error ? `<div class="card" style="color:#C62828;">${escapeHtml(error)}</div>` : ''}
    ${notice ? `<div class="card" style="color:#1B5E20;background:#E8F5E9;border-color:#C8E6C9;">${escapeHtml(notice)}</div>` : ''}
    ${revealedKey ? `<div class="card" style="border-color:#B26A00;">
      <div style="font-weight:700;margin-bottom:6px;">New ${escapeHtml(revealedKey)}</div>
      <div style="color:#7C8896;font-size:0.85em;margin-bottom:10px;">Copy it now and configure the device with it — it is shown once and cannot be retrieved again. It is already saved and in effect.</div>
      <code style="display:block;word-break:break-all;background:#F5F6F8;padding:10px;border-radius:6px;">${escapeHtml(revealedValue)}</code>
    </div>` : ''}
    <div class="card" style="color:#7C8896;font-size:0.9em;">
      These take effect within ${Math.round(SETTINGS_CACHE_TTL_MS / 1000)} seconds without a redeploy. A value saved here
      overrides the environment variable of the same name; clear it to fall back to the
      environment. The database connection, cron secret and bootstrap password are not
      listed because they are needed before this page can be read.
    </div>
    <form method="POST" action="/admin/settings" class="card">
      <div style="font-weight:700;margin-bottom:4px;">Settings</div>
      ${fields}
      <button type="submit" style="margin-top:18px;padding:9px 20px;border-radius:6px;border:none;background:#1565C0;color:#fff;font-weight:600;cursor:pointer;">Save settings</button>
    </form>
    <form method="POST" action="/admin/settings/generate-punch-key" id="generateKeyForm"></form>`;
  return pageShell('Settings', '', 'settings', body, user);
}

// Shared by both Calendar sub-views (Company Calendar / Employees' Calendars) — a simple
// two-link toggle at the top, carrying the current employee_id so the switcher/nav
// keeps working underneath either view.
function calendarViewToggle(employeeId, activeView) {
  const tabStyle = (active) => `padding:6px 14px;border-radius:8px;text-decoration:none;font-weight:600;font-size:0.9em;${active ? 'background:#1565C0;color:#fff;' : 'background:#F0F2F4;color:#4C5A68;'}`;
  return `
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      <a href="/calendar?employee_id=${escapeHtml(employeeId)}&view=company" style="${tabStyle(activeView === 'company')}">Company Calendar</a>
      <a href="/calendar?employee_id=${escapeHtml(employeeId)}" style="${tabStyle(activeView === 'mine')}">Employees' Calendars</a>
    </div>`;
}

async function renderCompanyCalendar(year, month, employeeId, user, error) {
  const isAdmin = user && user.role === 'admin';
  const monthStr = String(month).padStart(2, '0');
  const firstOfMonth = new Date(`${year}-${monthStr}-01T00:00:00`);
  const daysInMonth = new Date(year, month, 0).getDate();
  const startWeekday = firstOfMonth.getDay();
  const monthName = firstOfMonth.toLocaleString('en-US', { month: 'long' });

  const monthHolidays = await db.prepare('SELECT * FROM holidays WHERE date LIKE ? ORDER BY date').all(`${year}-${monthStr}-%`);
  const holidayByDate = Object.fromEntries(monthHolidays.map(h => [h.date, h.name]));

  const headerCells = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    .map(d => `<div style="color:#7C8896;font-size:0.75em;text-align:center;padding-bottom:6px;">${d}</div>`);
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push('<div></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${monthStr}-${String(d).padStart(2, '0')}`;
    const holidayName = holidayByDate[dateStr];
    const isToday = dateStr === todayStr();
    const s = holidayName ? STATUS_STYLE['Holiday'] : { fg: '#1B2430', bg: '#F5F6F8' };
    cells.push(`<div style="background:${s.bg};color:${s.fg};border-radius:8px;padding:8px 6px;min-height:52px;overflow-wrap:break-word;${isToday ? 'outline:2px solid #1565C0;' : ''}">
      <div style="font-weight:700;">${d}</div>
      ${holidayName ? `<div class="cal-status" style="font-size:0.72em;font-weight:600;overflow-wrap:break-word;hyphens:auto;">${escapeHtml(holidayName)}</div>` : ''}
    </div>`);
  }

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const navLink = (y, m) => `/calendar?employee_id=${escapeHtml(employeeId)}&view=company&year=${y}&month=${m}`;

  const yearHolidays = await db.prepare('SELECT * FROM holidays WHERE date LIKE ? ORDER BY date').all(`${year}-%`);
  const yearRows = yearHolidays.map(h => `
    <tr>
      <td>${escapeHtml(h.date)}</td>
      <td>${escapeHtml(h.name)}</td>
      <td>${isAdmin ? actionButton('/admin/holidays/delete', { date: h.date, return_year: year, return_month: month, employee_id: employeeId }, 'Delete', '#C62828') : ''}</td>
    </tr>`).join('') || `<tr><td colspan="3" style="color:#9AA5B1;">No holidays in ${year}</td></tr>`;

  const body = `
    ${calendarViewToggle(employeeId, 'company')}
    ${error ? `<div class="card" style="color:#C62828;">${escapeHtml(error)}</div>` : ''}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <a href="${navLink(prevYear, prevMonth)}" style="text-decoration:none;font-size:1.2em;">&#8249;</a>
        <div style="font-weight:700;font-size:1.1em;">${monthName} ${year}</div>
        <a href="${navLink(nextYear, nextMonth)}" style="text-decoration:none;font-size:1.2em;">&#8250;</a>
      </div>
      <div class="cal-grid" style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;">${headerCells.join('')}${cells.join('')}</div>
    </div>
    ${isAdmin ? `
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">Add Holiday</div>
      <form method="POST" action="/admin/holidays/add" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <input type="hidden" name="employee_id" value="${escapeHtml(employeeId)}">
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Date</label>
          <input type="date" name="date" required value="${escapeHtml(`${year}-${monthStr}-01`)}" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div style="flex:1;min-width:200px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">Name</label>
          <input type="text" name="name" required placeholder="e.g. Diwali" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
        </div>
        <button type="submit" style="padding:8px 16px;border-radius:6px;border:none;background:#1565C0;color:#fff;font-weight:600;">Add Holiday</button>
      </form>
    </div>` : ''}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div style="font-weight:700;">Holidays in ${year}</div>
        <div style="display:flex;gap:10px;">
          <a href="${navLink(year - 1, month)}" style="text-decoration:none;font-size:0.85em;color:#1565C0;font-weight:600;">&larr; ${year - 1}</a>
          <a href="${navLink(year + 1, month)}" style="text-decoration:none;font-size:0.85em;color:#1565C0;font-weight:600;">${year + 1} &rarr;</a>
        </div>
      </div>
      <p style="color:#7C8896;font-size:0.85em;margin-top:0;">
        The 3 national holidays (Republic Day, Independence Day, Gandhi Jayanti) are seeded automatically for
        2024&ndash;2030 &mdash; deleting one here will bring it back on the next server restart.
      </p>
      <table><tr><th>Date</th><th>Name</th><th></th></tr>${yearRows}</table>
    </div>`;
  return pageShell('Company Calendar', employeeId, 'calendar-company', body, user);
}

async function renderNotifications(employee, notifications, user) {
  const lang = langOf(user);
  const rows = notifications.map(n => `
    <div class="card" style="padding:14px 18px;${n.read ? '' : 'border-left:3px solid #1565C0;'}">
      <div style="font-size:0.78em;color:#9AA5B1;">${escapeHtml(n.created_at)}</div>
      <div>${escapeHtml(n.message)}</div>
    </div>`).join('') || `<div class="card" style="color:#9AA5B1;">${t(lang, 'notifications.none')}</div>`;
  return pageShell(t(lang, 'notifications.title'), employee.id, 'notifications', rows, user);
}

async function renderAdminNotifications(notifications, user) {
  const rows = (await Promise.all(notifications.map(async n => {
    const emp = await getEmployee(n.employee_id);
    return `
    <div class="card" style="padding:14px 18px;${n.read ? '' : 'border-left:3px solid #1565C0;'}">
      <div style="font-size:0.78em;color:#9AA5B1;">${escapeHtml(n.created_at)} &middot; ${escapeHtml(emp ? emp.name : n.employee_id)} <span style="color:#9AA5B1;">(${escapeHtml(n.employee_id)})</span></div>
      <div>${escapeHtml(n.message)}</div>
    </div>`;
  }))).join('') || `<div class="card" style="color:#9AA5B1;">No notifications yet</div>`;
  return pageShell('Notifications', '', 'notifications', rows, user);
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

function csvField(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers, rows) {
  return [headers, ...rows].map(row => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}
function sendCsv(res, filename, csv) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.end(csv);
}
// Caps how much of a request body we'll buffer into memory — an unbounded read
// lets one request (no auth required to trigger it, since the body is read before
// most routes check credentials) exhaust server memory. 64KB comfortably covers any
// real login/punch/form payload. The ADMS device gets a much larger allowance since
// a catch-up push after an extended outage can legitimately contain many records.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ADMS_BODY_BYTES = 2 * 1024 * 1024;
function tooLargeError() {
  return Object.assign(new Error('Request body too large'), { statusCode: 413 });
}
// Reads the raw request body as a string. Works both with a live request stream
// (the standalone Node server) and when the platform has already buffered the body
// into req.body as a string/Buffer (some serverless runtimes, incl. Vercel).
function bufferBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body, 'utf8') > maxBytes) return reject(tooLargeError());
      return resolve(req.body);
    }
    if (Buffer.isBuffer(req.body)) {
      if (req.body.length > maxBytes) return reject(tooLargeError());
      return resolve(req.body.toString('utf8'));
    }
    const chunks = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        // Stop accumulating (later chunks hit the `done` guard above and are
        // dropped) but don't destroy the socket — req and res share it, and
        // destroying it here would prevent the 413 response from ever reaching
        // the client. The rest of the body just drains and gets discarded.
        chunks.length = 0;
        reject(tooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}
async function readJsonBody(req) {
  // Some runtimes pre-parse JSON into req.body — use it as-is if so.
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await bufferBody(req);
  return raw ? JSON.parse(raw) : {};
}
async function readFormBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  return Object.fromEntries(new URLSearchParams(await bufferBody(req)));
}
// ADMS log uploads are plain tab/newline-separated text, not JSON or form-encoded —
// and can be a large batch after the device catches up from an outage, hence the
// bigger allowance.
async function readTextBody(req) {
  return bufferBody(req, MAX_ADMS_BODY_BYTES);
}

// --- Sessions: persisted in the sessions table, so a restart (crash, NSSM
// redeploy, power loss) doesn't silently log everyone out. ---
const SESSION_IDLE_TTL_MS = 8 * 60 * 60 * 1000; // sliding: 8 hours since last request
const SESSION_ABSOLUTE_TTL_MS = 24 * 60 * 60 * 1000; // hard cap: 24 hours since login, regardless of activity
// (The one-time sweep of already-expired sessions runs in init(), above.)
async function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  await db.prepare(
    'INSERT INTO sessions (token, user_id, username, role, employee_id, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(token, user.id, user.username, user.role, user.employee_id, now, now);
  return token;
}
function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(header.split(';').map(p => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())];
  }));
}
async function deleteSession(token) {
  await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
function locationiqUrl(path) {
  return new URL(CONFIG.LOCATIONIQ_BASE_URL.replace(/\/$/, '') + path);
}
function formatDurationSeconds(sec) {
  if (sec == null) return '';
  const mins = Math.round(sec / 60);
  if (mins < 60) return mins + ' min' + (mins === 1 ? '' : 's');
  const h = Math.floor(mins / 60), m = mins % 60;
  return h + ' hr' + (h === 1 ? '' : 's') + (m ? ' ' + m + ' min' : '');
}

// --- LocationIQ: autocomplete, forward/reverse geocode, driving distance ---
// LocationIQ autocomplete returns an array of {display_name, lat, lon, ...} (or an
// {error} object when nothing matches). Each result already carries coordinates, so a
// picked suggestion needs no extra geocoding before the distance call.
function parseAutocomplete(data) {
  if (!Array.isArray(data)) return [];
  return data
    .map(r => ({ description: r.display_name, lat: r.lat, lon: r.lon }))
    .filter(x => x.description && x.lat != null && x.lon != null);
}
async function placesAutocomplete(input) {
  if (!CONFIG.LOCATIONIQ_API_KEY) throw new Error('Maps API key is not configured on the server.');
  const url = locationiqUrl('/autocomplete');
  url.searchParams.set('key', CONFIG.LOCATIONIQ_API_KEY);
  url.searchParams.set('q', input);
  url.searchParams.set('limit', '10');
  url.searchParams.set('dedupe', '1');
  if (CONFIG.PLACES_COUNTRY) url.searchParams.set('countrycodes', CONFIG.PLACES_COUNTRY);
  if (CONFIG.PLACES_VIEWBOX) { url.searchParams.set('viewbox', CONFIG.PLACES_VIEWBOX); url.searchParams.set('bounded', '1'); }
  let data;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    data = await resp.json();
  } catch {
    throw new Error('Could not reach the maps service.');
  }
  return parseAutocomplete(data);
}

// Forward geocode: used when the user typed an address but didn't pick a suggestion, so
// we have no coordinates yet. Returns { lat, lon, display } or null.
function parseForwardGeocode(data) {
  if (!Array.isArray(data) || !data.length) return null;
  const r = data[0];
  if (r.lat == null || r.lon == null) return null;
  return { lat: r.lat, lon: r.lon, display: r.display_name || '' };
}
async function forwardGeocode(text) {
  if (!CONFIG.LOCATIONIQ_API_KEY) throw new Error('Maps API key is not configured on the server.');
  const url = locationiqUrl('/search');
  url.searchParams.set('key', CONFIG.LOCATIONIQ_API_KEY);
  url.searchParams.set('q', text);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  if (CONFIG.PLACES_COUNTRY) url.searchParams.set('countrycodes', CONFIG.PLACES_COUNTRY);
  if (CONFIG.PLACES_VIEWBOX) { url.searchParams.set('viewbox', CONFIG.PLACES_VIEWBOX); url.searchParams.set('bounded', '1'); }
  let data;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    data = await resp.json();
  } catch {
    throw new Error('Could not reach the maps service.');
  }
  return parseForwardGeocode(data);
}

// Reverse geocode "lat,lon" into a readable address. Returns '' on any failure — callers
// must never let a geocoding hiccup block the punch itself.
function parseReverseGeocode(data) {
  if (!data || data.error) return '';
  return data.display_name || '';
}
async function reverseGeocode(lat, lon) {
  if (!CONFIG.LOCATIONIQ_API_KEY) return '';
  const url = locationiqUrl('/reverse');
  url.searchParams.set('key', CONFIG.LOCATIONIQ_API_KEY);
  url.searchParams.set('lat', lat);
  url.searchParams.set('lon', lon);
  url.searchParams.set('format', 'json');
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return parseReverseGeocode(await resp.json());
  } catch { return ''; }
}

// Driving distance between two coordinate pairs via LocationIQ Directions (OSRM). Note
// the URL takes lon,lat order. Returns { distanceKm, durationText }.
function parseDirections(data) {
  if (!data || data.code !== 'Ok' || !Array.isArray(data.routes) || !data.routes.length) {
    throw new Error('No driving route found between those two places.');
  }
  const r = data.routes[0];
  return { distanceKm: Math.round((r.distance / 1000) * 100) / 100, durationText: formatDurationSeconds(r.duration) };
}
async function roadDistanceByCoords(fromLat, fromLon, toLat, toLon) {
  if (!CONFIG.LOCATIONIQ_API_KEY) throw new Error('Maps API key is not configured on the server.');
  const coords = `${fromLon},${fromLat};${toLon},${toLat}`;
  const url = locationiqUrl('/directions/driving/' + coords);
  url.searchParams.set('key', CONFIG.LOCATIONIQ_API_KEY);
  url.searchParams.set('overview', 'false');
  let data;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    data = await resp.json();
  } catch {
    throw new Error('Could not reach the maps service — check the server\'s internet connection.');
  }
  return parseDirections(data);
}

// Resolves a trip request { from, to, from_lat?, from_lon?, to_lat?, to_lon? } to a
// driving distance + resolved addresses. A picked suggestion supplies coords; otherwise
// the typed text is forward-geocoded. Throws Error (with .status) on bad input / no match.
async function resolveTripDistance(body) {
  const from = (body.from || '').trim();
  const to = (body.to || '').trim();
  if (!from || !to) { const e = new Error('Please enter both a "from" and a "to" location.'); e.status = 400; throw e; }
  const fromLoc = (body.from_lat && body.from_lon) ? { lat: body.from_lat, lon: body.from_lon, display: from } : await forwardGeocode(from);
  if (!fromLoc) { const e = new Error(`Could not find "${from}". Pick a suggestion from the list.`); e.status = 502; throw e; }
  const toLoc = (body.to_lat && body.to_lon) ? { lat: body.to_lat, lon: body.to_lon, display: to } : await forwardGeocode(to);
  if (!toLoc) { const e = new Error(`Could not find "${to}". Pick a suggestion from the list.`); e.status = 502; throw e; }
  const dist = await roadDistanceByCoords(fromLoc.lat, fromLoc.lon, toLoc.lat, toLoc.lon);
  return { distanceKm: dist.distanceKm, durationText: dist.durationText, fromResolved: fromLoc.display || from, toResolved: toLoc.display || to };
}

async function getSessionUser(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const row = await db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  const userRow = await db.prepare('SELECT language FROM users WHERE id = ?').get(row.user_id);
  const session = {
    userId: row.user_id, username: row.username, role: row.role, employeeId: row.employee_id,
    createdAt: row.created_at, lastActivityAt: row.last_activity_at,
    language: (userRow && userRow.language) || 'en',
  };
  const now = Date.now();
  if (now - session.createdAt > SESSION_ABSOLUTE_TTL_MS || now - session.lastActivityAt > SESSION_IDLE_TTL_MS) {
    await deleteSession(token); // expired — never resurrect, force a fresh login
    return null;
  }
  session.lastActivityAt = now; // sliding window: any authenticated request extends the idle timer
  await db.prepare('UPDATE sessions SET last_activity_at = ? WHERE token = ?').run(now, token);
  return session;
}

// Every route handler lives in here, unchanged. The wrapper below catches whatever
// this throws or rejects so one bad request can never take down the whole process.
async function handleRequest(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host}`);

  // POST /api/punch  { employee_id, timestamp?, direction?, source? }
  // This is the endpoint the biometric device (or its middleware) calls per punch.
  if (parsed.pathname === '/api/punch' && req.method === 'POST') {
    // Two trust levels call this endpoint: the biometric device (API key, source
    // defaults to 'biometric') and an employee's own logged-in browser session (the
    // On-Site Duty and WiFi punch buttons) — session auth is restricted below to the
    // caller's own employee_id and source in ('on-site', 'wifi') only.
    const apiKey = req.headers['x-api-key'];
    const authorizedViaApiKey = apiKey === CONFIG.PUNCH_API_KEY;
    const sessionUser = authorizedViaApiKey ? null : await getSessionUser(req);
    const authorizedViaSession = !authorizedViaApiKey && !!sessionUser && sessionUser.role === 'employee';
    if (!authorizedViaApiKey && !authorizedViaSession) {
      logSecurityEvent('punch_auth_failed', { ip: req.socket.remoteAddress, hadApiKeyHeader: !!apiKey, hadSession: !!sessionUser });
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err && err.statusCode === 413) return sendJson(res, 413, { error: 'Request body too large' });
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    const { employee_id, timestamp, direction, source, location, marked_by } = body;
    if (!employee_id) return sendJson(res, 400, { error: 'employee_id is required' });

    if (authorizedViaSession) {
      if (employee_id !== sessionUser.employeeId) {
        logSecurityEvent('punch_auth_failed', { ip: req.socket.remoteAddress, reason: 'session employee_id mismatch', sessionEmployeeId: sessionUser.employeeId, requestedEmployeeId: employee_id });
        return sendJson(res, 403, { error: 'You can only punch your own attendance.' });
      }
      if (!['on-site', 'wifi'].includes(source || 'on-site')) {
        return sendJson(res, 403, { error: 'Only on-site duty or WiFi punches are allowed from a logged-in session.' });
      }
    }

    const employee = await getEmployee(employee_id);
    if (!employee) return sendJson(res, 404, { error: `Unknown employee_id: ${employee_id}` });

    if ((source || 'biometric') === 'on-site' && !employee.onsite_enabled) {
      return sendJson(res, 403, { error: 'On-site duty punching is not enabled for this employee. Biometric punch-in is required.' });
    }

    // WiFi punch: there's no browser API to check SSID, so "on the office network" is
    // verified by matching the caller's public IP against the configured office IP(s).
    if (source === 'wifi') {
      if (CONFIG.OFFICE_WIFI_IPS.size === 0) {
        return sendJson(res, 403, { error: 'WiFi punch-in is not configured yet. Ask your admin to set it up.' });
      }
      const clientIp = getClientIp(req);
      if (!CONFIG.OFFICE_WIFI_IPS.has(clientIp)) {
        logSecurityEvent('wifi_punch_rejected', { employeeId: employee_id, ip: clientIp });
        return sendJson(res, 403, { error: 'You must be connected to the office WiFi to punch in.' });
      }
    }

    const ts = timestamp || formatTimestamp(new Date());
    let dir = direction;
    if (!dir) {
      const last = await lastPunch(employee_id);
      dir = (last && last.direction === 'in') ? 'out' : 'in';
    }
    // For on-site punches, turn the captured "lat,lng" into a readable address so a
    // manager sees a place, not coordinates. Best-effort: never blocks the punch.
    let locationAddress = '';
    if ((source || 'biometric') === 'on-site' && location) {
      const coords = String(location).match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (coords) locationAddress = await reverseGeocode(coords[1], coords[2]);
    }
    const inserted = await recordPunch(employee_id, ts, dir, source || 'biometric', '', location || '', marked_by || '', locationAddress);

    const dayStatus = await computeDayStatus(employee_id, ts.split(' ')[0]);
    return sendJson(res, 200, { employee_id, name: employee.name, direction: dir, timestamp: ts, dayStatus, duplicate: !inserted });
  }

  // POST /api/break  { employee_id }
  // Self-service break toggle for a logged-in employee: pauses/resumes their work-hours
  // clock. Only makes sense while a punch-in is open, so it's rejected otherwise.
  if (parsed.pathname === '/api/break' && req.method === 'POST') {
    const sessionUser = await getSessionUser(req);
    if (!sessionUser || sessionUser.role !== 'employee') {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err && err.statusCode === 413) return sendJson(res, 413, { error: 'Request body too large' });
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    const { employee_id } = body;
    if (!employee_id) return sendJson(res, 400, { error: 'employee_id is required' });
    if (employee_id !== sessionUser.employeeId) {
      return sendJson(res, 403, { error: 'You can only manage your own breaks.' });
    }
    const employee = await getEmployee(employee_id);
    if (!employee) return sendJson(res, 404, { error: `Unknown employee_id: ${employee_id}` });

    const today = todayStr();
    const currentStatus = await computeDayStatus(employee_id, today);
    if (currentStatus.status !== 'Active') {
      return sendJson(res, 403, { error: 'You can only take a break while punched in.' });
    }

    const now = formatTimestamp(new Date());
    if (currentStatus.onBreak) {
      await db.prepare('UPDATE breaks SET end_ts = ? WHERE employee_id = ? AND end_ts IS NULL').run(now, employee_id);
    } else {
      await db.prepare('INSERT INTO breaks (employee_id, start_ts) VALUES (?, ?)').run(employee_id, now);
    }
    const dayStatus = await computeDayStatus(employee_id, today);
    return sendJson(res, 200, { employee_id, onBreak: dayStatus.onBreak, timestamp: now, dayStatus });
  }

  // GET /api/places/autocomplete?q= — type-ahead address suggestions (each carries lat/lon).
  if (parsed.pathname === '/api/places/autocomplete' && req.method === 'GET') {
    const sessionUser = await getSessionUser(req);
    if (!sessionUser) return sendJson(res, 401, { error: 'Unauthorized' });
    const q = (parsed.searchParams.get('q') || '').trim();
    if (q.length < 3) return sendJson(res, 200, { suggestions: [] });
    try {
      return sendJson(res, 200, { suggestions: await placesAutocomplete(q) });
    } catch (e) {
      return sendJson(res, 502, { error: e.message || 'Autocomplete failed.' });
    }
  }

  // POST /api/field-trip/distance { from, to, from_lat?, from_lon?, to_lat?, to_lon? } —
  // driving distance. A picked suggestion supplies its coords; otherwise the typed text is
  // forward-geocoded first. LocationIQ routing needs coordinates, so both ends resolve to
  // lat/lon before the directions call. The key stays server-side.
  if (parsed.pathname === '/api/field-trip/distance' && req.method === 'POST') {
    const sessionUser = await getSessionUser(req);
    if (!sessionUser) return sendJson(res, 401, { error: 'Unauthorized' });
    let body;
    try { body = await readJsonBody(req); } catch (err) { if (err && err.statusCode === 413) return sendJson(res, 413, { error: 'Request body too large' }); return sendJson(res, 400, { error: 'Invalid JSON body' }); }
    try {
      return sendJson(res, 200, await resolveTripDistance(body));
    } catch (e) {
      return sendJson(res, e.status || 502, { error: e.message || 'Could not calculate distance.' });
    }
  }

  // POST /api/field-trip/record { from, to, from_lat?, ... } — recompute the distance
  // server-side (so it can't be tampered with) and save the trip for the accounts team.
  if (parsed.pathname === '/api/field-trip/record' && req.method === 'POST') {
    const sessionUser = await getSessionUser(req);
    if (!sessionUser || !sessionUser.employeeId) return sendJson(res, 401, { error: 'Only an employee can record a field trip.' });
    let body;
    try { body = await readJsonBody(req); } catch (err) { if (err && err.statusCode === 413) return sendJson(res, 413, { error: 'Request body too large' }); return sendJson(res, 400, { error: 'Invalid JSON body' }); }
    try {
      const r = await resolveTripDistance(body);
      const now = formatTimestamp(new Date());
      await db.prepare(
        'INSERT INTO field_trips (employee_id, date, recorded_at, from_address, to_address, distance_km) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(sessionUser.employeeId, now.split(' ')[0], now, r.fromResolved, r.toResolved, r.distanceKm);
      return sendJson(res, 200, { recorded: true, ...r });
    } catch (e) {
      return sendJson(res, e.status || 502, { error: e.message || 'Could not record the trip.' });
    }
  }

  // --- ZKTeco ADMS push protocol (K40 Pro biometric device) ---
  // Configure the device's Menu > Comm > ADMS > Server URL/Port to point here; it
  // pushes attendance logs on its own schedule. These routes speak the device's
  // native protocol and translate each record into the same punches table
  // /api/punch uses, via the employees.device_pin mapping (see /admin/device-pins).
  if (parsed.pathname.startsWith('/iclock/')) {
    const sn = parsed.searchParams.get('SN') || '';
    // Fails closed: no configured serial means no device is connected yet, so every
    // push is rejected. See the ZK_DEVICE_SN setting.
    if (!CONFIG.ZK_DEVICE_SN || sn !== CONFIG.ZK_DEVICE_SN) {
      logSecurityEvent('adms_auth_failed', { ip: req.socket.remoteAddress, path: parsed.pathname, sn });
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('unauthorized device');
    }

    // Handshake: the device asks what to do on connect. Limit it to pushing
    // attendance logs only (no user/fingerprint sync) and keep it in plain batch
    // push mode — Realtime=1 puts some firmwares into a streaming mode this
    // adapter doesn't implement, so leave it off.
    if (parsed.pathname === '/iclock/cdata' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end([
        `GET OPTION FROM: ${sn}`,
        'Stamp=9999',
        'OpStamp=9999',
        'ErrorDelay=60',
        'Delay=30',
        'TransTables=ATTLOG',
        'Realtime=0',
        'Encrypt=0',
      ].join('\n'));
    }

    // Attendance log upload: plain text, one record per line, tab-separated
    // "<device PIN>\t<YYYY-MM-DD HH:MM:SS>\t...". Status/verify-method fields are
    // ignored — same in/out inference /api/punch falls back to when unspecified.
    if (parsed.pathname === '/iclock/cdata' && req.method === 'POST') {
      const table = parsed.searchParams.get('table') || '';
      const text = await readTextBody(req);
      let ingested = 0;
      let duplicates = 0;
      if (table === 'ATTLOG') {
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const [pin, timestamp] = trimmed.split('\t');
          if (!pin || !timestamp) continue;
          const employee = await getEmployeeByDevicePin(pin);
          if (!employee) {
            logSecurityEvent('adms_unmapped_pin', { pin, timestamp });
            continue;
          }
          const { inserted } = await ingestBiometricPunch(employee.id, correctDeviceTimestamp(timestamp));
          if (inserted) ingested++; else duplicates++;
        }
      }
      if (ingested > 0) console.log(`[adms] ingested ${ingested} punch(es) from device ${sn}`);
      // The device resends its unacknowledged log on every retry, so a batch
      // showing up again in full (all duplicates) is normal, not an error.
      if (duplicates > 0) console.log(`[adms] skipped ${duplicates} duplicate punch(es) from device ${sn}`);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK');
    }

    // Command polling — this adapter never queues device commands, so always "no-op".
    if (parsed.pathname === '/iclock/getrequest' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK');
    }

    // Command-execution acknowledgements — nothing to do with these since we never
    // issue commands, but ack with 200 rather than 404 so the device doesn't retry.
    if (parsed.pathname === '/iclock/devicecmd' && req.method === 'POST') {
      await readTextBody(req);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK');
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }

  if (parsed.pathname === '/api/employees' && req.method === 'GET') {
    return sendJson(res, 200, await db.prepare('SELECT * FROM employees').all());
  }

  // GET /api/attendance?employee_id=EMP-001&date=2026-07-28
  if (parsed.pathname === '/api/attendance' && req.method === 'GET') {
    const employee_id = parsed.searchParams.get('employee_id');
    const date = parsed.searchParams.get('date');
    if (!employee_id) return sendJson(res, 400, { error: 'employee_id is required' });
    const status = await computeDayStatus(employee_id, date || todayStr());
    if (!status) return sendJson(res, 404, { error: `Unknown employee_id: ${employee_id}` });
    return sendJson(res, 200, status);
  }

  if (parsed.pathname === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  // Auto-checkout endpoint for Vercel Cron (scheduled at 19:00 IST). In standalone
  // mode a setInterval handles this instead; here Cron POSTs/GETs this path with an
  // "Authorization: Bearer <CRON_SECRET>" header. Rejects anything without the secret
  // so it can't be triggered by the public internet.
  if (parsed.pathname === '/internal/auto-checkout') {
    const expected = process.env.CRON_SECRET;
    const provided = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!expected || provided !== expected) {
      logSecurityEvent('cron_auth_failed', { ip: req.socket && req.socket.remoteAddress });
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
    await performAutoCheckout();
    return sendJson(res, 200, { ok: true, ran: 'auto-checkout' });
  }

  // PWA static assets — unauthenticated on purpose: the browser fetches these
  // (manifest, service worker, icons) as part of install/registration, which can
  // happen from the login screen before any session exists.
  if (parsed.pathname === '/manifest.json' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
    return res.end(JSON.stringify(MANIFEST));
  }
  if (parsed.pathname === '/sw.js' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Service-Worker-Allowed': '/' });
    return res.end(SERVICE_WORKER_JS);
  }
  if (parsed.pathname === '/offline.html' && req.method === 'GET') {
    return sendHtml(res, OFFLINE_HTML);
  }
  if (parsed.pathname.startsWith('/icons/') && req.method === 'GET') {
    const file = parsed.pathname.slice('/icons/'.length);
    if (Object.hasOwn(ICON_FILES, file)) {
      res.writeHead(200, { 'Content-Type': ICON_FILES[file], 'Cache-Control': 'public, max-age=86400' });
      return res.end(iconBuffers[file]);
    }
    res.writeHead(404);
    return res.end();
  }

  if (parsed.pathname === '/login' && req.method === 'GET') {
    return sendHtml(res, renderLogin());
  }

  if (parsed.pathname === '/login' && req.method === 'POST') {
    const { username, password } = await readFormBody(req);
    const ip = req.socket.remoteAddress || 'unknown';

    if (await isLoginRateLimited(username || '', ip)) {
      logSecurityEvent('login_rate_limited', { username, ip });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderLogin('Too many attempts. Try again in a few minutes.'));
    }

    const account = await db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
    if (!account || !verifyPassword(password || '', account.password_hash)) {
      await recordLoginAttempt(username || '', ip, false);
      logSecurityEvent('login_failed', { username, ip });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderLogin('Incorrect username or password.'));
    }
    await recordLoginAttempt(username, ip, true);
    const token = await createSession(account);
    res.writeHead(302, {
      'Set-Cookie': `session=${token}; HttpOnly; Path=/; SameSite=Lax`,
      Location: account.must_change_password ? '/change-password' : '/',
    });
    return res.end();
  }

  if (parsed.pathname === '/logout' && req.method === 'GET') {
    const token = parseCookies(req).session;
    if (token) await deleteSession(token);
    res.writeHead(302, { 'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0', Location: '/login' });
    return res.end();
  }

  // --- Everything below requires a logged-in session ---
  const user = await getSessionUser(req);
  if (!user) {
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }
  // Seed accounts (and any account created with a known default password) must rotate
  // their password before doing anything else — enforced on every request, not just at
  // login, so navigating away from /change-password can't be used to skip it.
  if (await requiresPasswordChange(user.userId) && parsed.pathname !== '/change-password' && parsed.pathname !== '/logout') {
    res.writeHead(302, { Location: '/change-password' });
    return res.end();
  }

  if (parsed.pathname === '/change-password' && req.method === 'GET') {
    return sendHtml(res, renderChangePassword(null, user.username));
  }

  if (parsed.pathname === '/change-password' && req.method === 'POST') {
    const form = await readFormBody(req);
    const account = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.userId);
    if (!account || !verifyPassword(form.current_password || '', account.password_hash)) {
      return sendHtml(res, renderChangePassword('Current password is incorrect.', user.username));
    }
    if (!form.new_password || form.new_password.length < 8) {
      return sendHtml(res, renderChangePassword('New password must be at least 8 characters.', user.username));
    }
    if (form.new_password !== form.confirm_password) {
      return sendHtml(res, renderChangePassword('New password and confirmation do not match.', user.username));
    }
    await db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(hashPassword(form.new_password), user.userId);
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  if (parsed.pathname === '/settings/language' && req.method === 'POST') {
    if (user.role === 'employee') {
      const form = await readFormBody(req);
      const lang = form.lang === 'ta' ? 'ta' : 'en';
      await db.prepare('UPDATE users SET language = ? WHERE id = ?').run(lang, user.userId);
    }
    res.writeHead(302, { Location: (parsed.searchParams.get('return')) || '/dashboard' });
    return res.end();
  }

  // Employees are locked to their own employee_id, no matter what's in the URL.
  // Admins can pass employee_id to view/act on anyone (defaults to the first employee).
  async function resolveEmployeeId() {
    if (user.role === 'employee') return user.employeeId;
    const employees = await allEmployees();
    return parsed.searchParams.get('employee_id') || (employees[0] && employees[0].id);
  }

  if (parsed.pathname === '/' && req.method === 'GET') {
    res.writeHead(302, { Location: `/dashboard?employee_id=${encodeURIComponent(await resolveEmployeeId() || '')}` });
    return res.end();
  }

  if (parsed.pathname === '/dashboard' && req.method === 'GET') {
    if (user.role === 'admin') {
      const dateStr = parsed.searchParams.get('date') || todayStr();
      const rows = await Promise.all((await allEmployees()).map(async employee => ({ employee, status: await computeDayStatus(employee.id, dateStr) })));
      return sendHtml(res, await renderAdminAttendance(dateStr, rows, user, { basePath: '/dashboard', title: 'Dashboard', activeNav: 'dashboard', showStats: true }));
    }
    const employeeId = await resolveEmployeeId();
    const employee = await getEmployee(employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    const dayStatus = await computeDayStatus(employeeId, todayStr());
    const punches = await getPunchesForDay(employeeId, todayStr());
    const breaks = await getBreaksForDay(employeeId, todayStr());
    const overtimeMinutes = await computeOvertimeMinutes(employee, todayStr());
    const overtimeAuthorized = await isOvertimeAuthorized(employeeId, todayStr());
    const leaveBalances = await getLeaveBalanceDisplay(employeeId);
    return sendHtml(res, await renderDashboard(employee, dayStatus, punches, user, overtimeMinutes, overtimeAuthorized, leaveBalances, breaks));
  }

  if (parsed.pathname === '/calendar' && req.method === 'GET') {
    const employeeId = await resolveEmployeeId();
    const now = new Date();
    const year = Number(parsed.searchParams.get('year')) || now.getFullYear();
    const month = Number(parsed.searchParams.get('month')) || (now.getMonth() + 1);
    // Company Calendar shows holidays, which have nothing to do with any one employee —
    // it must render even before the first employee is ever registered, since setting up
    // holidays ahead of hiring is a reasonable thing for a fresh admin to do first. Check
    // this before the employee lookup below, which the personal calendar genuinely needs.
    if (parsed.searchParams.get('view') === 'company' && user.role === 'admin') {
      return sendHtml(res, await renderCompanyCalendar(year, month, employeeId, user));
    }
    const employee = await getEmployee(employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    return sendHtml(res, await renderCalendar(employee, year, month, user));
  }

  if (parsed.pathname === '/leave' && req.method === 'GET') {
    if (user.role === 'admin') {
      const rows = await Promise.all((await allEmployees()).map(async employee => ({ employee, balances: await getLeaveBalanceDisplay(employee.id) })));
      return sendHtml(res, await renderAdminLeave(await getAllLeaveRequests(), rows, user));
    }
    const employeeId = await resolveEmployeeId();
    const employee = await getEmployee(employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    return sendHtml(res, await renderLeave(employee, await getLeaveBalanceDisplay(employeeId), await getLeaveRequests(employeeId), user));
  }

  if (parsed.pathname === '/leave/apply' && req.method === 'POST') {
    // Leave applications can only be filed by the employee themselves — not by admin on their behalf.
    if (user.role !== 'employee') { res.writeHead(403); return res.end('Only an employee can apply for their own leave.'); }
    const employeeId = user.employeeId;
    const form = await readFormBody(req);
    const leaveType = form.leave_type;
    const startDate = form.start_date;
    const endDate = form.end_date;
    const reason = form.reason || '';
    const employee = await getEmployee(employeeId);
    if (!employee || !leaveType || !startDate || !endDate) {
      res.writeHead(400); return res.end('Missing required fields');
    }
    const duplicate = await db.prepare(
      `SELECT id FROM leave_requests WHERE employee_id = ? AND leave_type = ? AND status = 'pending'
       AND date(start_date) <= date(?) AND date(end_date) >= date(?)`
    ).get(employeeId, leaveType, endDate, startDate);
    if (duplicate) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await renderLeave(employee, await getLeaveBalanceDisplay(employeeId), await getLeaveRequests(employeeId), user, 'You already have a pending request for these dates.'));
    }
    await db.prepare(
      'INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, reason, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(employeeId, leaveType, startDate, endDate, reason, 'pending', formatTimestamp(new Date()));
    res.writeHead(302, { Location: `/leave?employee_id=${encodeURIComponent(employeeId)}` });
    return res.end();
  }

  if (parsed.pathname === '/leave/decide' && req.method === 'POST') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Only an admin can approve or reject leave.'); }
    const form = await readFormBody(req);
    const id = form.id;
    const action = form.action;
    const request = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
    if (!request) { res.writeHead(404); return res.end('Unknown leave request'); }

    if (action === 'approve') {
      await db.prepare("UPDATE leave_requests SET status = 'approved', decided_at = ? WHERE id = ?")
        .run(formatTimestamp(new Date()), id);
      // Casual/Sick no longer draw from a balance — see MONTHLY_PAID_LEAVE_TYPES.
      if (BALANCE_POOL_LEAVE_TYPES.includes(request.leave_type)) {
        const days = countLeaveDays(request.start_date, request.end_date);
        await db.prepare('UPDATE leave_balances SET balance = balance - ? WHERE employee_id = ? AND leave_type = ?')
          .run(days, request.employee_id, request.leave_type);
      }
      await createNotification(request.employee_id, `Your ${request.leave_type} request for ${request.start_date} to ${request.end_date} has been approved.`);
      await logAdminAction(user.username, 'approve', 'leave_request', id, `${request.employee_id}: ${request.leave_type} ${request.start_date}–${request.end_date}`);
    } else if (action === 'reject') {
      await db.prepare("UPDATE leave_requests SET status = 'rejected', decided_at = ? WHERE id = ?")
        .run(formatTimestamp(new Date()), id);
      await createNotification(request.employee_id, `Your ${request.leave_type} request for ${request.start_date} to ${request.end_date} has been rejected.`);
      await logAdminAction(user.username, 'reject', 'leave_request', id, `${request.employee_id}: ${request.leave_type} ${request.start_date}–${request.end_date}`);
    }
    res.writeHead(302, { Location: '/leave' });
    return res.end();
  }

  if (parsed.pathname === '/permission' && req.method === 'GET') {
    const now = new Date();
    if (user.role === 'admin') {
      const hoursReportRows = await Promise.all((await allEmployees()).map(async employee => ({
        employee,
        ...(await computeMonthlyPermissionSummary(employee.id, now.getFullYear(), now.getMonth() + 1)),
      })));
      return sendHtml(res, await renderAdminPermission(await getAllPermissionRequests(), hoursReportRows, user));
    }
    const employeeId = await resolveEmployeeId();
    const employee = await getEmployee(employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    const monthlySummary = await computeMonthlyPermissionSummary(employeeId, now.getFullYear(), now.getMonth() + 1);
    return sendHtml(res, await renderPermission(employee, await getPermissionRequests(employeeId), monthlySummary, user));
  }

  if (parsed.pathname === '/permission/apply' && req.method === 'POST') {
    // Permission requests can only be filed by the employee themselves — not by admin on their behalf.
    if (user.role !== 'employee') { res.writeHead(403); return res.end('Only an employee can apply for their own permission.'); }
    const employeeId = user.employeeId;
    const form = await readFormBody(req);
    const date = form.date;
    const leaveTime = form.leave_time;
    const reason = form.reason || '';
    if (!date || !leaveTime) {
      res.writeHead(400); return res.end('Missing required fields');
    }
    const employee = await getEmployee(employeeId);
    async function rejectWithError(message) {
      const now = new Date();
      const monthlySummary = await computeMonthlyPermissionSummary(employeeId, now.getFullYear(), now.getMonth() + 1);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await renderPermission(employee, await getPermissionRequests(employeeId), monthlySummary, user, message));
    }
    // Cuts off last-minute requests: today's permission must be filed with at least 30
    // minutes' notice before the shift starts, not scrambled in right beforehand.
    if (date === todayStr()) {
      const shift = getShiftForDate(employee, date);
      const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
      if (nowMinutes >= parseTimeToMinutes(shift.start) - 30) {
        return rejectWithError(`Too late to apply for today — permission requests must be submitted at least 30 minutes before your shift starts (${shift.start}).`);
      }
    }
    const duplicate = await db.prepare(
      "SELECT id FROM permission_requests WHERE employee_id = ? AND date = ? AND status = 'pending'"
    ).get(employeeId, date);
    if (duplicate) {
      return rejectWithError('You already have a pending request for this date.');
    }
    await db.prepare(
      'INSERT INTO permission_requests (employee_id, date, leave_time, reason, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(employeeId, date, leaveTime, reason, 'pending', formatTimestamp(new Date()));
    res.writeHead(302, { Location: `/permission?employee_id=${encodeURIComponent(employeeId)}` });
    return res.end();
  }

  if (parsed.pathname === '/permission/decide' && req.method === 'POST') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Only an admin can approve or reject permission requests.'); }
    const form = await readFormBody(req);
    const id = form.id;
    const action = form.action;
    const request = await db.prepare('SELECT * FROM permission_requests WHERE id = ?').get(id);
    if (!request) { res.writeHead(404); return res.end('Unknown permission request'); }

    if (action === 'approve') {
      await db.prepare("UPDATE permission_requests SET status = 'approved', decided_at = ? WHERE id = ?")
        .run(formatTimestamp(new Date()), id);
      await createNotification(request.employee_id, `Your permission to leave at ${request.leave_time} on ${request.date} has been approved.`);
      await logAdminAction(user.username, 'approve', 'permission_request', id, `${request.employee_id}: leave at ${request.leave_time} on ${request.date}`);
    } else if (action === 'reject') {
      await db.prepare("UPDATE permission_requests SET status = 'rejected', decided_at = ? WHERE id = ?")
        .run(formatTimestamp(new Date()), id);
      await createNotification(request.employee_id, `Your permission to leave at ${request.leave_time} on ${request.date} has been rejected.`);
      await logAdminAction(user.username, 'reject', 'permission_request', id, `${request.employee_id}: leave at ${request.leave_time} on ${request.date}`);
    }
    res.writeHead(302, { Location: '/permission' });
    return res.end();
  }

  if (parsed.pathname === '/overtime' && req.method === 'GET') {
    if (user.role === 'admin') {
      const now = new Date();
      const hoursReportRows = await Promise.all((await allEmployees()).map(async employee => ({
        employee,
        ...(await computeMonthlyOvertimeSummary(employee, now.getFullYear(), now.getMonth() + 1)),
      })));
      return sendHtml(res, await renderAdminOvertime(await getAllOvertimeRequests(), hoursReportRows, user));
    }
    const employeeId = await resolveEmployeeId();
    const employee = await getEmployee(employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    const today = todayStr();
    const todayOvertimeMinutes = await computeOvertimeMinutes(employee, today);
    const todayAuthorized = await isOvertimeAuthorized(employeeId, today);
    return sendHtml(res, await renderOvertime(employee, await getOvertimeRequests(employeeId), todayOvertimeMinutes, todayAuthorized, user));
  }

  if (parsed.pathname === '/overtime/apply' && req.method === 'POST') {
    const isAdmin = user.role === 'admin';
    // Employees file their own requests, which need a separate admin approval. Admins can also
    // file on behalf of staff who can't (e.g. no phone) — that's recorded as already authorized,
    // skipping the approval step, since the admin is the one asserting it happened.
    if (!isAdmin && user.role !== 'employee') {
      res.writeHead(403); return res.end('Only an employee or admin can request overtime.');
    }
    const form = await readFormBody(req);
    const employeeId = isAdmin ? form.employee_id : user.employeeId;
    const date = form.date;
    const plannedHours = form.planned_hours;
    const reason = form.reason || '';
    if (!employeeId || !date || !plannedHours) {
      res.writeHead(400); return res.end('Missing required fields');
    }
    const employee = await getEmployee(employeeId);
    if (!employee) { res.writeHead(400); return res.end('Unknown employee'); }
    const duplicate = await db.prepare(
      "SELECT id FROM overtime_requests WHERE employee_id = ? AND date = ? AND status = 'pending'"
    ).get(employeeId, date);
    if (duplicate) {
      if (isAdmin) {
        const now = new Date();
        const hoursReportRows = await Promise.all((await allEmployees()).map(async e => ({
          employee: e,
          ...(await computeMonthlyOvertimeSummary(e, now.getFullYear(), now.getMonth() + 1)),
        })));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(await renderAdminOvertime(
          await getAllOvertimeRequests(), hoursReportRows, user,
          `${employee.name} already has a pending overtime request for this date.`
        ));
      }
      const today = todayStr();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await renderOvertime(
        employee, await getOvertimeRequests(employeeId),
        await computeOvertimeMinutes(employee, today), await isOvertimeAuthorized(employeeId, today),
        user, 'You already have a pending overtime request for this date.'
      ));
    }
    if (isAdmin) {
      const timestamp = formatTimestamp(new Date());
      await db.prepare(
        'INSERT INTO overtime_requests (employee_id, date, planned_hours, reason, status, requested_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(employeeId, date, Number(plannedHours), reason, 'approved', timestamp, timestamp);
      await logAdminAction(user.username, 'record', 'overtime_request', employeeId, `${employeeId}: ${date}, ${plannedHours}h planned (filed by admin, auto-approved)`);
      await createNotification(employeeId, `Your admin recorded ${plannedHours}h of overtime for you on ${date}.`);
      res.writeHead(302, { Location: '/overtime' });
      return res.end();
    }
    await db.prepare(
      'INSERT INTO overtime_requests (employee_id, date, planned_hours, reason, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(employeeId, date, Number(plannedHours), reason, 'pending', formatTimestamp(new Date()));
    res.writeHead(302, { Location: `/overtime?employee_id=${encodeURIComponent(employeeId)}` });
    return res.end();
  }

  if (parsed.pathname === '/overtime/decide' && req.method === 'POST') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Only an admin can approve or reject overtime requests.'); }
    const form = await readFormBody(req);
    const id = form.id;
    const action = form.action;
    const request = await db.prepare('SELECT * FROM overtime_requests WHERE id = ?').get(id);
    if (!request) { res.writeHead(404); return res.end('Unknown overtime request'); }

    if (action === 'approve') {
      await db.prepare("UPDATE overtime_requests SET status = 'approved', decided_at = ? WHERE id = ?")
        .run(formatTimestamp(new Date()), id);
      await createNotification(request.employee_id, `Your overtime request for ${request.date} has been approved.`);
      await logAdminAction(user.username, 'approve', 'overtime_request', id, `${request.employee_id}: ${request.date}, ${request.planned_hours}h planned`);
    } else if (action === 'reject') {
      await db.prepare("UPDATE overtime_requests SET status = 'rejected', decided_at = ? WHERE id = ?")
        .run(formatTimestamp(new Date()), id);
      await logAdminAction(user.username, 'reject', 'overtime_request', id, `${request.employee_id}: ${request.date}, ${request.planned_hours}h planned`);
      await createNotification(request.employee_id, `Your overtime request for ${request.date} has been rejected.`);
    }
    res.writeHead(302, { Location: '/overtime' });
    return res.end();
  }

  if (parsed.pathname === '/onsite' && req.method === 'GET') {
    if (user.role === 'admin') {
      const allPunches = await db.prepare(
        "SELECT * FROM punches WHERE source = 'on-site' ORDER BY timestamp DESC LIMIT 50"
      ).all();
      return sendHtml(res, await renderAdminOnsite(allPunches, user));
    }
    const employeeId = await resolveEmployeeId();
    const employee = await getEmployee(employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    const recentPunches = await db.prepare(
      "SELECT * FROM punches WHERE employee_id = ? AND source = 'on-site' ORDER BY timestamp DESC LIMIT 10"
    ).all(employeeId);
    return sendHtml(res, await renderOnsite(employee, recentPunches, user));
  }

  if (parsed.pathname === '/field-trip' && req.method === 'GET') {
    if (!CONFIG.LOCATIONIQ_API_KEY) { res.writeHead(404); return res.end('Not found'); }
    if (user.role === 'admin') {
      const trips = await db.prepare('SELECT * FROM field_trips ORDER BY id DESC LIMIT 200').all();
      return sendHtml(res, await renderAdminFieldTrips(trips, user));
    }
    const employeeId = user.employeeId;
    const trips = await db.prepare('SELECT * FROM field_trips WHERE employee_id = ? ORDER BY id DESC LIMIT 20').all(employeeId);
    return sendHtml(res, await renderFieldTrip(employeeId, trips, user));
  }

  if (parsed.pathname === '/field-trip/decide' && req.method === 'POST') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Only an admin can approve or reject field trips.'); }
    const form = await readFormBody(req);
    const id = form.id;
    const action = form.action;
    const trip = await db.prepare('SELECT * FROM field_trips WHERE id = ?').get(id);
    if (!trip) { res.writeHead(404); return res.end('Unknown field trip'); }

    if (action === 'approve') {
      await db.prepare("UPDATE field_trips SET status = 'approved', decided_at = ? WHERE id = ?")
        .run(formatTimestamp(new Date()), id);
      await createNotification(trip.employee_id, `Your field trip on ${trip.date} (${trip.from_address} → ${trip.to_address}) has been approved for reimbursement.`);
      await logAdminAction(user.username, 'approve', 'field_trip', id, `${trip.employee_id}: ${trip.date}, ${trip.distance_km}km`);
    } else if (action === 'reject') {
      await db.prepare("UPDATE field_trips SET status = 'rejected', decided_at = ? WHERE id = ?")
        .run(formatTimestamp(new Date()), id);
      await createNotification(trip.employee_id, `Your field trip on ${trip.date} (${trip.from_address} → ${trip.to_address}) was not approved for reimbursement.`);
      await logAdminAction(user.username, 'reject', 'field_trip', id, `${trip.employee_id}: ${trip.date}, ${trip.distance_km}km`);
    }
    res.writeHead(302, { Location: '/field-trip' });
    return res.end();
  }

  if (parsed.pathname === '/notifications' && req.method === 'GET') {
    if (user.role === 'admin') {
      // Admin is browsing everyone's notifications, not acknowledging their own —
      // must not mark other employees' notifications as read on their behalf.
      return sendHtml(res, await renderAdminNotifications(await getAllNotifications(), user));
    }
    const employeeId = await resolveEmployeeId();
    const employee = await getEmployee(employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    const notifications = await getNotifications(employeeId);
    await db.prepare('UPDATE notifications SET read = 1 WHERE employee_id = ?').run(employeeId);
    return sendHtml(res, await renderNotifications(employee, notifications, user));
  }

  // Retired — merged into /dashboard. Redirect so old links/bookmarks still land somewhere useful.
  if (parsed.pathname === '/admin/attendance' && req.method === 'GET') {
    const dateStr = parsed.searchParams.get('date');
    res.writeHead(302, { Location: dateStr ? `/dashboard?date=${encodeURIComponent(dateStr)}` : '/dashboard' });
    return res.end();
  }

  // Retired — merged into /leave. Redirect so old links/bookmarks still land somewhere useful.
  if (parsed.pathname === '/admin/leave' && req.method === 'GET') {
    res.writeHead(302, { Location: '/leave' });
    return res.end();
  }

  if (parsed.pathname === '/admin/toggle-onsite' && req.method === 'POST') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    const form = await readFormBody(req);
    const employeeId = form.employee_id;
    const dateStr = form.date || todayStr();
    const employee = await getEmployee(employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    const newState = employee.onsite_enabled ? 0 : 1;
    await db.prepare('UPDATE employees SET onsite_enabled = ? WHERE id = ?').run(newState, employeeId);
    await logAdminAction(user.username, newState ? 'enable' : 'disable', 'onsite_duty', employeeId, employee.name);
    const returnPath = form.return || '/dashboard';
    res.writeHead(302, { Location: `${returnPath}?date=${encodeURIComponent(dateStr)}` });
    return res.end();
  }

  // Retired path (renamed to the fuller Employee Registration form/tab) — redirect
  // so any old bookmark/link still lands somewhere useful.
  if (parsed.pathname === '/admin/add-employee' && req.method === 'GET') {
    res.writeHead(302, { Location: '/admin/employee-registration' });
    return res.end();
  }

  if (parsed.pathname === '/admin/employee-registration' && req.method === 'GET') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    return sendHtml(res, await renderEmployeeRegistration(user));
  }

  if (parsed.pathname === '/admin/employee-registration' && req.method === 'POST') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    const form = await readFormBody(req);
    const name = (form.name || '').trim();
    const role = (form.role || '').trim();
    const designation = (form.designation || '').trim();
    const branch = (form.branch || '').trim();
    const reportsTo = (form.reports_to || '').trim();
    const shiftStart = (form.shift_start || '').trim();
    const shiftEnd = (form.shift_end || '').trim();
    const dateJoined = (form.date_joined || '').trim();
    if (!name || !shiftStart || !shiftEnd || !dateJoined) {
      return sendHtml(res, await renderEmployeeRegistration(user, 'Name, shift start, shift end, and date joined are all required.'));
    }
    if (role && !EMPLOYMENT_TYPES.includes(role)) {
      return sendHtml(res, await renderEmployeeRegistration(user, 'Unknown role.'));
    }
    if (branch && !BRANCHES.includes(branch)) {
      return sendHtml(res, await renderEmployeeRegistration(user, 'Unknown branch.'));
    }
    if (reportsTo && !(await getEmployee(reportsTo))) {
      return sendHtml(res, await renderEmployeeRegistration(user, 'Unknown "reports to" employee.'));
    }
    const id = await nextEmployeeId();
    await db.prepare(
      'INSERT INTO employees (id, name, shift_start, shift_end, date_joined, role, designation, branch, reports_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, shiftStart, shiftEnd, dateJoined, role || null, designation || null, branch || null, reportsTo || null);
    for (const type of BALANCE_POOL_LEAVE_TYPES) {
      await db.prepare('INSERT INTO leave_balances (employee_id, leave_type, balance) VALUES (?, ?, ?)').run(id, type, DEFAULT_LEAVE_BALANCE[type]);
    }
    await db.prepare('INSERT INTO users (username, password_hash, role, employee_id, must_change_password) VALUES (?, ?, ?, ?, 1)').run(id, hashPassword('password123'), 'employee', id);
    await logAdminAction(user.username, 'add_employee', 'employee', id, name);
    res.writeHead(302, { Location: `/dashboard?employee_id=${encodeURIComponent(id)}` });
    return res.end();
  }

  if (parsed.pathname === '/admin/employee/edit' && req.method === 'GET') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    const employee = await getEmployee(parsed.searchParams.get('employee_id'));
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    return sendHtml(res, await renderEditEmployee(employee, user));
  }

  if (parsed.pathname === '/admin/employee/edit' && req.method === 'POST') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    const form = await readFormBody(req);
    const employeeId = form.employee_id;
    const employee = await getEmployee(employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    const name = (form.name || '').trim();
    const role = (form.role || '').trim();
    const designation = (form.designation || '').trim();
    const branch = (form.branch || '').trim();
    const reportsTo = (form.reports_to || '').trim();
    const shiftStart = (form.shift_start || '').trim();
    const shiftEnd = (form.shift_end || '').trim();
    const dateJoined = (form.date_joined || '').trim();
    if (!name || !shiftStart || !shiftEnd || !dateJoined) {
      return sendHtml(res, await renderEditEmployee(employee, user, 'Name, shift start, shift end, and date joined are all required.'));
    }
    if (role && !EMPLOYMENT_TYPES.includes(role)) {
      return sendHtml(res, await renderEditEmployee(employee, user, 'Unknown role.'));
    }
    if (branch && !BRANCHES.includes(branch)) {
      return sendHtml(res, await renderEditEmployee(employee, user, 'Unknown branch.'));
    }
    if (reportsTo === employeeId) {
      return sendHtml(res, await renderEditEmployee(employee, user, 'An employee cannot report to themselves.'));
    }
    if (reportsTo && !(await getEmployee(reportsTo))) {
      return sendHtml(res, await renderEditEmployee(employee, user, 'Unknown "reports to" employee.'));
    }
    await db.prepare(
      'UPDATE employees SET name = ?, shift_start = ?, shift_end = ?, date_joined = ?, role = ?, designation = ?, branch = ?, reports_to = ? WHERE id = ?'
    ).run(name, shiftStart, shiftEnd, dateJoined, role || null, designation || null, branch || null, reportsTo || null, employeeId);
    await logAdminAction(user.username, 'edit_employee', 'employee', employeeId, name);
    res.writeHead(302, { Location: '/admin/employee-registration' });
    return res.end();
  }

  // Retired — holidays now live under the Calendar tab's "Company Calendar" view.
  // Redirect so any old bookmark/link still lands somewhere useful.
  if (parsed.pathname === '/admin/holidays' && req.method === 'GET') {
    res.writeHead(302, { Location: '/calendar?view=company' });
    return res.end();
  }

  if (parsed.pathname === '/admin/holidays/add' && req.method === 'POST') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    const form = await readFormBody(req);
    const date = (form.date || '').trim();
    const name = (form.name || '').trim();
    const employeeId = form.employee_id || '';
    const now = new Date();
    const contextYear = date.slice(0, 4) || String(now.getFullYear());
    const contextMonth = Number(date.slice(5, 7)) || (now.getMonth() + 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !name) {
      return sendHtml(res, await renderCompanyCalendar(Number(contextYear), contextMonth, employeeId, user, 'A valid date and a name are both required.'));
    }
    const existing = await db.prepare('SELECT 1 FROM holidays WHERE date = ?').get(date);
    if (existing) {
      return sendHtml(res, await renderCompanyCalendar(Number(contextYear), contextMonth, employeeId, user, `A holiday is already recorded on ${date}.`));
    }
    await db.prepare('INSERT INTO holidays (date, name) VALUES (?, ?)').run(date, name);
    await logAdminAction(user.username, 'add_holiday', 'holiday', date, name);
    res.writeHead(302, { Location: `/calendar?view=company&year=${contextYear}&month=${contextMonth}&employee_id=${encodeURIComponent(employeeId)}` });
    return res.end();
  }

  if (parsed.pathname === '/admin/holidays/delete' && req.method === 'POST') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    const form = await readFormBody(req);
    const date = (form.date || '').trim();
    const returnYear = form.return_year || new Date().getFullYear();
    const returnMonth = form.return_month || (new Date().getMonth() + 1);
    const employeeId = form.employee_id || '';
    await db.prepare('DELETE FROM holidays WHERE date = ?').run(date);
    await logAdminAction(user.username, 'delete_holiday', 'holiday', date, '');
    res.writeHead(302, { Location: `/calendar?view=company&year=${returnYear}&month=${returnMonth}&employee_id=${encodeURIComponent(employeeId)}` });
    return res.end();
  }

  if (parsed.pathname === '/admin/reports' && req.method === 'GET') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    const { year, month, monthStr } = parseMonthParam(parsed);
    const [statusGrid, leaveRows] = await Promise.all([computeMonthlyStatusGrid(year, month), computeLeaveReport(year, month)]);
    const punchInRows = computePunchInReport(statusGrid);
    const punchInGrid = computePunchInGrid(statusGrid);
    const muster = computeMusterReport(statusGrid);
    return sendHtml(res, await renderReports(monthStr, punchInRows, punchInGrid, leaveRows, muster, user));
  }

  if (parsed.pathname === '/admin/reports/punch-in.csv' && req.method === 'GET') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    const { year, month, monthStr } = parseMonthParam(parsed);
    const rows = computePunchInReport(await computeMonthlyStatusGrid(year, month));
    const csv = toCsv(
      ['Employee ID', 'Name', 'Present', 'Late', 'Half Day', 'Absent', 'Total Hours Worked', 'Overtime Hours'],
      rows.map(r => [r.id, r.name, r.present, r.late, r.halfDay, r.absent, r.totalHours, r.overtimeHours])
    );
    await logAdminAction(user.username, 'download_report', 'punch_in_report', monthStr, '');
    return sendCsv(res, `punch-in-report-${monthStr}.csv`, csv);
  }

  if (parsed.pathname === '/admin/reports/punch-in-detail.csv' && req.method === 'GET') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    const { year, month, monthStr } = parseMonthParam(parsed);
    const grid = computePunchInGrid(await computeMonthlyStatusGrid(year, month));
    const dayHeaders = Array.from({ length: grid.daysInMonth }, (_, i) => String(i + 1));
    const csv = toCsv(
      ['Employee ID', 'Name', ...dayHeaders],
      grid.rows.map(r => [r.id, r.name, ...r.cells.map(c => c.text)])
    );
    await logAdminAction(user.username, 'download_report', 'punch_in_detail_report', monthStr, '');
    return sendCsv(res, `punch-in-detail-${monthStr}.csv`, csv);
  }

  if (parsed.pathname === '/admin/reports/leave.csv' && req.method === 'GET') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    const { year, month, monthStr } = parseMonthParam(parsed);
    const rows = await computeLeaveReport(year, month);
    const csv = toCsv(
      ['Employee ID', 'Name', ...LEAVE_TYPES, 'Total Days', 'Unpaid Days'],
      rows.map(r => [r.id, r.name, ...LEAVE_TYPES.map(t => r.perType[t] || 0), r.totalDays, r.unpaidDays])
    );
    await logAdminAction(user.username, 'download_report', 'leave_report', monthStr, '');
    return sendCsv(res, `leave-report-${monthStr}.csv`, csv);
  }

  if (parsed.pathname === '/admin/reports/muster.csv' && req.method === 'GET') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    const { year, month, monthStr } = parseMonthParam(parsed);
    const muster = computeMusterReport(await computeMonthlyStatusGrid(year, month));
    const dayHeaders = Array.from({ length: muster.daysInMonth }, (_, i) => String(i + 1));
    const csv = toCsv(
      ['Employee ID', 'Name', ...dayHeaders, 'Present Days'],
      [
        ...muster.rows.map(r => [r.id, r.name, ...r.cells.map(c => c.code), r.presentDays]),
        ['', 'Present Count', ...muster.dailyPresentCounts, ''],
      ]
    );
    await logAdminAction(user.username, 'download_report', 'muster_report', monthStr, '');
    return sendCsv(res, `muster-report-${monthStr}.csv`, csv);
  }

  if (parsed.pathname === '/admin/settings' && req.method === 'GET') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    return sendHtml(res, await renderAdminSettings(user));
  }

  if (parsed.pathname === '/admin/settings' && req.method === 'POST') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    const form = await readFormBody(req);
    const changed = [];
    for (const def of SETTING_DEFS) {
      const submitted = form[def.key];
      const clearing = form[`__clear__${def.key}`] === '1';
      // A field absent from the submission entirely is left alone. The real form always
      // posts every field, so an empty string still means "clear this"; but a partial or
      // truncated POST must not silently wipe settings it never mentioned — clearing
      // DEVICE_CLOCK_OFFSET_MINUTES that way would restore its 150-minute fallback and
      // quietly shift every device punch by two and a half hours.
      if (submitted === undefined && !clearing) continue;
      // A blank secret means "leave it alone" (the field is never pre-filled, so an
      // admin editing something else would otherwise erase every key on the page).
      // Clearing a secret is the explicit checkbox instead.
      if (def.secret && !clearing && submitted === '') continue;
      const value = clearing ? '' : String(submitted === undefined ? '' : submitted).trim();
      if (value === '') {
        const existing = await db.prepare('SELECT key FROM app_settings WHERE key = ?').get(def.key);
        if (!existing) continue;
        await db.prepare('DELETE FROM app_settings WHERE key = ?').run(def.key);
        changed.push(`${def.key} cleared`);
        continue;
      }
      const existing = await db.prepare('SELECT value FROM app_settings WHERE key = ?').get(def.key);
      if (existing && existing.value === value) continue;
      await db.prepare(
        'INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
      ).run(def.key, value, formatTimestamp(new Date()), user.username);
      changed.push(`${def.key} updated`);
    }
    if (changed.length) {
      // Deliberately records which settings changed, never the values — the audit log
      // is readable in-app and two of these are credentials.
      await logAdminAction(user.username, 'settings_updated', 'app_settings', 'settings', changed.join(', '));
    }
    await loadSettings({ force: true });
    return sendHtml(res, await renderAdminSettings(user, {
      notice: changed.length ? `Saved: ${changed.join(', ')}.` : 'No changes to save.',
    }));
  }

  if (parsed.pathname === '/admin/settings/generate-punch-key' && req.method === 'POST') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    const key = crypto.randomBytes(24).toString('hex');
    await db.prepare(
      'INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
    ).run('PUNCH_API_KEY', key, formatTimestamp(new Date()), user.username);
    await logAdminAction(user.username, 'punch_api_key_generated', 'app_settings', 'PUNCH_API_KEY', '');
    await loadSettings({ force: true });
    // Shown once, in the response to the request that created it — the stored value is
    // never rendered again, so this is the only chance to copy it into the device.
    return sendHtml(res, await renderAdminSettings(user, {
      revealedKey: 'PUNCH_API_KEY',
      revealedValue: key,
      notice: 'A new punch API key is saved and in effect. Any device still sending the old key will now be rejected.',
    }));
  }

  if (parsed.pathname === '/admin/device-pins' && req.method === 'GET') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    return sendHtml(res, await renderDevicePins(user));
  }

  if (parsed.pathname === '/admin/set-device-pin' && req.method === 'POST') {
    if (user.role !== 'admin') { res.writeHead(403); return res.end('Admin access only.'); }
    const form = await readFormBody(req);
    const employeeId = form.employee_id;
    const employee = await getEmployee(employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    const pin = (form.device_pin || '').trim();
    if (pin) {
      const existing = await getEmployeeByDevicePin(pin);
      if (existing && existing.id !== employeeId) {
        return sendHtml(res, await renderDevicePins(user, `PIN "${pin}" is already assigned to ${existing.name} (${existing.id}).`));
      }
    }
    await db.prepare('UPDATE employees SET device_pin = ? WHERE id = ?').run(pin || null, employeeId);
    await logAdminAction(user.username, 'set_device_pin', 'employee', employeeId, pin || '(cleared)');
    res.writeHead(302, { Location: '/admin/device-pins' });
    return res.end();
  }

  sendJson(res, 404, { error: 'Not found' });
}

// The request pipeline: log, route, and turn any unhandled throw into a clean 500.
// Shared by the standalone HTTP server (local dev / Windows NSSM) and the Vercel
// serverless function (see api/index.js).
async function serve(req, res) {
  console.log(`[inbound] ${req.method} ${req.url} from ${req.socket && req.socket.remoteAddress}`);
  // Internal staff tool on a public hostname — nothing here should ever appear in a
  // search result. Set once here rather than per-route: Node merges headers set this
  // way with any later writeHead(status, {...}), and no route sets X-Robots-Tag itself.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, nosnippet, noarchive, noimageindex');
  // Refresh admin-editable settings before routing. Cached (SETTINGS_CACHE_TTL_MS) so
  // this is not a query per request, and it swallows its own errors, so a settings
  // outage degrades to environment defaults rather than failing the request.
  await loadSettings();
  warnAboutUnsetSettings();
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error(`[error] ${req.method} ${req.url}:`, err);
    logSecurityEvent('unhandled_error', { method: req.method, url: req.url, message: err && err.message });
    if (res.headersSent) {
      // A route already started writing a response (e.g. a redirect) before failing
      // later — we can't send a second response, so just end the connection cleanly.
      res.destroy();
      return;
    }
    // Safety net for the many readFormBody()/readTextBody() call sites that don't
    // locally catch — an oversized body should surface as 413, not a generic 500.
    if (err && err.statusCode === 413) {
      return sendJson(res, 413, { error: 'Request body too large' });
    }
    if (req.url && req.url.startsWith('/api/')) {
      sendJson(res, 500, { error: 'Something went wrong' });
    } else {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="font-family:-apple-system,sans-serif;padding:40px;"><h2>Something went wrong</h2><p>Please try again, or contact your admin if this keeps happening.</p></body></html>');
    }
  }
}

// init() is idempotent (CREATE TABLE IF NOT EXISTS, seed only when empty), but we
// still memoize it so each serverless cold start runs it at most once, and every
// request waits for it before touching the DB.
let _initPromise = null;
function ensureInit() {
  if (!_initPromise) _initPromise = init();
  return _initPromise;
}

// Default export is a serverless request handler (ensure init, then serve), so a
// platform that loads this file directly as a function gets a valid handler — not
// an object, which fails with "the default export must be a function or server".
// The named helpers are attached as properties for the standalone entry (below)
// and api/index.js.
async function handler(req, res) {
  await ensureInit();
  await serve(req, res);
}
module.exports = handler;
module.exports.serve = serve;
module.exports.handleRequest = handleRequest;
module.exports.ensureInit = ensureInit;
module.exports.init = init;

// Standalone mode: only when run directly (`node server.js`) — local dev and the
// Windows NSSM service. On Vercel this file is imported, so this block is skipped
// and there's no long-lived process, listener, or setInterval.
if (require.main === module) {
  init().then(() => {
    checkAndRunAutoCheckout(); // catch up if the server started after 7pm (fire-and-forget)
    setInterval(checkAndRunAutoCheckout, 60 * 1000);
    http.createServer(serve).listen(PORT, '0.0.0.0', () => {
      console.log(`Attendance gateway running at http://localhost:${PORT}`);
    });
  }).catch((err) => {
    console.error('Startup failed during init():', err);
    process.exit(1);
  });
}
