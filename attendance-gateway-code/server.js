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
  effectivePunches, CORRECTION_MONTHLY_LIMIT, FULL_DAY_CORRECTION_MONTHLY_LIMIT, correctionOverLimit,
} = require('./attendance-logic');
const { t } = require('./i18n');
const {
  DEVICE_OFFLINE_MINUTES, DEVICE_COMMAND_TIMEOUT_MINUTES, RESYNC_OVERLAP_MINUTES,
  shiftTs, minutesSince, formatDuration, isDeviceOffline, shouldShowOfflineAlert,
  parseAttlogLine, parseDeviceCmdAcks, buildAttlogQuery,
} = require('./device-sync');
const ONBOARDING = require('./onboarding-content');

// Two roles have full run of the app — 'admin' and 'manager' are deliberately
// equivalent everywhere, including settings and password resets. The only
// meaningful distinction anywhere in this app is "management" vs. "employee";
// nothing currently depends on telling admin and manager apart from each other.
// Kept as a function (not a Set.has check inlined everywhere) so that if a
// narrower manager role is ever wanted, there is exactly one place to change it.
function isManagementRole(user) {
  return !!user && (user.role === 'admin' || user.role === 'manager');
}

// Only employee accounts can be in Tamil — management pages always render in
// English, regardless of what's stored in users.language (the toggle never shows
// for admin/manager, so that column stays 'en' for them in practice anyway).
function langOf(user) {
  return (user && !isManagementRole(user) && user.language === 'ta') ? 'ta' : 'en';
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

// Android/Chrome's own installability signal (`beforeinstallprompt`) drives a mini
// infobar that's easy to miss and, per Chrome's own engagement heuristics, may not
// fire on a first visit at all — captured here instead and re-shown as an
// app-styled sheet with an explicit Install button. Present everywhere PWA_HEAD_TAGS
// is, including the login page, since that's the first thing an employee sees when
// they follow the link — same reasoning as IOS_INSTALL_SHEET_HTML above, just for
// the other platform (iOS never fires this event, so the two sheets never overlap).
const ANDROID_INSTALL_SHEET_HTML = `<div id="androidInstallSheet" style="display:none;position:fixed;left:0;right:0;bottom:0;max-width:480px;margin:0 auto;background:#fff;border-radius:20px 20px 0 0;box-shadow:0 -10px 28px rgba(15,20,25,0.16);padding:18px 20px calc(24px + env(safe-area-inset-bottom));box-sizing:border-box;z-index:1000;">
      <div style="display:flex;align-items:center;gap:12px;">
        <img src="/icons/icon-192.png" width="44" height="44" style="border-radius:11px;flex-shrink:0;">
        <div>
          <div style="font-weight:700;font-size:15px;color:#1B2430;">Install Attendance Gateway</div>
          <div style="font-size:12px;color:#7C8896;margin-top:1px;">Add it to your Home Screen for quick, full-screen access.</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button type="button" onclick="dismissAndroidInstallSheet()" style="flex:1;padding:10px 0;border-radius:8px;border:none;background:transparent;color:#7C8896;font-weight:600;font-size:13px;cursor:pointer;">Not now</button>
        <button type="button" onclick="installAndroidApp()" style="flex:2;padding:10px 0;border-radius:8px;border:none;background:#1565C0;color:#fff;font-weight:700;font-size:13px;cursor:pointer;">Install</button>
      </div>
    </div>
    <script>
      let deferredInstallPrompt = null;
      function dismissAndroidInstallSheet() {
        const el = document.getElementById('androidInstallSheet');
        if (el) el.style.display = 'none';
        try { localStorage.setItem('androidInstallSheetDismissed', '1'); } catch (e) {}
      }
      function installAndroidApp() {
        const el = document.getElementById('androidInstallSheet');
        if (el) el.style.display = 'none';
        if (!deferredInstallPrompt) return;
        const promptEvent = deferredInstallPrompt;
        deferredInstallPrompt = null;
        promptEvent.prompt();
      }
      // First login lands on the language picker, then the welcome sheet and
      // tour — all of which are the same bottom-sheet shape as this one. Two
      // sheets stacked on an employee's very first screen reads as clutter and
      // competes for the tap, so wait the install offer out: poll (fixed-position
      // overlays are removed or display:none'd, never unmounted on a timer we can
      // hook) and show it once nothing else is on screen.
      const ONBOARDING_OVERLAY_IDS = ['onbLangPick', 'onbWelcome', 'onbWhatsNew', 'onbSpot', 'onbCard'];
      function onboardingVisible() {
        return ONBOARDING_OVERLAY_IDS.some((id) => {
          const el = document.getElementById(id);
          return el && getComputedStyle(el).display !== 'none';
        });
      }
      function showAndroidInstallSheet() {
        const el = document.getElementById('androidInstallSheet');
        if (el) el.style.display = 'block';
      }
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        try {
          if (localStorage.getItem('androidInstallSheetDismissed')) return;
        } catch (e2) {}
        if (!onboardingVisible()) { showAndroidInstallSheet(); return; }
        const waitForOnboarding = setInterval(() => {
          if (onboardingVisible()) return;
          clearInterval(waitForOnboarding);
          try {
            if (localStorage.getItem('androidInstallSheetDismissed')) return;
          } catch (e3) {}
          showAndroidInstallSheet();
        }, 800);
      });
      // Covers the manual-install path too (Chrome's own menu > "Install app"),
      // not just our button — either way, don't ask again once it's installed.
      window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        try { localStorage.setItem('androidInstallSheetDismissed', '1'); } catch (e) {}
      });
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
    help: "Comma-separated. A punch from the Punch button counts as in the office only when the employee's public IP matches one of these — there is no browser API for reading the WiFi SSID, so this is how a web app can tell \"on the office network\". Any other punch is recorded as remote, with the phone's location. Leave empty and every Punch-button punch is remote. Add every ISP if the office has more than one.",
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
    help: 'Powers the field-trip address type-ahead, road distance, and turning remote punch coordinates into addresses. While empty the Field Trips tab is hidden entirely. Nothing else depends on it.',
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
  {
    key: 'BRANCHES',
    label: 'Branches / locations',
    help: 'Comma-separated, in the order they should appear. These are the options offered on the Branch dropdown in Employee Registration and Edit Employee. Renaming or removing one here does not change what is already saved against an existing employee — see the Edit Employee form for that.',
    fallback: 'Branch 1,Branch 2,Branch 3',
    parse: (raw) => String(raw).split(',').map(x => x.trim()).filter(Boolean),
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
    console.warn('OFFICE_WIFI_IPS is not configured: every Punch-button punch is recorded as remote. Set the office public IP at /admin/settings.');
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
// No browser API exposes the WiFi SSID, so "on the office network" means the caller's
// public IP is one of the configured office IPs.
function isOnOfficeWifi(req) {
  return CONFIG.OFFICE_WIFI_IPS.has(getClientIp(req));
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
    employee_id TEXT,
    onboarding_seen_version INTEGER NOT NULL DEFAULT 0,
    language_set INTEGER NOT NULL DEFAULT 0
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
  CREATE TABLE IF NOT EXISTS correction_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    check_in_time TEXT,
    check_out_time TEXT,
    reason TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT
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
  CREATE TABLE IF NOT EXISTS device_status (
    sn TEXT PRIMARY KEY,
    last_seen TEXT NOT NULL,
    last_outage_start TEXT,
    last_outage_end TEXT,
    auto_checkout_held INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS device_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sn TEXT NOT NULL,
    command TEXT NOT NULL,
    range_start TEXT NOT NULL,
    range_end TEXT NOT NULL,
    reason TEXT NOT NULL,
    requested_by TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    return_code TEXT,
    punches_received INTEGER NOT NULL DEFAULT 0,
    punches_new INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    done_at TEXT
  );
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
  -- Every one of these tables is filtered by employee_id (almost always together with
  -- a date/timestamp range or a status) on hot paths: the dashboard, reports, and every
  -- approval list. Without these, each such query is a full table scan against a
  -- remote DB (Turso) — a network round trip is expensive enough on its own; doing it
  -- against an unindexed scan multiplies the cost as the tables grow.
  CREATE INDEX IF NOT EXISTS idx_punches_emp_ts ON punches(employee_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_breaks_emp_ts ON breaks(employee_id, start_ts);
  CREATE INDEX IF NOT EXISTS idx_notifications_emp_read ON notifications(employee_id, read);
  CREATE INDEX IF NOT EXISTS idx_leave_requests_emp_status ON leave_requests(employee_id, status);
  CREATE INDEX IF NOT EXISTS idx_permission_requests_emp_status ON permission_requests(employee_id, status);
  CREATE INDEX IF NOT EXISTS idx_overtime_requests_emp_status ON overtime_requests(employee_id, status);
  CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup ON login_attempts(username, ip, attempted_at);
  -- Optional employee paperwork (photo, ID proofs, resume, certificates). Multiple
  -- rows per (employee_id, doc_type) are allowed on purpose — education_certificate
  -- and other are naturally many-per-employee, and re-uploading a photo/ID keeps the
  -- old row rather than overwriting it, so nothing already stored is silently lost.
  -- The UI decides per type whether to show "latest only" (photo, aadhaar, pan,
  -- resume) or "all of them" (education_certificate, other).
  CREATE TABLE IF NOT EXISTS employee_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    data BLOB NOT NULL,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_employee_documents_emp ON employee_documents(employee_id, doc_type);
`;

const {
  getEmployee, getPunchesForDay, getBreaksForDay, getShiftForDate, getHoliday,
  getApprovedLeaveForDate, getApprovedPermissionForDate, getActiveCorrectionsForMonth, computeDayStatus,
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
  // No longer read: anyone can punch from outside the office now (as 'remote'). Kept
  // so older databases still match the schema.
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
  // Existing employees (registered before this column existed) will have mobile = NULL —
  // required going forward on the registration/edit forms, but not backfilled.
  try { await db.exec('ALTER TABLE employees ADD COLUMN mobile TEXT'); } catch { /* already exists */ }
  // Optional, unlike mobile — left NULL for anyone who doesn't have one on file.
  try { await db.exec('ALTER TABLE employees ADD COLUMN email TEXT'); } catch { /* already exists */ }
  // Employee-chosen UI language (English/Tamil) — admin accounts never set this away
  // from the default, since the toggle only renders for role 'employee'.
  try { await db.exec("ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en'"); } catch { /* already exists */ }
  // Onboarding tour version this employee has already seen (0 = never onboarded).
  // Every account that existed before this column shipped has, by definition,
  // already learned the app some other way — backfill them straight to
  // CURRENT_VERSION so the welcome tour only fires for accounts created after this.
  try {
    await db.exec('ALTER TABLE users ADD COLUMN onboarding_seen_version INTEGER NOT NULL DEFAULT 0');
    await db.exec(`UPDATE users SET onboarding_seen_version = ${ONBOARDING.CURRENT_VERSION}`);
  } catch { /* already exists */ }
  // Whether this account has ever explicitly chosen a language (via the onboarding
  // language screen or the sidebar toggle), as opposed to just sitting on the
  // column's 'en' default. Gates the onboarding language-choice screen — an
  // account that's never onboarded but also never picked a language sees it;
  // everyone else (including every pre-existing account, backfilled here) doesn't.
  try {
    await db.exec('ALTER TABLE users ADD COLUMN language_set INTEGER NOT NULL DEFAULT 0');
    await db.exec('UPDATE users SET language_set = 1');
  } catch { /* already exists */ }
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
  // covers a fixed multi-year range rather than just the current year. One multi-row
  // insert instead of 21 separate round trips — this runs on every cold start.
  const nationalHolidayRows = [];
  const nationalHolidayArgs = [];
  for (let year = 2024; year <= 2030; year++) {
    nationalHolidayRows.push('(?, ?)', '(?, ?)', '(?, ?)');
    nationalHolidayArgs.push(
      `${year}-01-26`, 'Republic Day',
      `${year}-08-15`, 'Independence Day',
      `${year}-10-02`, 'Gandhi Jayanti',
    );
  }
  await db.prepare(`INSERT OR IGNORE INTO holidays (date, name) VALUES ${nationalHolidayRows.join(', ')}`).run(...nationalHolidayArgs);

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
// In/out for a punch whose caller didn't say which. Counts only that day's real punches
// before this one, so every day starts with 'in' — the old "flip the last punch ever"
// rule let a stray evening punch turn the next morning's check-in into an 'out'. Auto-
// checkouts are skipped for the same reason computeDayStatus skips them (see
// effectivePunches): a late-arriving real check-out shouldn't be labelled 'in' just
// because the 19:00 auto-checkout got recorded first.
async function inferPunchDirection(employeeId, timestamp) {
  const earlierReal = (await getPunchesForDay(employeeId, timestamp.slice(0, 10)))
    .filter(p => p.source !== 'auto' && p.timestamp < timestamp);
  return earlierReal.length % 2 === 0 ? 'in' : 'out';
}
// A retried device push or a double-tapped Punch button can submit the same
// punch twice; treat two punches for the same employee within a few seconds of
// each other as one event rather than two. Deliberately ignores direction: when
// the caller doesn't specify one (the ADMS device path), it's inferred from
// that day's earlier punches — so a retry landing after the first
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
// --- Biometric device outages (office PC or internet down) ---
// The device keeps every punch in its own memory while it can't reach the app. These
// track when it was last heard from, so an outage is visible, the device is asked to
// resend that period once it's back, and the 19:00 auto-checkout waits for it.
async function getDeviceStatus(sn) {
  return await db.prepare('SELECT * FROM device_status WHERE sn = ?').get(sn);
}
// Queues a "send me your punches for this period again" command, picked up on the
// device's next /iclock/getrequest poll. Times are app time; the command carries the
// device's own clock (see DEVICE_CLOCK_OFFSET_MINUTES).
async function queueDeviceResync(sn, startTs, endTs, reason, requestedBy = null) {
  const offset = CONFIG.DEVICE_CLOCK_OFFSET_MINUTES;
  const command = buildAttlogQuery(shiftTs(startTs, offset), shiftTs(endTs, offset));
  await db.prepare(
    'INSERT INTO device_commands (sn, command, range_start, range_end, reason, requested_by, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(sn, command, startTs, endTs, reason, requestedBy, 'queued', formatTimestamp(new Date()));
}
// Called on every authenticated /iclock request. Writes at most once a minute.
async function recordDeviceContact(sn) {
  const now = new Date();
  const nowTs = formatTimestamp(now);
  const row = await getDeviceStatus(sn);
  if (!row) {
    await db.prepare('INSERT OR IGNORE INTO device_status (sn, last_seen) VALUES (?, ?)').run(sn, nowTs);
    return;
  }
  const gapMinutes = minutesSince(row.last_seen, now);
  if (gapMinutes < 1) return;
  // Conditional on the old value: the device's first few requests after an outage
  // arrive together, and only one of them should record the outage and queue a re-sync.
  const updated = await db.prepare('UPDATE device_status SET last_seen = ? WHERE sn = ? AND last_seen = ?').run(nowTs, sn, row.last_seen);
  if (!updated.changes || gapMinutes < DEVICE_OFFLINE_MINUTES) return;
  await db.prepare('UPDATE device_status SET last_outage_start = ?, last_outage_end = ? WHERE sn = ?').run(row.last_seen, nowTs, sn);
  await queueDeviceResync(sn, shiftTs(row.last_seen, -RESYNC_OVERLAP_MINUTES), nowTs, `Automatic: device back after ${formatDuration(gapMinutes)} offline`);
  console.log(`[adms] device ${sn} back after ${formatDuration(gapMinutes)} offline (since ${row.last_seen}); re-sync queued`);
}
// A re-sync still being worked on: queued, sent and not yet answered (or given up on),
// or answered under a minute ago — its punches may still be on their way in.
async function hasResyncInFlight(sn) {
  const now = new Date();
  const sentCutoff = formatTimestamp(new Date(now.getTime() - DEVICE_COMMAND_TIMEOUT_MINUTES * 60000));
  const doneCutoff = formatTimestamp(new Date(now.getTime() - 60000));
  const row = await db.prepare(
    "SELECT COUNT(*) AS c FROM device_commands WHERE sn = ? AND (status = 'queued' OR (status = 'sent' AND sent_at > ?) OR (status IN ('done', 'failed') AND done_at > ?))"
  ).get(sn, sentCutoff, doneCutoff);
  return Number(row.c) > 0;
}
// Runs an auto-checkout that was held while the device was offline, once the device
// is back and any catch-up re-sync has finished.
async function resumeHeldAutoCheckout(sn) {
  const row = await getDeviceStatus(sn);
  if (!row || !row.auto_checkout_held || await hasResyncInFlight(sn)) return;
  const claimed = await db.prepare('UPDATE device_status SET auto_checkout_held = 0 WHERE sn = ? AND auto_checkout_held = 1').run(sn);
  if (!claimed.changes) return;
  console.log('[adms] device back and caught up: running the held auto-checkout');
  await performAutoCheckout();
}
// Attendance records from either the device's regular push or its reply to a re-sync.
// Counts are added to the re-sync they belong to (cmdId), or else to one sent within
// the timeout, so the Settings card can show what each re-sync brought in.
async function ingestAttlogText(sn, text, cmdId = null) {
  let received = 0, ingested = 0;
  for (const line of String(text).split('\n')) {
    const record = parseAttlogLine(line);
    if (!record) continue;
    received++;
    const employee = await getEmployeeByDevicePin(record.pin);
    if (!employee) {
      logSecurityEvent('adms_unmapped_pin', { pin: record.pin, timestamp: record.timestamp });
      continue;
    }
    const { inserted } = await ingestBiometricPunch(employee.id, correctDeviceTimestamp(record.timestamp));
    if (inserted) ingested++;
  }
  if (received > 0) {
    const sentCutoff = formatTimestamp(new Date(Date.now() - DEVICE_COMMAND_TIMEOUT_MINUTES * 60000));
    const target = cmdId
      ? await db.prepare('SELECT id FROM device_commands WHERE id = ? AND sn = ?').get(cmdId, sn)
      : await db.prepare("SELECT id FROM device_commands WHERE sn = ? AND status IN ('sent', 'done') AND sent_at > ? ORDER BY id DESC LIMIT 1").get(sn, sentCutoff);
    if (target) {
      await db.prepare('UPDATE device_commands SET punches_received = punches_received + ?, punches_new = punches_new + ? WHERE id = ?')
        .run(received, ingested, target.id);
    }
  }
  return { received, ingested };
}

async function ingestBiometricPunch(employeeId, timestamp) {
  const direction = await inferPunchDirection(employeeId, timestamp);
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
  // `.c` must read off the resolved row, not the pending promise — `await x.get().c`
  // binds the member access before the await, so it silently evaluated to undefined
  // and the nav badge below never showed a count.
  return (await db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE employee_id = ? AND read = 0').get(employeeId)).c;
}
async function unreadNotificationCountAll() {
  return (await db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE read = 0').get()).c;
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
async function getCorrectionRequests(employeeId) {
  return await db.prepare('SELECT * FROM correction_requests WHERE employee_id = ? ORDER BY requested_at DESC').all(employeeId);
}
async function getAllCorrectionRequests() {
  return await db.prepare('SELECT * FROM correction_requests ORDER BY requested_at DESC').all();
}
// From a month's pending + approved corrections (getActiveCorrectionsForMonth).
function summarizeCorrectionUsage(monthCorrections) {
  return {
    used: monthCorrections.filter(c => c.kind !== 'both').length,
    fullDayUsed: monthCorrections.filter(c => c.kind === 'both').length,
  };
}

const CORRECTION_KINDS = ['check_in', 'check_out', 'both'];
// Checks a correction against the day's punches as they are right now. Runs on submit,
// and again on approval (forApproval), since the device can upload the real punch in
// between. forApproval skips the "current month, not in the future" window, which only
// limits what an employee can file — a request filed on the 31st can be approved on the 1st.
// Returns null if valid, else { key, vars } for an i18n 'corrections.err_*' message.
async function validateCorrection(employee, c, { excludeId = null, forApproval = false } = {}) {
  const err = (key, vars) => ({ key: `corrections.err_${key}`, vars });
  if (!CORRECTION_KINDS.includes(c.kind)) return err('kind');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date || '')) return err('date');
  const needIn = c.kind !== 'check_out';
  const needOut = c.kind !== 'check_in';
  const isTime = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '');
  if (needIn && !isTime(c.check_in_time)) return err('in_time');
  if (needOut && !isTime(c.check_out_time)) return err('out_time');
  if (c.kind === 'both' && c.check_out_time <= c.check_in_time) return err('out_before_in');
  const today = todayStr();
  if (!forApproval) {
    if (c.date > today) return err('future_date');
    if (c.date.slice(0, 7) !== today.slice(0, 7)) return err('other_month');
    if (employee.date_joined && c.date < employee.date_joined) return err('before_joining');
    const nowHHMM = formatTimestamp(new Date()).slice(11, 16);
    if (c.date === today && ((needIn && c.check_in_time > nowHHMM) || (needOut && c.check_out_time > nowHHMM))) return err('future_time');
  }

  const real = (await getPunchesForDay(employee.id, c.date)).filter(p => p.source !== 'auto');
  const first = real.length ? real[0].timestamp.slice(11, 16) : null;
  const last = real.length ? real[real.length - 1].timestamp.slice(11, 16) : null;
  if (c.kind === 'both' && real.length > 0) return err('has_punches');
  if (c.kind === 'check_out') {
    if (real.length % 2 === 0) return err('no_open_checkin');
    if (c.check_out_time <= last) return err('out_before_last', { time: last });
  }
  if (c.kind === 'check_in') {
    // No punches at all is only a missed check-in while the day is still going —
    // on a past day that's "forgot both".
    if (real.length === 0 && c.date !== today) return err('no_punches_use_both');
    if (real.length > 0 && real.length % 2 === 0) return err('day_complete');
    if (real.length > 0 && c.check_in_time >= first) return err('in_after_first', { time: first });
  }

  const duplicate = await db.prepare(
    "SELECT id FROM correction_requests WHERE employee_id = ? AND date = ? AND status IN ('pending', 'approved') AND id != ?"
  ).get(employee.id, c.date, excludeId ?? -1);
  if (duplicate) return err('duplicate');
  if (c.kind === 'both') {
    const month = await getActiveCorrectionsForMonth(employee.id, c.date.slice(0, 7));
    if (month.filter(m => m.kind === 'both' && m.id !== excludeId).length >= FULL_DAY_CORRECTION_MONTHLY_LIMIT) return err('full_day_used');
  }
  return null;
}

// Days this month the employee forgot to check out and hasn't filed a correction for —
// the dashboard nudges them to fix each one.
async function getUncorrectedMissedCheckouts(employeeId) {
  const monthPrefix = todayStr().slice(0, 7);
  const autoDays = await db.prepare(
    "SELECT DISTINCT substr(timestamp, 1, 10) AS d FROM punches WHERE employee_id = ? AND source = 'auto' AND timestamp LIKE ? ORDER BY d ASC"
  ).all(employeeId, `${monthPrefix}%`);
  const filed = new Set((await getActiveCorrectionsForMonth(employeeId, monthPrefix)).map(c => c.date));
  const days = [];
  for (const { d } of autoDays) {
    if (filed.has(d)) continue;
    const status = await computeDayStatus(employeeId, d);
    if (status && status.status === 'Missed Checkout') days.push(d);
  }
  return days;
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
async function computeOvertimeMinutes(employee, dateStr, fetchPunches = getPunchesForDay) {
  const punches = effectivePunches(await fetchPunches(employee.id, dateStr));
  // Unresolved day (no punches, or an odd count — still "in progress" or a punch error):
  // no verified overtime until the day actually resolves to a real checkout.
  if (punches.length === 0 || punches.length % 2 !== 0) return 0;
  const checkIn = punches[0];
  const checkOut = punches[punches.length - 1];
  // A synthetic auto-checkout is not a real punch — never count it as verified overtime,
  // or "forgot to punch out" quietly becomes free overtime hours. Same for a corrected
  // check-out: it's a time the employee typed in, not one the device recorded.
  if (checkOut.source === 'auto' || checkOut.source === 'correction') return 0;

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

// Batches everything computeDayStatus/computeOvertimeMinutes need for a date range
// into a fixed handful of queries, instead of each employee x day independently
// hitting the live (network-backed Turso) db for punches/breaks/holiday/leave/
// permission. Reports and the admin dashboard used to do N employees x M days x
// (2-4 queries) as live round trips — this fetches everything once and serves
// computeDayStatus/computeOvertimeMinutes from an in-memory index instead.
//
// This intentionally does NOT touch attendance-logic.js: it hands createAttendanceLogic
// a `db`-shaped object that resolves its exact known query shapes from pre-fetched maps,
// so computeDayStatus's logic itself is byte-for-byte the same tested code, just backed
// by memory instead of the network for this call. If attendance-logic.js's internal SQL
// text ever changes shape, the `sql.includes(...)` routing below needs to change with it.
async function createAttendanceSnapshot(rangeStart, rangeEnd, likePrefix) {
  const [employees, punches, breaks, holidays, leaves, permissions, corrections] = await Promise.all([
    allEmployees(),
    db.prepare('SELECT * FROM punches WHERE timestamp LIKE ? ORDER BY timestamp ASC').all(`${likePrefix}%`),
    db.prepare('SELECT * FROM breaks WHERE start_ts LIKE ? ORDER BY start_ts ASC').all(`${likePrefix}%`),
    db.prepare('SELECT * FROM holidays WHERE date LIKE ?').all(`${likePrefix}%`),
    db.prepare("SELECT * FROM leave_requests WHERE status = 'approved' AND start_date <= ? AND end_date >= ?").all(rangeEnd, rangeStart),
    db.prepare("SELECT * FROM permission_requests WHERE status = 'approved' AND date LIKE ?").all(`${likePrefix}%`),
    // Whole months, even for a one-day range: whether a day's correction is past the
    // monthly limit depends on every other correction filed that month.
    db.prepare("SELECT * FROM correction_requests WHERE status IN ('pending', 'approved') AND date >= ? AND date <= ? ORDER BY id ASC")
      .all(`${rangeStart.slice(0, 7)}-01`, `${rangeEnd.slice(0, 7)}-31`),
  ]);

  const employeeById = new Map(employees.map(e => [e.id, e]));
  function groupByEmpDate(rows, dateOf) {
    const m = new Map();
    for (const r of rows) {
      const key = `${r.employee_id}|${dateOf(r)}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(r);
    }
    return m;
  }
  const punchesByKey = groupByEmpDate(punches, p => p.timestamp.slice(0, 10));
  const breaksByKey = groupByEmpDate(breaks, b => b.start_ts.slice(0, 10));
  const holidayByDate = new Map(holidays.map(h => [h.date, h]));
  const permissionByKey = new Map(permissions.map(p => [`${p.employee_id}|${p.date}`, p]));
  const correctionsByKey = groupByEmpDate(corrections, c => c.date.slice(0, 7));
  const leavesByEmployee = new Map();
  for (const l of leaves) {
    if (!leavesByEmployee.has(l.employee_id)) leavesByEmployee.set(l.employee_id, []);
    leavesByEmployee.get(l.employee_id).push(l);
  }

  const snapshotDb = {
    prepare(sql) {
      if (sql.includes('FROM employees WHERE id')) {
        return { get: (id) => employeeById.get(id) };
      }
      if (sql.includes('FROM punches WHERE employee_id')) {
        return { all: (employeeId, likeArg) => punchesByKey.get(`${employeeId}|${likeArg.slice(0, 10)}`) || [] };
      }
      if (sql.includes('FROM breaks WHERE employee_id')) {
        return { all: (employeeId, likeArg) => breaksByKey.get(`${employeeId}|${likeArg.slice(0, 10)}`) || [] };
      }
      if (sql.includes('FROM holidays WHERE date')) {
        return { get: (dateStr) => holidayByDate.get(dateStr) };
      }
      if (sql.includes('FROM leave_requests')) {
        return {
          get: (employeeId, dateStr) => (leavesByEmployee.get(employeeId) || [])
            .find(l => dateStr >= l.start_date && dateStr <= l.end_date),
        };
      }
      if (sql.includes('FROM permission_requests')) {
        return { get: (employeeId, dateStr) => permissionByKey.get(`${employeeId}|${dateStr}`) };
      }
      if (sql.includes('FROM correction_requests')) {
        return { all: (employeeId, likeArg) => correctionsByKey.get(`${employeeId}|${likeArg.slice(0, 7)}`) || [] };
      }
      throw new Error(`createAttendanceSnapshot: unhandled query shape: ${sql}`);
    },
  };

  const snapshotLogic = createAttendanceLogic(snapshotDb);
  return {
    employees,
    correctionsFor: (employeeId, monthPrefix) => correctionsByKey.get(`${employeeId}|${monthPrefix}`) || [],
    computeDayStatus: snapshotLogic.computeDayStatus,
    computeOvertimeMinutes: (employee, dateStr) => computeOvertimeMinutes(employee, dateStr, snapshotLogic.getPunchesForDay),
  };
}

// Mirrors the day-by-day iteration computeMonthlyOvertimeSummary() already does —
// same "skip future days" rule, so a report run mid-month doesn't count Upcoming
// days as Absent.
// Shared by all three day-level reports below (summary/grid/muster) — this computes
// each employee x day status ONCE (not 3x independently), backed by a single
// createAttendanceSnapshot() instead of live per-employee-per-day queries, which is
// what made the Reports page slow (see createAttendanceSnapshot's comment above).
async function computeMonthlyStatusGrid(year, month) {
  const monthStr = String(month).padStart(2, '0');
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = todayStr();
  const dateStrs = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${monthStr}-${String(d).padStart(2, '0')}`;
    if (dateStr <= today) dateStrs.push(dateStr);
  }
  const snapshot = await createAttendanceSnapshot(
    `${year}-${monthStr}-01`,
    `${year}-${monthStr}-${String(daysInMonth).padStart(2, '0')}`,
    `${year}-${monthStr}`,
  );
  const perEmployee = await Promise.all(snapshot.employees.map(async employee => {
    const statuses = await Promise.all(dateStrs.map(dateStr => snapshot.computeDayStatus(employee.id, dateStr)));
    const overtimeMinutesByDay = await Promise.all(dateStrs.map(dateStr => snapshot.computeOvertimeMinutes(employee, dateStr)));
    const corrections = snapshot.correctionsFor(employee.id, `${year}-${monthStr}`);
    return { employee, statuses, overtimeMinutesByDay, corrections };
  }));
  return { daysInMonth, perEmployee };
}

function computePunchInReport(grid) {
  return grid.perEmployee.map(({ employee, statuses, overtimeMinutesByDay, corrections }) => {
    let present = 0, late = 0, halfDay = 0, absent = 0, totalHours = 0, missedCheckouts = 0;
    for (const status of statuses) {
      if (status.status === 'Present') present++;
      else if (status.status === 'Late') late++;
      else if (status.status === 'Half Day' || status.status === 'Missed Checkout') halfDay++;
      else if (status.status === 'Absent') absent++;
      if (status.missedCheckout) missedCheckouts++;
      totalHours += status.hoursWorked || 0;
    }
    const usage = summarizeCorrectionUsage(corrections);
    const overtimeMinutes = overtimeMinutesByDay.reduce((sum, m) => sum + m, 0);
    return {
      id: employee.id, name: employee.name, present, late, halfDay, absent, missedCheckouts,
      correctionsUsed: `${usage.used} / ${CORRECTION_MONTHLY_LIMIT}${usage.fullDayUsed ? ' + full day' : ''}`,
      correctionsOverLimit: usage.used > CORRECTION_MONTHLY_LIMIT,
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
// Late is pink, matching the Calendar (where yellow now means a remote punch-in) —
// the one admins scan for first.
const MUSTER_STATUS_CODE = {
  'Present': 'P', 'Late': 'L', 'Half Day': 'HD', 'Absent': 'A',
  'Week Off': 'WO', 'Holiday': 'H', 'Punch Error': 'PE', 'Active': 'AC', 'On Leave': 'OL',
  'Missed Checkout': 'MC',
};
const GRID_CELL_COLOR = {
  'Present': '#E8F5E9',
  'Late': '#FCE4EC',
  'Half Day': '#FBE7DE',
  'Missed Checkout': '#FBE7DE',
  'Absent': '#FDECEA',
  'Week Off': '#F0F0F0',
  'Holiday': '#E0F2F1',
  'Punch Error': '#FDE4E1',
  'Active': '#E3F2FD',
  'On Leave': '#F3E5F5',
  'Upcoming': 'transparent',
};
// Present/Late/Half Day/Active all mean "showed up in some form" for headcount purposes.
const MUSTER_PRESENT_STATUSES = new Set(['Present', 'Late', 'Half Day', 'Missed Checkout', 'Active']);

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
        text = status.status === 'Missed Checkout'
          ? `MC ${inStr}-?`
          : `${status.late ? 'L ' : ''}${inStr}-${outStr}`;
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

// Same grid shape as Punch-In Detail, but each cell is that day's net hours worked
// (HH:MM, breaks already subtracted by computeDayStatus) instead of in/out times.
// "MC" marks a missed check-out, counted only up to the shift end. Days without a
// completed in/out pair fall back to a status code.
function computeWorkingHoursGrid(grid) {
  const rows = grid.perEmployee.map(({ employee, statuses }) => {
    let totalMinutes = 0;
    const cells = statuses.map(status => {
      if (status.checkIn && status.checkOut) {
        const minutes = Math.round((status.hoursWorked || 0) * 60);
        totalMinutes += minutes;
        return { text: `${status.status === 'Missed Checkout' ? 'MC ' : ''}${formatHoursAsClock(status.hoursWorked)}`, status: status.status };
      }
      return { text: MUSTER_STATUS_CODE[status.status] ?? status.status, status: status.status };
    });
    while (cells.length < grid.daysInMonth) cells.push({ text: '', status: 'Upcoming' });
    return { id: employee.id, name: employee.name, cells, total: formatHoursAsClock(totalMinutes / 60) };
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
// Also sweeps the previous AUTO_CHECKOUT_CATCHUP_DAYS days: a run that didn't fire or
// failed (2026-09-29: no auto-checkouts for anyone, open days left as Punch Error), or
// a check-in the device only uploaded after that evening's run, would otherwise stay
// open forever — each run only ever looked at its own day.
const AUTO_CHECKOUT_CATCHUP_DAYS = 7;
let lastAutoCheckoutDate = null;
async function performAutoCheckout() {
  const now = new Date();
  const today = todayStr(now);
  const dateStrs = [];
  for (let i = AUTO_CHECKOUT_CATCHUP_DAYS; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dateStrs.push(todayStr(d));
  }
  // Can run before 19:00 when a run held for a device outage resumes in the morning —
  // today isn't over yet, so leave it alone then.
  const includeToday = now.getHours() >= AUTO_CHECKOUT_HOUR;
  if (!includeToday) dateStrs.pop();
  const employees = await db.prepare('SELECT id FROM employees').all();
  for (const emp of employees) {
    const recent = await db.prepare('SELECT * FROM punches WHERE employee_id = ? AND timestamp >= ? ORDER BY timestamp ASC')
      .all(emp.id, `${dateStrs[0]} 00:00:00`);
    for (const dateStr of dateStrs) {
      const dayPunches = recent.filter(p => p.timestamp.startsWith(dateStr));
      // An auto-checkout already recorded means this day was handled once; if it's
      // still open (a real punch after 19:00), leave it for an admin rather than
      // stacking a second synthetic punch — and a second notification — every night.
      if (effectivePunches(dayPunches).length % 2 === 0 || dayPunches.some(p => p.source === 'auto')) continue;
      // Vercel's Hobby cron only guarantees per-hour precision, so this can actually run
      // any time in the 19:00-19:59 window. Pin the recorded time to AUTO_CHECKOUT_HOUR
      // sharp rather than stamping whenever the invocation happened to land.
      const cutoffTs = `${dateStr} ${pad(AUTO_CHECKOUT_HOUR)}:00:00`;
      // A check-in after the cutoff can't be closed by a checkout stamped before it.
      if (dayPunches[dayPunches.length - 1].timestamp >= cutoffTs) continue;
      if (!await recordPunch(emp.id, cutoffTs, 'out', 'auto', 'auto-checkout')) continue;
      const when = dateStr === today ? `${AUTO_CHECKOUT_HOUR}:00` : `${AUTO_CHECKOUT_HOUR}:00 on ${dateStr}`;
      await createNotification(emp.id, `You didn't check out, so you were auto-checked out at ${when}. That day counts as a Half Day until you submit a correction from the Corrections page.`);
      console.log(`Auto-checked-out ${emp.id} for ${dateStr} (forgot to punch out)`);
    }
    if (!includeToday) continue;
    const cutoffTs = `${today} ${pad(AUTO_CHECKOUT_HOUR)}:00:00`;
    // Also close out any break left open past end of day, so it doesn't linger open
    // forever and keep skewing tomorrow's queries (breaks are looked up by start_ts).
    // Same pinned cutoff as above, so a break never appears to end after the
    // synthetic checkout it's attached to.
    await db.prepare("UPDATE breaks SET end_ts = ? WHERE employee_id = ? AND end_ts IS NULL AND start_ts LIKE ?")
      .run(cutoffTs, emp.id, `${today}%`);
  }
}
// The scheduled 19:00 run. While the device is offline the evening's real check-outs
// are probably still sitting on it, so hold off rather than auto-checking everyone out
// and telling them they forgot — resumeHeldAutoCheckout runs it once the device is back.
async function runScheduledAutoCheckout() {
  const sn = CONFIG.ZK_DEVICE_SN;
  const device = sn ? await getDeviceStatus(sn) : null;
  if (device && isDeviceOffline(device.last_seen)) {
    await db.prepare('UPDATE device_status SET auto_checkout_held = 1 WHERE sn = ?').run(sn);
    console.log(`Auto-checkout held: biometric device offline since ${device.last_seen}`);
    return 'held';
  }
  await performAutoCheckout();
  return 'ran';
}
async function checkAndRunAutoCheckout() {
  const now = new Date();
  const today = todayStr(now);
  if (lastAutoCheckoutDate === today) return;
  if (now.getHours() < AUTO_CHECKOUT_HOUR) return;
  await runScheduledAutoCheckout();
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

// Accepts a bare 10-digit Indian mobile number, optionally prefixed with '+91', '91',
// or a domestic trunk '0'. Returns the bare 10-digit form, or null if invalid — the
// caller is responsible for treating null as a validation error.
function normalizeMobile(raw) {
  const digits = String(raw || '').replace(/[\s-]/g, '');
  const match = digits.match(/^(?:\+?91|0)?([6-9]\d{9})$/);
  return match ? match[1] : null;
}

// Deliberately permissive (no full RFC 5322 check) — this only guards against
// obviously-malformed input, since the field is optional and unverified anyway.
function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

// Short tags shown after each punch time on the calendar: [desktop, phone].
// 'on-site' was the old name for what is now a remote punch — same location capture,
// just no longer switched on per employee. Old rows keep the value they were written
// with and are translated on read, rather than rewritten at startup: a rewrite can't be
// undone once new remote punches exist (nothing distinguishes a converted row from a
// genuine one), which would make rolling this release back lossy.
const LEGACY_SOURCE_ALIASES = { 'on-site': 'remote' };
function normalizeSource(source) {
  return LEGACY_SOURCE_ALIASES[source] || source;
}
// Every stored value that reads as a remote punch — for queries, which can't call
// normalizeSource.
const REMOTE_SOURCE_VALUES = ['remote', 'on-site'];

const PUNCH_SOURCE_TAGS = {
  'biometric': ['BIO', 'B'],
  'wifi': ['WIFI', 'W'],
  'remote': ['REMOTE', 'R'],
  'auto': ['AUTO', 'A'],
  'correction': ['CORR', 'C'],
};
function punchSourceTag(source) {
  const key = normalizeSource(source);
  const [long, short] = PUNCH_SOURCE_TAGS[key] || [String(key).slice(0, 4).toUpperCase(), String(key).slice(0, 1).toUpperCase()];
  return `<span class="cal-src"><span class="cal-long">${escapeHtml(long)}</span><span class="cal-short">${escapeHtml(short)}</span></span>`;
}
function punchSourceName(source, lang) {
  const key = normalizeSource(source);
  return PUNCH_SOURCE_TAGS[key] ? t(lang, `calendar.source.${key}`) : key;
}
// Biometric, WiFi and the 19:00 auto-checkout all happen at the office; a correction
// says nothing about where, so only a remote punch counts as away.
function isRemotePunch(p) {
  return !!p && normalizeSource(p.source) === 'remote';
}
// Which STATUS_STYLE a calendar day uses: Present is split by where they checked in;
// Late stays pink wherever it was.
function calendarStyleKey(status, checkIn) {
  if (status === 'Present' && isRemotePunch(checkIn)) return 'Present (Remote)';
  return status;
}

const STATUS_STYLE = {
  'Present':     { fg: '#2E7D32', bg: '#E8F5E9' },
  // Calendar-only: a Present day whose check-in was remote (see calendarStyleKey).
  'Present (Remote)': { fg: '#7A5C00', bg: '#FFF4C2', dot: '#E0A800' },
  'Late':        { fg: '#AD1457', bg: '#FCE4EC' },
  'Half Day':    { fg: '#C24914', bg: '#FBE7DE' },
  'Missed Checkout': { fg: '#C24914', bg: '#FBE7DE' },
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
// `short` keeps just the address's first part (the area), with the full one on hover,
// for narrow table columns.
function locationCell(p, short = false) {
  const label = p.location_address || p.location;
  if (!label) return '—';
  const mapQuery = p.location || p.location_address;
  const shown = short && p.location_address ? p.location_address.split(',')[0].trim() : label;
  return `<a href="https://www.google.com/maps?q=${encodeURIComponent(mapQuery)}" target="_blank" rel="noopener" title="${escapeHtml(label)}">${escapeHtml(shown)}</a>`;
}

// Where a punch was made, for admin tables: a remote punch shows its location.
function punchPlaceHtml(p) {
  if (isRemotePunch(p)) return `<span style="color:#7A5C00;font-weight:600;">Remote</span><br><span style="display:inline-block;max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;">${locationCell(p, true)}</span>`;
  if (p.source === 'correction') return 'Correction';
  if (p.source === 'auto') return 'Auto check-out';
  return 'Office';
}
// The admin dashboard's "Where" cell: where the day's check-in and check-out were.
function punchedFromCell(status) {
  if (!status.checkInPunch) return '<span style="color:#9AA5B1;">—</span>';
  const lines = [`In: ${punchPlaceHtml(status.checkInPunch)}`];
  if (status.checkOutPunch) lines.push(`Out: ${punchPlaceHtml(status.checkOutPunch)}`);
  return lines.join('<br>');
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

const ACCOUNT_ROLES = ['employee', 'manager'];

// Employee-linked accounts only ('admin' has employee_id = null and is never reached
// through this map) - batched for the registration page's employee list so it is one
// query rather than one per row.
async function accountRolesByEmployeeId() {
  const rows = await db.prepare("SELECT employee_id, role FROM users WHERE employee_id IS NOT NULL").all();
  return Object.fromEntries(rows.map(r => [r.employee_id, r.role]));
}

async function accountRoleForEmployee(employeeId) {
  const row = await db.prepare('SELECT role FROM users WHERE employee_id = ?').get(employeeId);
  return (row && row.role) || 'employee';
}

async function employeeSwitcher(currentId, basePath) {
  const options = (await allEmployees()).map(e =>
    `<option value="${escapeHtml(e.id)}" ${e.id === currentId ? 'selected' : ''}>${escapeHtml(e.name)} (${escapeHtml(e.id)})</option>`
  ).join('');
  return `<select onchange="location.href='${basePath}?employee_id=' + this.value" style="font-size:0.95em;padding:6px 10px;border-radius:6px;border:1px solid #D0D5DA;">${options}</select>`;
}

const ADMIN_TABLE_VIEWS = ['dashboard', 'leave', 'remote-punches', 'permission', 'corrections', 'overtime', 'notifications', 'device-pins', 'field-trip', 'employee-registration', 'reports', 'calendar-company', 'settings']; // table pages — no single-employee switcher here

async function pageShell(title, employeeId, activeNav, bodyHtml, user, opts = {}) {
  const isAdmin = isManagementRole(user);
  const lang = langOf(user);
  const showSwitcher = isAdmin && !ADMIN_TABLE_VIEWS.includes(activeNav);
  // Onboarding only ever shows on an employee's own dashboard — it anchors to
  // elements (#onbHoursCard, #navCalendar, ...) that only that page guarantees.
  // opts.forceOnboardingTour replays the tour on demand without touching the
  // stored seen-version, so replaying never marks a real "what's new" as read.
  let onboardingKind = null;
  if (!isAdmin && user && activeNav === 'dashboard') {
    if (opts.forceOnboardingTour) onboardingKind = 'tour';
    else if (user.onboardingSeenVersion === 0) onboardingKind = 'tour';
    else if (user.onboardingSeenVersion < ONBOARDING.CURRENT_VERSION) onboardingKind = 'whats-new';
  }
  // The very first onboarding screen an employee who's never chosen a language
  // sees is a language picker, not the welcome sheet — picking persists via the
  // same /settings/language route the sidebar toggle uses, then the page reloads
  // and the welcome sheet renders directly in that language. Gated on
  // languageSet rather than the tour/replay distinction, so it shows exactly
  // once ever, and a mid-tour reload or a later replay never asks again.
  const showLanguagePicker = onboardingKind === 'tour' && !!user && !user.languageSet;
  const unreadCount = isAdmin ? await unreadNotificationCountAll() : (user ? await unreadNotificationCount(employeeId) : 0);
  const pendingDocs = (!isAdmin && employeeId) ? await pendingDocumentCount(employeeId) : 0;
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
      /* Calendar punch times: a source tag after each time, short letter on phones. */
      .cal-src { display: inline-block; font-size: 0.85em; font-weight: 700; padding: 0 4px; border-radius: 4px; background: rgba(255,255,255,0.75); margin-left: 3px; color: #1B2430; }
      .cal-short { display: none; }
      .cal-legend .cal-src { background: #EEF1F3; margin: 0 3px 0 0; }
      .cal-day.has-times { cursor: pointer; }
      .cal-day.cal-selected { box-shadow: inset 0 0 0 2px #1B2430; }
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
        /* No room for the status word and two times: the colour carries the status
           (see the legend), and source tags shrink to one letter. */
        .cal-grid .has-times .cal-status { display: none; }
        .cal-grid .cal-times { font-size: 0.6em !important; }
        .cal-grid .cal-long, .cal-legend .cal-long { display: none; }
        .cal-grid .cal-short, .cal-legend .cal-short { display: inline; }
      }
    </style></head>
    <body>
    <button id="navToggle" aria-label="Menu" onclick="document.querySelector('nav').classList.toggle('open');document.getElementById('navBackdrop').classList.toggle('open');">&#9776;</button>
    <div id="navBackdrop" onclick="document.querySelector('nav').classList.remove('open');this.classList.remove('open');"></div>
    <nav>
      <div class="brand">Attendance Gateway</div>
      <div class="links">
        <a href="/dashboard?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'dashboard' ? 'active' : ''}"><span class="ico">🏠</span> <span class="lbl">${t(lang, 'nav.dashboard')}</span></a>
        <a id="navCalendar" href="/calendar?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'calendar' || activeNav === 'calendar-company' ? 'active' : ''}"><span class="ico">📅</span> <span class="lbl">${t(lang, 'nav.calendar')}</span></a>
        <a id="navLeave" href="/leave?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'leave' ? 'active' : ''}"><span class="ico">🌴</span> <span class="lbl">${t(lang, 'nav.leave')}</span></a>
        <a href="/permission?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'permission' ? 'active' : ''}"><span class="ico">🕓</span> <span class="lbl">${t(lang, 'nav.permission')}</span></a>
        <a href="/corrections?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'corrections' ? 'active' : ''}"><span class="ico">✏️</span> <span class="lbl">${t(lang, 'nav.corrections')}</span></a>
        <a href="/overtime?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'overtime' ? 'active' : ''}"><span class="ico">⏱</span> <span class="lbl">${t(lang, 'nav.overtime')}</span></a>
        ${CONFIG.LOCATIONIQ_API_KEY ? `<a href="/field-trip?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'field-trip' ? 'active' : ''}"><span class="ico">🚗</span> <span class="lbl">${t(lang, 'nav.field_trips')}</span></a>` : ''}
        ${!isAdmin ? `<a id="navDocuments" href="/documents?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'documents' ? 'active' : ''}"><span class="ico">📁</span> <span class="lbl">${t(lang, 'nav.documents')}${pendingDocs ? ` (${pendingDocs})` : ''}</span></a>` : ''}
        ${isAdmin ? `<a href="/admin/employee-registration" class="${activeNav === 'employee-registration' ? 'active' : ''}"><span class="ico">🧑‍💼</span> <span class="lbl">Employee Registration</span></a>` : ''}
        ${isAdmin ? `<a href="/admin/remote-punches" class="${activeNav === 'remote-punches' ? 'active' : ''}"><span class="ico">📍</span> <span class="lbl">Remote Punches</span></a>` : ''}
        ${isAdmin ? `<a href="/admin/reports" class="${activeNav === 'reports' ? 'active' : ''}"><span class="ico">📊</span> <span class="lbl">Reports</span></a>` : ''}
        ${isAdmin ? `<a href="/admin/settings" class="${activeNav === 'settings' ? 'active' : ''}"><span class="ico">⚙️</span> <span class="lbl">Settings</span></a>` : ''}
        ${isAdmin
          ? `<a href="/notifications" class="${activeNav === 'notifications' ? 'active' : ''}"><span class="ico">🔔</span> <span class="lbl">Notifications${unreadCount ? ` (${unreadCount})` : ''}</span></a>`
          : `<a id="navNotifications" href="/notifications?employee_id=${escapeHtml(employeeId)}" class="${activeNav === 'notifications' ? 'active' : ''}"><span class="ico">🔔</span> <span class="lbl">${t(lang, 'nav.notifications')}${unreadCount ? ` (${unreadCount})` : ''}</span></a>`}
      </div>
      <div class="acct">${langToggle}${(!isAdmin && user) ? `<a href="/dashboard?employee_id=${escapeHtml(employeeId)}&tour=1" style="color:#4C5A68;font-size:0.9em;text-decoration:none;">${t(lang, 'onboarding.replay_tour')}</a>` : ''}${rightSide}</div>
    </nav>
    <div class="main">
      <div class="wrap">
        <div class="topbar-mobile">${langToggle}${rightSide}</div>
        ${bodyHtml}
      </div>
    </div>
    ${IOS_INSTALL_SHEET_HTML}
    ${ANDROID_INSTALL_SHEET_HTML}
    ${onboardingKind ? renderOnboardingOverlay(onboardingKind, lang, user, employeeId, showLanguagePicker) : ''}
    </body></html>`;
}

// The first-login guided tour and the "what's new" delta modal, both driven by
// onboarding-content.js. Rendered as an overlay on top of the real dashboard
// markup pageShell already produced — coachmarks anchor to elements already on
// that page (nav links, dashboard cards), so a step is skipped client-side
// (ALL_STEPS.filter) if this employee's config doesn't render that element
// (e.g. no punch button configured yet), instead of pointing at nothing.
function renderOnboardingOverlay(kind, lang, user, employeeId, showLanguagePicker) {
  if (kind === 'tour' && showLanguagePicker) {
    // Bilingual by necessity — we don't yet know which language to render in.
    // Submits through the same /settings/language route the sidebar toggle
    // uses, so picking here is indistinguishable from picking there: it
    // persists language_set = 1 and the page reloads straight into the
    // welcome sheet, already in the chosen language.
    const returnPath = `/dashboard?employee_id=${encodeURIComponent(employeeId)}`;
    const langBtn = (value, label) => `
      <form method="POST" action="/settings/language?return=${encodeURIComponent(returnPath)}" style="flex:1;">
        <button type="submit" name="lang" value="${value}" style="width:100%;padding:16px 0;border-radius:10px;border:1px solid #D0D5DA;background:#fff;color:#1B2430;font-weight:700;font-size:15px;cursor:pointer;">${label}</button>
      </form>`;
    return `
    <div id="onbLangPick" style="position:fixed;inset:0;z-index:200;background:rgba(15,20,25,0.45);display:flex;align-items:flex-end;">
      <div style="width:100%;max-width:480px;margin:0 auto;background:#fff;border-radius:20px 20px 0 0;padding:26px 22px 24px;box-sizing:border-box;box-shadow:0 -10px 28px rgba(15,20,25,0.18);">
        <div style="width:42px;height:42px;border-radius:11px;background:#E3F2FD;color:#1565C0;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;margin-bottom:16px;">WV</div>
        <h3 style="margin:0 0 4px;font-size:18px;">Choose your language</h3>
        <h3 style="margin:0 0 8px;font-size:18px;">மொழியைத் தேர்ந்தெடுக்கவும்</h3>
        <p style="margin:0 0 20px;font-size:13.5px;line-height:1.55;color:#4C5A68;">You can change this anytime from the menu. / இதை மெனுவிலிருந்து எப்போது வேண்டுமானாலும் மாற்றலாம்.</p>
        <div style="display:flex;gap:10px;">${langBtn('en', 'English')}${langBtn('ta', 'தமிழ்')}</div>
      </div>
    </div>`;
  }
  if (kind === 'tour') {
    const steps = ONBOARDING.ENTRIES
      .filter(e => e.tourStep)
      .map(e => ({ anchor: e.tourStep.anchor, text: t(lang, e.tourStep.key) }));
    return `
    <div id="onbWelcome" style="position:fixed;inset:0;z-index:200;background:rgba(15,20,25,0.45);display:flex;align-items:flex-end;">
      <div style="width:100%;max-width:480px;margin:0 auto;background:#fff;border-radius:20px 20px 0 0;padding:26px 22px 24px;box-sizing:border-box;box-shadow:0 -10px 28px rgba(15,20,25,0.18);">
        <div style="width:42px;height:42px;border-radius:11px;background:#E3F2FD;color:#1565C0;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;margin-bottom:16px;">WV</div>
        <h3 style="margin:0 0 8px;font-size:18px;">${escapeHtml(t(lang, 'onboarding.welcome_title', { name: (user && user.username) || '' }))}</h3>
        <p style="margin:0 0 20px;font-size:13.5px;line-height:1.55;color:#4C5A68;">${escapeHtml(t(lang, 'onboarding.welcome_body'))}</p>
        <button onclick="onbStart()" style="width:100%;background:#1565C0;color:#fff;border:none;border-radius:9px;padding:13px 0;font-weight:700;font-size:14px;margin-bottom:10px;cursor:pointer;">${escapeHtml(t(lang, 'onboarding.welcome_cta'))}</button>
        <div onclick="onbFinish()" style="text-align:center;font-size:12.5px;color:#7C8896;font-weight:600;cursor:pointer;">${escapeHtml(t(lang, 'onboarding.welcome_skip'))}</div>
      </div>
    </div>
    <div id="onbSpot" style="display:none;position:fixed;border:2px solid #E2711D;border-radius:14px;box-shadow:0 0 0 4000px rgba(15,20,25,0.55);z-index:201;pointer-events:none;"></div>
    <div id="onbCard" style="display:none;position:fixed;background:#1B2430;color:#fff;border-radius:12px;padding:14px 16px;width:250px;max-width:calc(100vw - 32px);box-shadow:0 10px 26px rgba(0,0,0,0.3);z-index:202;box-sizing:border-box;">
      <div id="onbStepTag" style="font-size:10.5px;color:#E2711D;letter-spacing:0.05em;margin-bottom:6px;"></div>
      <div id="onbStepText" style="font-size:12.5px;line-height:1.5;color:#DCE3EA;margin-bottom:12px;"></div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <button onclick="onbFinish()" style="background:none;border:none;color:#8A97A5;font-weight:700;font-size:11.5px;cursor:pointer;padding:0;">${escapeHtml(t(lang, 'onboarding.skip_tour'))}</button>
        <button id="onbNextBtn" onclick="onbNext()" style="background:none;border:none;color:#E2711D;font-weight:700;font-size:11.5px;cursor:pointer;padding:0;"></button>
      </div>
    </div>
    <script>
      (function() {
        var ALL_STEPS = ${JSON.stringify(steps)};
        var NEXT_LABEL = ${JSON.stringify(t(lang, 'onboarding.next'))};
        var FINISH_LABEL = ${JSON.stringify(t(lang, 'onboarding.finish_cta'))};
        var STEP_LABEL = ${JSON.stringify(t(lang, 'onboarding.step_of'))};
        var steps = [];
        var idx = -1;
        function place() {
          var step = steps[idx];
          var el = document.querySelector(step.anchor);
          if (!el) { onbNext(); return; }
          var r = el.getBoundingClientRect();
          var pad = 6;
          var spot = document.getElementById('onbSpot');
          spot.style.display = 'block';
          spot.style.top = (r.top - pad) + 'px';
          spot.style.left = (r.left - pad) + 'px';
          spot.style.width = (r.width + pad * 2) + 'px';
          spot.style.height = (r.height + pad * 2) + 'px';
          var card = document.getElementById('onbCard');
          card.style.display = 'block';
          document.getElementById('onbStepTag').textContent = STEP_LABEL.replace('{{n}}', idx + 1).replace('{{total}}', steps.length);
          document.getElementById('onbStepText').textContent = step.text;
          document.getElementById('onbNextBtn').textContent = (idx === steps.length - 1) ? FINISH_LABEL : NEXT_LABEL;
          var spaceBelow = window.innerHeight - r.bottom;
          var top = spaceBelow > 170 ? r.bottom + 14 : Math.max(14, r.top - 140);
          var left = Math.min(Math.max(16, r.left), window.innerWidth - 266);
          card.style.top = top + 'px';
          card.style.left = left + 'px';
        }
        window.onbStart = function() {
          document.getElementById('onbWelcome').style.display = 'none';
          steps = ALL_STEPS.filter(function(s) { return document.querySelector(s.anchor); });
          idx = -1;
          window.onbNext();
        };
        window.onbNext = function() {
          idx++;
          if (idx >= steps.length) { window.onbFinish(); return; }
          var el = document.querySelector(steps[idx].anchor);
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          setTimeout(place, 220);
        };
        window.onbFinish = function() {
          var w = document.getElementById('onbWelcome'); if (w) w.style.display = 'none';
          var s = document.getElementById('onbSpot'); if (s) s.style.display = 'none';
          var c = document.getElementById('onbCard'); if (c) c.style.display = 'none';
          fetch('/onboarding/ack', { method: 'POST' });
        };
      })();
    </script>`;
  }

  // 'whats-new': only entries newer than what this employee has already seen —
  // never the full history, and never the tour again.
  const items = ONBOARDING.ENTRIES.filter(e => e.whatsNew && e.version > user.onboardingSeenVersion);
  const rows = items.map(e => `
      <div style="display:flex;gap:10px;padding:10px 0;border-top:1px solid #EEF0F2;">
        <span style="flex-shrink:0;font-family:monospace;font-size:9.5px;font-weight:700;color:#B26A00;background:#FFF3E0;padding:2px 6px;border-radius:5px;height:fit-content;margin-top:2px;">${escapeHtml(t(lang, 'onboarding.whatsnew_tag'))}</span>
        <div style="font-size:12.5px;color:#333e48;line-height:1.5;">${escapeHtml(t(lang, e.whatsNew.key))}</div>
      </div>`).join('');
  return `
    <div id="onbWhatsNew" style="position:fixed;inset:0;z-index:200;background:rgba(15,20,25,0.45);display:flex;align-items:center;justify-content:center;padding:22px;">
      <div style="background:#fff;border-radius:16px;padding:22px;width:100%;max-width:380px;box-shadow:0 16px 40px rgba(0,0,0,0.25);box-sizing:border-box;">
        <h3 style="margin:0 0 4px;font-size:16.5px;">${escapeHtml(t(lang, 'onboarding.whatsnew_title'))}</h3>
        <div style="font-size:12px;color:#7C8896;margin-bottom:6px;">${escapeHtml(t(lang, 'onboarding.whatsnew_subtitle'))}</div>
        <div>${rows}</div>
        <button onclick="fetch('/onboarding/ack',{method:'POST'}).then(function(){document.getElementById('onbWhatsNew').remove();})" style="width:100%;background:#1565C0;color:#fff;border:none;border-radius:9px;padding:13px 0;font-weight:700;font-size:14px;cursor:pointer;margin-top:16px;">${escapeHtml(t(lang, 'onboarding.whatsnew_dismiss'))}</button>
      </div>
    </div>`;
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
    </div>
    ${ANDROID_INSTALL_SHEET_HTML}
    </body></html>`;
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
    </div>
    ${ANDROID_INSTALL_SHEET_HTML}
    </body></html>`;
}

// The Punch In/Out button, shared by the employee dashboard and the "My attendance
// today" card managers get on the admin dashboard. Anyone can punch from anywhere:
// on the office WiFi it's an office punch, otherwise it's a remote one with the
// phone's location attached. `onOfficeWifi` is only for the hint under the button —
// the server checks the network again on every punch.
function selfPunchBlock(dayStatus, lang, onOfficeWifi) {
  const hint = onOfficeWifi
    ? t(lang, 'dashboard.office_hint', { ssid: escapeHtml(CONFIG.OFFICE_WIFI_SSID) })
    : escapeHtml(t(lang, 'dashboard.remote_hint'));
  return `
      <div id="selfPunchStatus" style="font-size:0.85em;opacity:0.9;margin-bottom:8px;min-height:1.2em;"></div>
      <button id="selfPunchBtn" onclick="selfPunch()" style="padding:10px 22px;border-radius:8px;border:none;background:#fff;color:#1565C0;font-weight:700;cursor:pointer;">${dayStatus.status === 'Active' ? t(lang, 'dashboard.punch_out') : t(lang, 'dashboard.punch_in')}</button>
      <div style="font-size:0.75em;opacity:0.8;margin-top:6px;">${onOfficeWifi ? '📶' : '📍'} ${hint}</div>`;
}

// selfPunchBlock's click handler. Always tries an office punch first, without asking
// for location, so nobody in the office gets a location prompt; only when the server
// says this isn't the office network does it fetch the location and punch remotely.
function selfPunchScript(employeeId, lang) {
  return `
      function selfPunchPost(fields) {
        return fetch('/api/punch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ employee_id: ${JSON.stringify(employeeId)} }, fields))
        }).then(async r => ({ ok: r.ok, data: await r.json() }));
      }
      function selfPunchFail(message, isHtml) {
        const status = document.getElementById('selfPunchStatus');
        status.style.color = '#FFCDD2';
        if (isHtml) status.innerHTML = message; else status.textContent = message;
        document.getElementById('selfPunchBtn').disabled = false;
      }
      function selfPunchDone(res) {
        if (!res.ok) return selfPunchFail(res.data.error || ${JSON.stringify(t(lang, 'dashboard.punch_failed'))});
        const status = document.getElementById('selfPunchStatus');
        status.style.color = '';
        status.textContent = res.data.direction === 'in' ? ${JSON.stringify(t(lang, 'dashboard.punched_in'))} : ${JSON.stringify(t(lang, 'dashboard.punched_out'))};
        setTimeout(() => window.location.reload(), 700);
      }
      function selfPunchWrong() {
        selfPunchFail(${JSON.stringify(t(lang, 'dashboard.something_wrong'))});
      }
      function selfPunchRemote() {
        const status = document.getElementById('selfPunchStatus');
        if (!navigator.geolocation) return selfPunchFail(${JSON.stringify(t(lang, 'dashboard.geolocation_unsupported'))});
        status.textContent = ${JSON.stringify(t(lang, 'dashboard.getting_location'))};
        navigator.geolocation.getCurrentPosition(
          pos => selfPunchPost({ source: 'remote', location: pos.coords.latitude.toFixed(5) + ', ' + pos.coords.longitude.toFixed(5) })
            .then(selfPunchDone).catch(selfPunchWrong),
          err => err.code === 1
            ? selfPunchFail(${JSON.stringify(escapeHtml(t(lang, 'dashboard.location_denied')) + '<br><span style="font-size:0.88em;opacity:0.85;">' + escapeHtml(t(lang, 'dashboard.location_denied_help')) + '</span>')}, true)
            : selfPunchFail(${JSON.stringify(t(lang, 'dashboard.location_failed'))}),
          // Fresh, GPS-level position: no cached fix from somewhere else.
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
      }
      function selfPunch() {
        const status = document.getElementById('selfPunchStatus');
        const btn = document.getElementById('selfPunchBtn');
        if (!status || !btn) return;
        btn.disabled = true;
        status.style.color = '';
        status.textContent = ${JSON.stringify(t(lang, 'dashboard.checking'))};
        selfPunchPost({ source: 'wifi' }).then(res => {
          if (!res.ok && res.data.code === 'not_on_office_wifi') return selfPunchRemote();
          selfPunchDone(res);
        }).catch(selfPunchWrong);
      }`;
}

async function renderDashboard(employee, dayStatus, punches, user, overtimeMinutes = 0, overtimeAuthorized = false, leaveBalances = [], breaks = [], forceOnboardingTour = false, missedCheckoutDays = [], onOfficeWifi = false) {
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

  // One banner per uncorrected missed check-out this month, each linking to a
  // pre-filled correction request.
  const missedCheckoutBanners = missedCheckoutDays.map(d => {
    const dateLabel = new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    return `
    <div class="card" style="background:#FFF3E0;border:1px solid #FFCC80;color:#B26A00;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
      <div><strong>⚠ ${t(lang, 'dashboard.missed_checkout_banner', { date: escapeHtml(dateLabel) })}</strong></div>
      <a href="/corrections?employee_id=${escapeHtml(employee.id)}&date=${escapeHtml(d)}&kind=check_out" style="padding:6px 14px;border-radius:6px;background:#1565C0;color:#fff;font-weight:600;text-decoration:none;white-space:nowrap;">${t(lang, 'dashboard.fix_it')}</a>
    </div>`;
  }).join('');

  const body = `
    ${missedCheckoutBanners}
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
    <div id="onbHoursCard" class="card" style="background:#1565C0;color:#fff;">
      <div style="font-size:0.8em;letter-spacing:0.06em;text-transform:uppercase;opacity:0.85;">${t(lang, 'dashboard.working_hours')}</div>
      ${timerBlock}
      <div style="margin-top:12px;opacity:0.9;font-size:0.92em;">${t(lang, 'dashboard.shift', { start: escapeHtml(todayShift.start), end: escapeHtml(todayShift.end) })}</div>
      ${overtimeMinutes > 0 ? `
      <div style="margin-top:8px;font-size:0.92em;display:flex;align-items:center;gap:8px;">
        <span style="opacity:0.9;">${t(lang, 'dashboard.overtime', { time: formatMinutesAsHM(overtimeMinutes) })}</span>
        <span style="padding:2px 9px;border-radius:999px;font-size:0.8em;font-weight:600;background:rgba(255,255,255,0.2);">${overtimeAuthorized ? t(lang, 'dashboard.authorized') : t(lang, 'dashboard.unauthorized')}</span>
      </div>` : ''}
      <div style="margin-top:14px;">${selfPunchBlock(dayStatus, lang, onOfficeWifi)}</div>
      ${breakBlock}
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">${t(lang, 'dashboard.todays_activity')}</div>
      <table><tr><th>${t(lang, 'dashboard.event')}</th><th>${t(lang, 'dashboard.time')}</th><th>${t(lang, 'dashboard.source')}</th></tr>${punchRows}</table>
    </div>
    <div id="onbLeaveCard" class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="font-weight:700;">${t(lang, 'dashboard.leave_balance')}</div>
        <a href="/leave?employee_id=${escapeHtml(employee.id)}" style="font-size:0.85em;color:#1565C0;text-decoration:none;font-weight:600;">${t(lang, 'dashboard.apply_view_history')}</a>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">${leaveBalanceCards}</div>
    </div>
    <script>
      ${selfPunchScript(employee.id, lang)}
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
  return pageShell(t(lang, 'dashboard.title'), employee.id, 'dashboard', body, user, { forceOnboardingTour });
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
  const monthPrefix = `${year}-${monthStr}`;
  const [dayStatuses, monthPunches, monthBreaks] = await Promise.all([
    Promise.all(dateStrs.map(dateStr => computeDayStatus(employee.id, dateStr))),
    // The month's punches and breaks in one query each, for the times, sources and
    // tap-a-day details, rather than per day on top of computeDayStatus's own queries.
    db.prepare('SELECT * FROM punches WHERE employee_id = ? AND timestamp LIKE ? ORDER BY timestamp ASC').all(employee.id, `${monthPrefix}%`),
    db.prepare('SELECT * FROM breaks WHERE employee_id = ? AND start_ts LIKE ? ORDER BY start_ts ASC').all(employee.id, `${monthPrefix}%`),
  ]);
  // Remote punch locations are for admins only, not the employee's own view.
  const showLocation = isManagementRole(user);
  const hhmm = ts => ts.slice(11, 16);

  const cells = [];
  const details = [];
  for (let i = 0; i < startWeekday; i++) cells.push('<div></div>');
  dayStatuses.forEach((status, i) => {
    const d = i + 1;
    const dateStr = dateStrs[i];
    const isToday = dateStr === todayStr();
    // Same punches computeDayStatus counts: first is the check-in, last the check-out
    // (only once they pair up).
    const punches = effectivePunches(monthPunches.filter(p => p.timestamp.startsWith(dateStr)));
    const breaks = monthBreaks.filter(b => b.start_ts.startsWith(dateStr));
    const checkIn = punches[0];
    const styleKey = calendarStyleKey(status.status, checkIn);
    const s = STATUS_STYLE[styleKey] || STATUS_STYLE['Upcoming'];
    const checkOut = punches.length % 2 === 0 ? punches[punches.length - 1] : null;
    const timesHtml = checkIn ? `
      <div class="cal-times" style="font-size:0.7em;margin-top:3px;line-height:1.4;font-variant-numeric:tabular-nums;">
        <span title="${t(lang, 'calendar.check_in')}" style="white-space:nowrap;">${hhmm(checkIn.timestamp)}${punchSourceTag(checkIn.source)}</span><br>
        <span title="${t(lang, 'calendar.check_out')}" style="white-space:nowrap;">${checkOut ? `${hhmm(checkOut.timestamp)}${punchSourceTag(checkOut.source)}` : '—'}</span>
      </div>` : '';
    cells.push(`<div class="cal-day${checkIn ? ' has-times' : ''}" data-day="${dateStr}" style="background:${s.bg};color:${s.fg};border-radius:8px;padding:8px 6px;min-height:52px;overflow-wrap:break-word;${isToday ? 'outline:2px solid #1565C0;' : ''}">
      <div style="font-weight:700;">${d}</div>
      <div class="cal-status" style="font-size:0.72em;font-weight:600;overflow-wrap:break-word;hyphens:auto;">${escapeHtml(t(lang, `status.${styleKey}`))}</div>${timesHtml}
    </div>`);
    if (!checkIn) return;

    const events = [
      ...punches.map((p, idx) => {
        let detail = '';
        if (p.source === 'correction') detail = t(lang, 'calendar.correction_by', { name: p.marked_by || '—' });
        else if (isRemotePunch(p) && showLocation) detail = { html: locationCell(p) };
        return { time: p.timestamp, cells: [t(lang, idx % 2 === 0 ? 'calendar.check_in' : 'calendar.check_out'), hhmm(p.timestamp), punchSourceName(p.source, lang), detail] };
      }),
      ...breaks.map(b => {
        const minutes = b.end_ts ? Math.round((parseTimestamp(b.end_ts) - parseTimestamp(b.start_ts)) / 60000) : null;
        return {
          time: b.start_ts,
          cells: [t(lang, 'calendar.break'), `${hhmm(b.start_ts)} – ${b.end_ts ? hhmm(b.end_ts) : ''}`, '—',
            minutes == null ? t(lang, 'calendar.break_open') : t(lang, 'calendar.break_minutes', { n: minutes })],
        };
      }),
    ].sort((a, b) => a.time.localeCompare(b.time));
    const dateLabel = new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    details.push(`
      <div class="cal-detail" data-day="${dateStr}" hidden>
        <div style="font-weight:700;margin-bottom:8px;">${escapeHtml(dateLabel)} · ${escapeHtml(t(lang, `status.${styleKey}`))}</div>
        <table>
          <tr><th>${t(lang, 'calendar.col_event')}</th><th>${t(lang, 'calendar.col_time')}</th><th>${t(lang, 'calendar.col_source')}</th><th>${t(lang, 'calendar.col_details')}</th></tr>
          ${events.map(e => `<tr>${e.cells.map(c => `<td>${c && c.html ? c.html : escapeHtml(c || '—')}</td>`).join('')}</tr>`).join('')}
        </table>
      </div>`);
  });

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const monthName = t(lang, `calendar.month.${month}`);

  const legend = Object.keys(STATUS_STYLE).map(status => `
    <span style="display:inline-flex;align-items:center;gap:5px;font-size:0.8em;margin-right:14px;margin-bottom:6px;">
      <span style="width:10px;height:10px;border-radius:50%;background:${STATUS_STYLE[status].dot || STATUS_STYLE[status].fg};display:inline-block;"></span>${t(lang, `status.${status}`)}
    </span>`).join('');
  const sourceLegend = Object.keys(PUNCH_SOURCE_TAGS).map(source => `
    <span style="display:inline-flex;align-items:center;gap:3px;font-size:0.8em;margin-right:14px;margin-bottom:6px;color:#4C5A68;">
      ${punchSourceTag(source)}${escapeHtml(punchSourceName(source, lang))}
    </span>`).join('');

  const body = `
    ${isManagementRole(user) ? calendarViewToggle(employee.id, 'mine') : ''}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <a href="/calendar?employee_id=${escapeHtml(employee.id)}&year=${prevYear}&month=${prevMonth}" style="text-decoration:none;font-size:1.2em;">&#8249;</a>
        <div style="font-weight:700;font-size:1.1em;">${monthName} ${year}</div>
        <a href="/calendar?employee_id=${escapeHtml(employee.id)}&year=${nextYear}&month=${nextMonth}" style="text-decoration:none;font-size:1.2em;">&#8250;</a>
      </div>
      <div class="cal-grid" style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;">${headerCells.join('')}${cells.join('')}</div>
    </div>
    <div class="card" id="calDetails">
      <div class="cal-detail-hint" style="color:#7C8896;font-size:0.9em;">${t(lang, 'calendar.tap_hint')}</div>
      ${details.join('')}
    </div>
    <div class="card">${legend}<div class="cal-legend" style="margin-top:8px;">${sourceLegend}</div></div>
    <script>
      (function () {
        document.querySelectorAll('.cal-day.has-times').forEach(function (cell) {
          cell.addEventListener('click', function () {
            var day = cell.dataset.day;
            document.querySelectorAll('.cal-day').forEach(function (c) { c.classList.toggle('cal-selected', c === cell); });
            document.querySelectorAll('.cal-detail').forEach(function (d) { d.hidden = d.dataset.day !== day; });
            document.querySelector('.cal-detail-hint').hidden = true;
            var panel = document.getElementById('calDetails');
            if (panel.getBoundingClientRect().top > window.innerHeight) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          });
        });
      })();
    </script>`;
  return pageShell(t(lang, 'calendar.title'), employee.id, 'calendar', body, user);
}

async function renderLeave(employee, balances, requests, user, error) {
  const isAdmin = isManagementRole(user);
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

// A manager's own attendance on the admin dashboard, with the same Punch button
// employees get.
function myAttendanceCard(employee, dayStatus, lang, onOfficeWifi) {
  const time = ts => escapeHtml(ts.split(' ')[1].slice(0, 5));
  const facts = [
    dayStatus.checkIn ? `In ${time(dayStatus.checkIn)}` : 'Not punched in yet',
    dayStatus.checkOut ? `Out ${time(dayStatus.checkOut)}` : null,
    dayStatus.status === 'Active'
      ? `Working <span class="liveHours" data-checkin="${escapeHtml(dayStatus.checkIn.replace(' ', 'T'))}">00:00:00</span>`
      : null,
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  return `
    <div class="card" style="background:linear-gradient(135deg,#1565C0,#1E88E5);color:#fff;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;">
      <div>
        <div style="font-size:0.85em;opacity:0.85;">My attendance today</div>
        <div style="font-size:1.25em;font-weight:700;margin:2px 0 6px;">${escapeHtml(employee.name)}</div>
        <div style="font-size:0.9em;">${statusBadge(dayStatus.status, dayStatus.label, lang)} &nbsp;${facts}</div>
      </div>
      <div>${selfPunchBlock(dayStatus, lang, onOfficeWifi)}</div>
    </div>
    <script>${selfPunchScript(employee.id, lang)}</script>`;
}

// "18:02" for today, "5 Oct 18:02" otherwise; withDate always includes the date
// (for ranges, where a bare time next to a dated one is ambiguous).
function deviceTimeLabel(ts, withDate = false) {
  if (!withDate && ts.slice(0, 10) === todayStr()) return ts.slice(11, 16);
  return `${new Date(`${ts.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${ts.slice(11, 16)}`;
}
function deviceOfflineBanner(device) {
  return `
    <div class="card" style="background:#FDECEA;border:1px solid #F5B7B1;color:#B71C1C;">
      <strong>⚠ The biometric device hasn't reached the app since ${escapeHtml(deviceTimeLabel(device.last_seen))} (${escapeHtml(formatDuration(minutesSince(device.last_seen)))} ago).</strong>
      The office PC may be off or asleep, or the internet may be down. Punches are kept on the device and will come in once it reconnects.
      ${device.auto_checkout_held ? 'The 7 PM auto-checkout is on hold until then.' : ''}
      <a href="/admin/settings#device" style="color:#B71C1C;font-weight:600;">Device status →</a>
    </div>`;
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
          ? statusBadge('Missed Checkout', `Auto ${r.status.checkOut.split(' ')[1]}`)
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
      <td style="font-size:0.82em;">${punchedFromCell(r.status)}</td>
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
    ${opts.offlineDevice ? deviceOfflineBanner(opts.offlineDevice) : ''}
    ${opts.myAttendance ? myAttendanceCard(opts.myAttendance.employee, opts.myAttendance.dayStatus, langOf(user), opts.myAttendance.onOfficeWifi) : ''}
    ${statsWidgets}
    ${devicePinsLink}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
        <a href="${basePath}?date=${prevStr}" style="text-decoration:none;font-size:1.2em;">&#8249;</a>
        <div style="font-weight:700;">${label}</div>
        <a href="${basePath}?date=${nextStr}" style="text-decoration:none;font-size:1.2em;">&#8250;</a>
        <input type="date" value="${dateStr}" onchange="location.href='${basePath}?date=' + this.value" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
      </div>
      <table><tr><th>Employee</th><th>Status</th><th>Check In</th><th>Check Out</th><th>Hours</th><th>Break</th><th>Permission</th><th>Where</th></tr>${tableRows}</table>
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

function correctionTimesText(r, lang) {
  return [
    r.check_in_time ? `${t(lang, 'corrections.in')} ${r.check_in_time}` : null,
    r.check_out_time ? `${t(lang, 'corrections.out')} ${r.check_out_time}` : null,
  ].filter(Boolean).join(' · ');
}
// Whether each request is past the monthly limit, worked out per month from the
// employee's own pending + approved requests (same rule as computeDayStatus).
function correctionsOverLimitById(requests) {
  const active = requests.filter(r => r.status === 'pending' || r.status === 'approved').sort((a, b) => a.id - b.id);
  const overLimit = new Set();
  for (const r of active) {
    if (r.kind === 'both') continue;
    const sameMonth = active.filter(c => c.date.slice(0, 7) === r.date.slice(0, 7));
    if (correctionOverLimit(sameMonth, r)) overLimit.add(r.id);
  }
  return overLimit;
}

async function renderCorrections(employee, requests, user, error, prefill = {}) {
  const lang = langOf(user);
  const monthPrefix = todayStr().slice(0, 7);
  const usage = summarizeCorrectionUsage(requests.filter(r => r.date.slice(0, 7) === monthPrefix && (r.status === 'pending' || r.status === 'approved')));
  const overLimit = correctionsOverLimitById(requests);
  const kind = CORRECTION_KINDS.includes(prefill.kind) ? prefill.kind : 'check_out';

  const rows = requests.map(r => {
    let statusHtml = r.status === 'pending'
      ? statusBadge('Upcoming', t(lang, 'status.awaiting_approval'), lang)
      : statusBadge(r.status === 'approved' ? 'Present' : 'Absent', t(lang, `status.${r.status}`), lang);
    if (overLimit.has(r.id)) statusHtml += ` ${statusBadge('Half Day', t(lang, 'corrections.half_day_note'), lang)}`;
    return `
    <tr>
      <td>${escapeHtml(r.date)}</td>
      <td>${t(lang, `corrections.kind.${r.kind}`)}</td>
      <td>${escapeHtml(correctionTimesText(r, lang))}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>${statusHtml}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" style="color:#9AA5B1;">${t(lang, 'corrections.no_requests')}</td></tr>`;

  const remaining = Math.max(0, CORRECTION_MONTHLY_LIMIT - usage.used);
  const fullDayLeft = Math.max(0, FULL_DAY_CORRECTION_MONTHLY_LIMIT - usage.fullDayUsed);
  const body = `
    ${error ? `<div class="card" style="color:#C62828;">${escapeHtml(t(lang, error.key, error.vars))}</div>` : ''}
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px;">${t(lang, 'corrections.summary_title')}</div>
      <div style="display:flex;gap:28px;flex-wrap:wrap;">
        <div>
          <div style="font-size:1.6em;font-weight:700;${usage.used > CORRECTION_MONTHLY_LIMIT ? 'color:#C62828;' : ''}">${usage.used}</div>
          <div style="color:#7C8896;font-size:0.85em;">${t(lang, 'corrections.used')}</div>
        </div>
        <div>
          <div style="font-size:1.6em;font-weight:700;">${remaining}</div>
          <div style="color:#7C8896;font-size:0.85em;">${t(lang, 'corrections.remaining', { limit: CORRECTION_MONTHLY_LIMIT })}</div>
        </div>
        <div>
          <div style="font-size:1.6em;font-weight:700;">${fullDayLeft}</div>
          <div style="color:#7C8896;font-size:0.85em;">${t(lang, 'corrections.full_day_left', { limit: FULL_DAY_CORRECTION_MONTHLY_LIMIT })}</div>
        </div>
      </div>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px;">${t(lang, 'corrections.apply_title')}</div>
      <p style="color:#7C8896;font-size:0.9em;margin-top:0;">${t(lang, 'corrections.apply_hint', { limit: CORRECTION_MONTHLY_LIMIT })}</p>
      <form method="POST" action="/corrections/apply" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'corrections.date')}</label>
          <input type="date" name="date" required value="${escapeHtml(prefill.date || '')}" min="${monthPrefix}-01" max="${todayStr()}" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'corrections.missed')}</label>
          <select name="kind" id="corrKind" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
            ${CORRECTION_KINDS.map(k => `<option value="${k}" ${k === kind ? 'selected' : ''}>${t(lang, `corrections.kind.${k}`)}</option>`).join('')}
          </select>
        </div>
        <div id="corrIn">
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'corrections.check_in_time')}</label>
          <input type="time" name="check_in_time" value="${escapeHtml(prefill.check_in_time || '')}" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div id="corrOut">
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'corrections.check_out_time')}</label>
          <input type="time" name="check_out_time" value="${escapeHtml(prefill.check_out_time || '')}" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div style="flex:1;min-width:160px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">${t(lang, 'corrections.reason')}</label>
          <input type="text" name="reason" required value="${escapeHtml(prefill.reason || '')}" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
        </div>
        <button type="submit" style="padding:8px 16px;border-radius:6px;border:none;background:#1565C0;color:#fff;font-weight:600;">${t(lang, 'corrections.submit')}</button>
      </form>
      ${usage.used >= CORRECTION_MONTHLY_LIMIT ? `<div style="background:#FBE7DE;border-radius:8px;padding:9px 12px;font-size:0.88em;margin-top:12px;">${t(lang, 'corrections.over_limit_warning', { limit: CORRECTION_MONTHLY_LIMIT })}</div>` : ''}
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">${t(lang, 'corrections.my_requests')}</div>
      <table><tr><th>${t(lang, 'corrections.col_date')}</th><th>${t(lang, 'corrections.col_missed')}</th><th>${t(lang, 'corrections.col_corrected_to')}</th><th>${t(lang, 'corrections.col_reason')}</th><th>${t(lang, 'corrections.col_status')}</th></tr>${rows}</table>
    </div>
    <script>
      (function () {
        var kind = document.getElementById('corrKind');
        function update() {
          document.getElementById('corrIn').style.display = kind.value === 'check_out' ? 'none' : '';
          document.getElementById('corrOut').style.display = kind.value === 'check_in' ? 'none' : '';
        }
        kind.addEventListener('change', update);
        update();
      })();
    </script>`;
  return pageShell(t(lang, 'corrections.title'), employee.id, 'corrections', body, user);
}

async function renderAdminCorrections(requests, user, error) {
  const employeesById = new Map((await allEmployees()).map(e => [e.id, e]));
  const nameCell = id => {
    const emp = employeesById.get(id);
    return `<strong>${escapeHtml(emp ? emp.name : id)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(id)})</span>`;
  };
  const pending = requests.filter(r => r.status === 'pending');
  const history = requests.filter(r => r.status !== 'pending');

  const pendingRows = (await Promise.all(pending.map(async r => {
    const dayPunches = await getPunchesForDay(r.employee_id, r.date);
    const recorded = dayPunches.map(p => `${p.timestamp.slice(11, 16)}${p.source === 'auto' ? ' (auto)' : ''}`).join(', ') || 'No punches';
    // What the day will look like once approved, so a mis-filed request (e.g. a
    // "missed check-in" before what was really a late check-in) is easy to spot.
    const simulated = [
      ...dayPunches,
      ...(r.check_in_time ? [{ timestamp: `${r.date} ${r.check_in_time}:00`, source: 'correction' }] : []),
      ...(r.check_out_time ? [{ timestamp: `${r.date} ${r.check_out_time}:00`, source: 'correction' }] : []),
    ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const after = effectivePunches(simulated);
    const afterText = after.length
      ? `In ${after[0].timestamp.slice(11, 16)} · Out ${after.length % 2 === 0 ? after[after.length - 1].timestamp.slice(11, 16) : '?'}`
      : '—';
    const monthCorrections = await getActiveCorrectionsForMonth(r.employee_id, r.date.slice(0, 7));
    const position = monthCorrections.filter(c => c.kind !== 'both').findIndex(c => c.id === r.id) + 1;
    const usageCell = r.kind === 'both'
      ? 'Full-day correction'
      : (correctionOverLimit(monthCorrections, r)
          ? statusBadge('Half Day', 'Over limit: stays Half Day')
          : `${position} of ${CORRECTION_MONTHLY_LIMIT}`);
    return `
    <tr>
      <td>${nameCell(r.employee_id)}</td>
      <td>${escapeHtml(r.date)}</td>
      <td>${t('en', `corrections.kind.${r.kind}`)}</td>
      <td>${escapeHtml(recorded)}</td>
      <td>${escapeHtml(afterText)}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>${usageCell}</td>
      <td>
        ${actionButton('/corrections/decide', { id: r.id, action: 'approve' }, 'Approve', '#2E7D32', true)}
        ${actionButton('/corrections/decide', { id: r.id, action: 'reject' }, 'Reject', '#C62828')}
      </td>
    </tr>`;
  }))).join('') || `<tr><td colspan="8" style="color:#9AA5B1;">No pending requests</td></tr>`;

  const historyRows = history.map(r => `
    <tr>
      <td>${nameCell(r.employee_id)}</td>
      <td>${escapeHtml(r.date)}</td>
      <td>${t('en', `corrections.kind.${r.kind}`)}</td>
      <td>${escapeHtml(correctionTimesText(r, 'en'))}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>${statusBadge(r.status === 'approved' ? 'Present' : 'Absent', r.status)}</td>
      <td>${escapeHtml(r.decided_by || '—')}</td>
    </tr>`).join('') || `<tr><td colspan="7" style="color:#9AA5B1;">No history yet</td></tr>`;

  const body = `
    ${error ? `<div class="card" style="color:#C62828;">${escapeHtml(error)}</div>` : ''}
    <div class="card" style="color:#7C8896;font-size:0.9em;">
      Employees file these when they forget to check in or check out. Each employee gets ${CORRECTION_MONTHLY_LIMIT} a month
      (pending and approved both count); past that, an approved correction fixes the times but the day still counts as a Half Day.
      They also get ${FULL_DAY_CORRECTION_MONTHLY_LIMIT} full-day correction a month for a day they forgot both.
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">Pending — All Employees</div>
      <table><tr><th>Employee</th><th>Date</th><th>Missed</th><th>Recorded by App</th><th>After Approval</th><th>Reason</th><th>Used This Month</th><th>Action</th></tr>${pendingRows}</table>
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">History — All Employees</div>
      <table><tr><th>Employee</th><th>Date</th><th>Missed</th><th>Corrected To</th><th>Reason</th><th>Status</th><th>Decided By</th></tr>${historyRows}</table>
    </div>`;
  return pageShell('Corrections', '', 'corrections', body, user);
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

const REMOTE_PUNCH_LOG_LIMIT = 100;
// Every remote punch (made away from the office WiFi), newest first, with where it was.
async function renderAdminRemotePunches(punches, user) {
  const rows = (await Promise.all(punches.map(async p => {
    const emp = await getEmployee(p.employee_id);
    return `
    <tr>
      <td><a href="/calendar?employee_id=${escapeHtml(p.employee_id)}" style="color:#1B2430;text-decoration:none;font-weight:600;">${escapeHtml(emp ? emp.name : p.employee_id)}</a> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(p.employee_id)})</span></td>
      <td>${p.direction === 'in' ? 'Punch In' : 'Punch Out'}</td>
      <td>${escapeHtml(p.timestamp)}</td>
      <td>${locationCell(p)}</td>
    </tr>`;
  }))).join('') || `<tr><td colspan="4" style="color:#9AA5B1;">No remote punches yet</td></tr>`;

  const body = `
    <div class="card">
      <div style="font-weight:700;margin-bottom:4px;">Remote Punches — All Employees</div>
      <p style="color:#7C8896;font-size:0.9em;margin-top:0;">Punches made away from the office WiFi, with the location captured from the phone. The latest ${REMOTE_PUNCH_LOG_LIMIT} are shown.</p>
      <table><tr><th>Employee</th><th>Event</th><th>Time</th><th>Location</th></tr>${rows}</table>
    </div>`;
  return pageShell('Remote Punches', '', 'remote-punches', body, user);
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

async function renderEmployeeRegistration(user, error, justCreated) {
  const existingEmployees = await allEmployees();
  const accountRoles = await accountRolesByEmployeeId();
  const reportsToOptions = existingEmployees
    .map(e => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)} (${escapeHtml(e.id)})</option>`)
    .join('');
  const nextId = await nextEmployeeId();
  const employeeRows = existingEmployees.map(e => `
    <tr>
      <td><strong>${escapeHtml(e.name)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(e.id)})</span></td>
      <td>${escapeHtml(e.designation || '—')}</td>
      <td>${escapeHtml(e.branch || '—')}</td>
      <td>${accountRoles[e.id] === 'manager' ? '<strong style="color:#1565C0;">Manager</strong>' : 'Employee'}</td>
      <td>${escapeHtml(e.shift_start)}&ndash;${escapeHtml(e.shift_end)}</td>
      <td style="white-space:nowrap;">
        <a href="/admin/employee/edit?employee_id=${encodeURIComponent(e.id)}" style="color:#1565C0;text-decoration:none;font-weight:600;margin-right:12px;">Edit</a>
        ${actionButton('/admin/employee/reset-password', { employee_id: e.id }, 'Reset password', '#B26A00')}
      </td>
    </tr>`).join('') || `<tr><td colspan="6" style="color:#9AA5B1;">No employees yet</td></tr>`;

  // Shown once, right after a successful registration — password123 is not a
  // per-employee secret (it is the fixed default for every new account, forced to
  // change at first login), so there is nothing sensitive about surfacing it again
  // here; this just saves the admin from remembering the convention to relay it.
  const credentialsCard = justCreated ? `
    <div class="card" style="border-color:#2E7D32;">
      <div style="font-weight:700;margin-bottom:6px;">Sign-in details for ${escapeHtml(justCreated.name)} (${escapeHtml(justCreated.id)})</div>
      <div style="color:#7C8896;font-size:0.85em;margin-bottom:10px;">Share these with the employee. They will be asked to set their own password the next time they log in.</div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <code id="newEmpCreds" style="flex:1;min-width:220px;display:block;background:#F5F6F8;padding:10px;border-radius:6px;white-space:pre-line;">URL: ${escapeHtml(justCreated.loginUrl || '')}
Username: ${escapeHtml(justCreated.id)}
Password: password123</code>
        <button type="button" id="copyNewEmpCreds" onclick="copyNewEmployeeCredentials()" style="padding:8px 14px;border-radius:6px;border:1px solid #D0D5DA;background:#fff;color:#1565C0;font-weight:600;cursor:pointer;white-space:nowrap;">Copy login details</button>
      </div>
    </div>
    <script>
      function copyNewEmployeeCredentials() {
        const text = document.getElementById('newEmpCreds').innerText;
        const btn = document.getElementById('copyNewEmpCreds');
        const done = (ok) => { btn.textContent = ok ? 'Copied' : 'Copy failed - select manually'; setTimeout(() => { btn.textContent = 'Copy login details'; }, 2000); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => done(true)).catch(() => done(false));
        } else {
          // Fallback for browsers without the async Clipboard API (older mobile WebViews).
          const ta = document.createElement('textarea');
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
          document.body.removeChild(ta);
          done(ok);
        }
      }
    </script>` : '';

  const body = `
    ${error ? `<div class="card" style="color:#C62828;">${escapeHtml(error)}</div>` : ''}
    ${credentialsCard}
    <div class="card">
      <div style="font-weight:700;margin-bottom:10px;">Employee Registration</div>
      <p style="color:#7C8896;font-size:0.9em;margin-top:0;">New employee will be enrolled as <strong>${escapeHtml(nextId)}</strong>.</p>
      <form method="POST" action="/admin/employee-registration" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <div style="flex:1;min-width:180px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">Name</label>
          <input type="text" name="name" required style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Mobile Number</label>
          <input type="tel" name="mobile" required placeholder="9876543210" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div style="flex:1;min-width:180px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">Email <span style="color:#9AA5B1;">(optional)</span></label>
          <input type="email" name="email" placeholder="name@company.com" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Employment Type</label>
          <select name="role" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
            ${EMPLOYMENT_TYPES.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Account Role</label>
          <select name="account_role" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
            <option value="employee">Employee</option>
            <option value="manager">Manager</option>
          </select>
        </div>
        <div style="flex:1;min-width:160px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">Designation</label>
          <input type="text" name="designation" placeholder="e.g. Sales Associate" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Branch</label>
          <select name="branch" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
            ${CONFIG.BRANCHES.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}
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
      <table><tr><th>Employee</th><th>Designation</th><th>Branch</th><th>Account</th><th>Shift</th><th></th></tr>${employeeRows}</table>
    </div>
    <div class="card" style="color:#7C8896;font-size:0.9em;">
      A login is created automatically (username = employee ID, default password <code>password123</code>),
      with a forced password change on first sign-in. The biometric device PIN is set
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
  const currentAccountRole = await accountRoleForEmployee(employee.id);

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
          <label style="display:block;font-size:0.8em;color:#7C8896;">Mobile Number</label>
          <input type="tel" name="mobile" required value="${escapeHtml(employee.mobile || '')}" placeholder="9876543210" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
        </div>
        <div style="flex:1;min-width:180px;">
          <label style="display:block;font-size:0.8em;color:#7C8896;">Email <span style="color:#9AA5B1;">(optional)</span></label>
          <input type="email" name="email" value="${escapeHtml(employee.email || '')}" placeholder="name@company.com" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;width:100%;">
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Employment Type</label>
          <select name="role" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
            <option value="">&mdash; None &mdash;</option>
            ${EMPLOYMENT_TYPES.map(t => `<option value="${escapeHtml(t)}" ${t === employee.role ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#7C8896;">Account Role</label>
          <select name="account_role" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;">
            <option value="employee" ${currentAccountRole === 'employee' ? 'selected' : ''}>Employee</option>
            <option value="manager" ${currentAccountRole === 'manager' ? 'selected' : ''}>Manager</option>
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
            ${(employee.branch && !CONFIG.BRANCHES.includes(employee.branch) ? [employee.branch, ...CONFIG.BRANCHES] : CONFIG.BRANCHES)
              .map(b => `<option value="${escapeHtml(b)}" ${b === employee.branch ? 'selected' : ''}>${escapeHtml(b)}</option>${b === employee.branch && !CONFIG.BRANCHES.includes(b) ? ' <!-- no longer in the configured list -->' : ''}`).join('')}
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
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid #EEF1F3;">
        <a href="/admin/employee/documents?employee_id=${escapeHtml(employee.id)}" style="color:#1565C0;text-decoration:none;font-weight:600;font-size:0.9em;">📁 View Documents &rarr;</a>
      </div>
    </div>`;
  return pageShell('Edit Employee', '', 'employee-registration', body, user);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Shared by both the employee self-service page and the management view — same
// upload mechanism (base64 JSON POST, no multipart parser in this app) and same
// per-type layout, just a different set of "who can see what's already uploaded"
// rules layered on top by the two callers.
const DOCUMENT_UPLOAD_SCRIPT = `
<script>
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
// Photos only: downscale to a max edge of 1000px and re-encode as JPEG before
// upload, since a phone camera photo can be several MB straight out of the
// camera roll — well past the 2MB per-file cap the server enforces.
function resizePhoto(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let width = img.naturalWidth, height = img.naturalHeight;
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
        else { width = Math.round(width * maxDim / height); height = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('Could not process image')); return; }
        const reader = new FileReader();
        reader.onload = () => resolve({ base64: reader.result.split(',')[1], contentType: 'image/jpeg' });
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      }, 'image/jpeg', quality);
    };
    img.onerror = () => reject(new Error('Could not read image'));
    img.src = url;
  });
}
async function uploadDoc(employeeId, docType) {
  const input = document.getElementById('file-' + docType);
  const statusEl = document.getElementById('status-' + docType);
  const file = input.files[0];
  if (!file) { statusEl.textContent = 'Choose a file first.'; statusEl.style.color = '#C62828'; return; }
  statusEl.textContent = 'Uploading…'; statusEl.style.color = '#7C8896';
  try {
    let base64, contentType;
    if (docType === 'photo' && file.type.startsWith('image/')) {
      const resized = await resizePhoto(file, 1000, 0.82);
      base64 = resized.base64; contentType = resized.contentType;
    } else {
      base64 = await fileToBase64(file); contentType = file.type;
    }
    const res = await fetch('/api/employee-documents/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: employeeId, doc_type: docType, filename: file.name, content_type: contentType, data_base64: base64 }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Upload failed.');
    statusEl.textContent = 'Uploaded.'; statusEl.style.color = '#2E7D32';
    input.value = '';
    setTimeout(() => location.reload(), 700);
  } catch (err) {
    statusEl.textContent = err.message || 'Upload failed.'; statusEl.style.color = '#C62828';
  }
}
</script>`;

function documentUploadCard(type, employeeId, existingListHtml) {
  const accept = type.key === 'photo' ? 'image/*' : 'image/jpeg,image/png,image/webp,application/pdf';
  return `
    <div class="card">
      <div style="font-weight:700;margin-bottom:8px;">${escapeHtml(type.label)}</div>
      ${existingListHtml}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:${existingListHtml ? '10px' : '0'};">
        <input type="file" id="file-${type.key}" accept="${accept}" style="flex:1;min-width:180px;">
        <button type="button" onclick="uploadDoc('${escapeHtml(employeeId)}', '${type.key}')" style="padding:7px 14px;border-radius:6px;border:none;background:#1565C0;color:#fff;font-weight:600;">Upload</button>
      </div>
      <div id="status-${type.key}" style="font-size:0.82em;margin-top:6px;"></div>
    </div>`;
}

async function renderEmployeeDocuments(employee, existing, user) {
  const lang = langOf(user);
  const byType = {};
  for (const row of existing) {
    (byType[row.doc_type] = byType[row.doc_type] || []).push(row);
  }
  const cards = DOCUMENT_TYPES.map(type => {
    const rows = byType[type.key] || [];
    const listHtml = rows.length
      ? `<div style="display:flex;flex-direction:column;gap:4px;">
          ${rows.map(r => `<div style="font-size:0.85em;color:#2E7D32;">✓ ${escapeHtml(r.filename)} <span style="color:#9AA5B1;">— uploaded ${escapeHtml(r.uploaded_at)}, visible to management</span></div>`).join('')}
        </div>`
      : `<div style="font-size:0.85em;color:#9AA5B1;">Not uploaded yet.</div>`;
    return documentUploadCard(type, employee.id, listHtml);
  }).join('');

  const body = `
    <div class="card">
      <div style="font-weight:700;">My Documents</div>
      <p style="color:#7C8896;font-size:0.85em;margin-bottom:0;">
        Upload your photo and ID/education documents below (each up to 2MB). Once uploaded, these are visible to Admin/Manager only — you won't see a preview or download link here, just confirmation that a file is on file.
      </p>
    </div>
    ${cards}
    ${DOCUMENT_UPLOAD_SCRIPT}`;
  return pageShell(t(lang, 'nav.documents'), employee.id, 'documents', body, user);
}

async function renderAdminEmployeeDocuments(employee, docs, user) {
  const byType = {};
  for (const doc of docs) {
    (byType[doc.doc_type] = byType[doc.doc_type] || []).push(doc);
  }
  const cards = DOCUMENT_TYPES.map(type => {
    const rows = byType[type.key] || [];
    const listHtml = rows.length
      ? `<div style="display:flex;flex-direction:column;gap:4px;">
          ${rows.map(r => `
            <div style="font-size:0.85em;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <a href="/admin/employee/documents/download?id=${r.id}" target="_blank" style="color:#1565C0;text-decoration:none;font-weight:600;">${escapeHtml(r.filename)}</a>
              <span style="color:#9AA5B1;">${formatFileSize(r.size_bytes)} &middot; uploaded by ${escapeHtml(r.uploaded_by)} on ${escapeHtml(r.uploaded_at)}</span>
            </div>`).join('')}
        </div>`
      : `<div style="font-size:0.85em;color:#9AA5B1;">Not uploaded yet.</div>`;
    return documentUploadCard(type, employee.id, listHtml);
  }).join('');

  const body = `
    <div class="card">
      <div style="font-weight:700;">Documents &mdash; ${escapeHtml(employee.name)} (${escapeHtml(employee.id)})</div>
      <a href="/admin/employee/edit?employee_id=${escapeHtml(employee.id)}" style="color:#7C8896;font-size:0.85em;text-decoration:none;">&larr; Back to Edit Employee</a>
    </div>
    ${cards}
    ${DOCUMENT_UPLOAD_SCRIPT}`;
  return pageShell('Employee Documents', '', 'employee-registration', body, user);
}

async function renderReports(monthStr, punchInRows, punchInGrid, workingHours, leaveRows, muster, user) {
  const punchInTableRows = punchInRows.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.name)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(r.id)})</span></td>
      <td>${r.present}</td>
      <td>${r.late}</td>
      <td>${r.halfDay}</td>
      <td>${r.absent}</td>
      <td>${r.totalHours}h</td>
      <td>${r.overtimeHours}h</td>
      <td>${r.missedCheckouts}</td>
      <td>${r.correctionsOverLimit ? `<span style="color:#C62828;font-weight:600;">${escapeHtml(r.correctionsUsed)}</span>` : escapeHtml(r.correctionsUsed)}</td>
    </tr>`).join('') || `<tr><td colspan="9" style="color:#9AA5B1;">No employees</td></tr>`;

  const punchInDayHeaders = Array.from({ length: punchInGrid.daysInMonth }, (_, i) => `<th style="width:78px;">${i + 1}</th>`).join('');
  const punchInGridRows = punchInGrid.rows.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.name)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(r.id)})</span></td>
      ${r.cells.map(c => `<td style="background:${GRID_CELL_COLOR[c.status] || 'transparent'};">${escapeHtml(c.text)}</td>`).join('')}
    </tr>`).join('') || `<tr><td colspan="${punchInGrid.daysInMonth + 1}" style="color:#9AA5B1;">No employees</td></tr>`;

  const workingHoursDayHeaders = Array.from({ length: workingHours.daysInMonth }, (_, i) => `<th style="width:66px;">${i + 1}</th>`).join('');
  const workingHoursRows = workingHours.rows.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.name)}</strong> <span style="color:#9AA5B1;font-weight:400;">(${escapeHtml(r.id)})</span></td>
      ${r.cells.map(c => `<td style="background:${GRID_CELL_COLOR[c.status] || 'transparent'};">${escapeHtml(c.text)}</td>`).join('')}
      <td><strong>${r.total}</strong></td>
    </tr>`).join('') || `<tr><td colspan="${workingHours.daysInMonth + 2}" style="color:#9AA5B1;">No employees</td></tr>`;

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
        P=Present, <span style="background:${GRID_CELL_COLOR['Late']};padding:1px 6px;border-radius:4px;">L=Late</span>, HD=Half Day, MC=Missed Check-out (counts as Half Day), A=Absent, WO=Week Off, H=Holiday, OL=On Leave, AC=Active (in progress), PE=Punch Error.
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
        Each cell is that day's check-in&ndash;check-out (highlighted <span style="background:${GRID_CELL_COLOR['Late']};padding:1px 6px;border-radius:4px;">pink</span> with an "L" prefix if late), or a status code
        on days with no punches: ${Object.entries(MUSTER_STATUS_CODE).map(([k, v]) => `${escapeHtml(v)}=${escapeHtml(k)}`).join(', ')}.
      </p>
      <table class="grid-table"><tr><th>Employee</th>${punchInDayHeaders}</tr>${punchInGridRows}</table>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <div style="font-weight:700;">Hours Worked</div>
        <a href="/admin/reports/hours-worked.csv?month=${escapeHtml(monthStr)}" style="font-size:0.85em;color:#1565C0;text-decoration:none;font-weight:600;">Download CSV &darr;</a>
      </div>
      <p style="color:#7C8896;font-size:0.85em;margin-top:0;">
        Each cell is that day's hours worked (HH:MM, check-in to check-out minus breaks), coloured the same as Punch-In Detail
        (<span style="background:${GRID_CELL_COLOR['Late']};padding:1px 6px;border-radius:4px;">late</span>,
        <span style="background:${GRID_CELL_COLOR['Half Day']};padding:1px 6px;border-radius:4px;">half day</span>).
        <strong>MC</strong> = missed check-out: hours are counted only up to the shift end, and the day counts as a Half Day until a correction is approved.
        Days without a completed check-in/check-out show a status code: WO=Week Off, H=Holiday, OL=On Leave, A=Absent, PE=Punch Error, AC=Active (in progress).
      </p>
      <table class="grid-table"><tr><th>Employee</th>${workingHoursDayHeaders}<th style="width:74px;">Total</th></tr>${workingHoursRows}</table>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <div style="font-weight:700;">Punch-In Summary</div>
        <a href="/admin/reports/punch-in.csv?month=${escapeHtml(monthStr)}" style="font-size:0.85em;color:#1565C0;text-decoration:none;font-weight:600;">Download CSV &darr;</a>
      </div>
      <table><tr><th>Employee</th><th>Present</th><th>Late</th><th>Half Day</th><th>Absent</th><th>Total Hours</th><th>Overtime</th><th>Missed Check-outs</th><th>Corrections Used</th></tr>${punchInTableRows}</table>
      <p style="color:#7C8896;font-size:0.85em;margin-bottom:0;">
        Half Day includes uncorrected missed check-outs. Missed Check-outs counts every day the employee forgot to check out, including ones later corrected.
        Corrections Used counts pending and approved requests against the monthly limit of ${CORRECTION_MONTHLY_LIMIT}; "+ full day" means the one full-day correction is used too.
      </p>
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
      the device.
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
function deviceCommandStatusBadge(c) {
  if (c.status === 'done') return statusBadge('Present', `Done · ${c.punches_received} punch${c.punches_received === 1 ? '' : 'es'} received (${c.punches_new} new)`);
  if (c.status === 'failed') return statusBadge('Absent', `Device returned an error (code ${c.return_code})`);
  if (c.status === 'sent') {
    return minutesSince(c.sent_at) >= DEVICE_COMMAND_TIMEOUT_MINUTES
      ? statusBadge('Absent', 'No reply from device')
      : statusBadge('Active', 'Sent to device, waiting');
  }
  return statusBadge('Upcoming', "Queued for the device's next check-in");
}

async function renderDeviceCard() {
  const sn = CONFIG.ZK_DEVICE_SN;
  if (!sn) {
    return `<div class="card" id="device"><div style="font-weight:700;margin-bottom:6px;">Biometric Device</div>
      <div style="color:#7C8896;font-size:0.9em;">No device serial is set yet (Device serial number, below), so the app isn't accepting anything from the device.</div></div>`;
  }
  const device = await getDeviceStatus(sn);
  const commands = await db.prepare('SELECT * FROM device_commands WHERE sn = ? ORDER BY id DESC LIMIT 10').all(sn);
  const offline = device && isDeviceOffline(device.last_seen);
  const stat = (label, value) => `<div><div style="color:#7C8896;font-size:0.85em;">${label}</div><div style="font-weight:700;">${value}</div></div>`;
  const statusValue = !device
    ? '<span style="color:#7C8896;">Never connected</span>'
    : (offline ? '<span style="color:#C62828;">● Offline</span>' : '<span style="color:#2E7D32;">● Online</span>');
  const lastOutage = device && device.last_outage_start
    ? `${escapeHtml(deviceTimeLabel(device.last_outage_start, true))} → ${escapeHtml(deviceTimeLabel(device.last_outage_end, true))} · ${escapeHtml(formatDuration(minutesSince(device.last_outage_start, new Date(device.last_outage_end.replace(' ', 'T')))))}`
    : 'None recorded';
  const rangeLabel = c => `${escapeHtml(deviceTimeLabel(c.range_start, true))} → ${escapeHtml(deviceTimeLabel(c.range_end, true))}`;
  const commandRows = commands.map(c => `
    <tr>
      <td>${escapeHtml(deviceTimeLabel(c.created_at))}</td>
      <td>${rangeLabel(c)}</td>
      <td>${escapeHtml(c.reason)}</td>
      <td>${deviceCommandStatusBadge(c)}</td>
    </tr>`).join('') || '<tr><td colspan="4" style="color:#9AA5B1;">None yet</td></tr>';
  const today = todayStr();
  return `
    <div class="card" id="device">
      <div style="font-weight:700;margin-bottom:10px;">Biometric Device</div>
      <div style="display:flex;gap:32px;flex-wrap:wrap;margin-bottom:14px;">
        ${stat('Status', statusValue)}
        ${stat('Last heard from', device ? `${escapeHtml(deviceTimeLabel(device.last_seen))} (${minutesSince(device.last_seen) < 1 ? 'just now' : `${escapeHtml(formatDuration(minutesSince(device.last_seen)))} ago`})` : '—')}
        ${stat('Last outage', lastOutage)}
      </div>
      ${device && device.auto_checkout_held ? '<div style="background:#FFF3E0;border-radius:8px;padding:9px 12px;font-size:0.88em;margin-bottom:12px;">The 7 PM auto-checkout is on hold until the device is back and has sent its punches.</div>' : ''}
      <div style="font-weight:700;margin:6px 0;">Re-sync punches from the device</div>
      <p style="color:#7C8896;font-size:0.88em;margin-top:0;">Asks the device to send every punch it has for these dates again. Punches the app already has are skipped, so nothing is counted twice. This also happens automatically whenever the device comes back after being offline for ${DEVICE_OFFLINE_MINUTES}+ minutes.</p>
      <form method="POST" action="/admin/device/resync" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">
        <div><label style="display:block;font-size:0.8em;color:#7C8896;">From</label><input type="date" name="from" required max="${today}" value="${today}" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;"></div>
        <div><label style="display:block;font-size:0.8em;color:#7C8896;">To</label><input type="date" name="to" required max="${today}" value="${today}" style="padding:6px;border-radius:6px;border:1px solid #D0D5DA;"></div>
        <button type="submit" style="padding:8px 16px;border-radius:6px;border:none;background:#1565C0;color:#fff;font-weight:600;cursor:pointer;">Re-sync</button>
      </form>
      <div style="font-weight:700;margin:18px 0 6px;">Recent re-syncs</div>
      <table><tr><th>Requested</th><th>Dates</th><th>Why</th><th>Status</th></tr>${commandRows}</table>
    </div>`;
}

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
    ${await renderDeviceCard()}
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
  const isAdmin = isManagementRole(user);
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

// Employee document uploads (photo, ID proofs, resume, certificates). There is no
// multipart/form-data parser anywhere in this app and deliberately no new dependency
// added for one — the browser base64-encodes the file and posts it as JSON instead,
// which is why the body allowance has to cover both the file itself and base64's
// ~37% size overhead, not just the raw file size.
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024; // 2MB per file, enforced on the decoded size
const MAX_DOCUMENT_UPLOAD_BODY_BYTES = 3 * 1024 * 1024; // covers base64 overhead + JSON wrapper
async function readDocumentUploadBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await bufferBody(req, MAX_DOCUMENT_UPLOAD_BODY_BYTES);
  return raw ? JSON.parse(raw) : {};
}

const DOCUMENT_TYPES = [
  { key: 'photo', label: 'Photo', multiple: false },
  { key: 'aadhaar', label: 'Aadhaar Card', multiple: false },
  { key: 'pan', label: 'PAN Card', multiple: false },
  { key: 'resume', label: 'Resume', multiple: false },
  { key: 'education_certificate', label: 'Education Certificate', multiple: true },
  { key: 'other', label: 'Other', multiple: true },
];
const DOCUMENT_TYPE_KEYS = DOCUMENT_TYPES.map(d => d.key);
const ALLOWED_DOCUMENT_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

// Count of document types this employee hasn't uploaded anything for yet — shown as
// a badge on the "Documents" nav link, same pattern as the notifications count.
async function pendingDocumentCount(employeeId) {
  const rows = await db.prepare('SELECT DISTINCT doc_type FROM employee_documents WHERE employee_id = ?').all(employeeId);
  const uploaded = new Set(rows.map(r => r.doc_type));
  return DOCUMENT_TYPES.filter(t => !uploaded.has(t.key)).length;
}

// --- Sessions: persisted in the sessions table, so a restart (crash, NSSM
// redeploy, power loss) doesn't silently log everyone out. ---
// Deliberately long-lived: this is installed as a PWA and used for daily
// attendance, not signed into fresh each time like a banking app. 30 days idle
// means it stays open as long as the phone is used at least monthly; 90 days
// absolute means even someone who opens it every single day still re-enters
// their password roughly every 3 months — a backstop on how long a lost or
// stolen phone stays signed in even if it is never reported.
const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // sliding: 30 days since last request
const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // hard cap: 90 days since login, regardless of activity
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
  const userRow = await db.prepare('SELECT language, onboarding_seen_version, language_set FROM users WHERE id = ?').get(row.user_id);
  const session = {
    userId: row.user_id, username: row.username, role: row.role, employeeId: row.employee_id,
    createdAt: row.created_at, lastActivityAt: row.last_activity_at,
    language: (userRow && userRow.language) || 'en',
    onboardingSeenVersion: (userRow && userRow.onboarding_seen_version) || 0,
    languageSet: !!(userRow && userRow.language_set),
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
    // defaults to 'biometric') and a logged-in employee's or manager's own browser
    // session (the Punch button) — session auth is restricted below to the caller's own
    // employee_id and source in ('wifi', 'remote') only.
    const apiKey = req.headers['x-api-key'];
    const authorizedViaApiKey = apiKey === CONFIG.PUNCH_API_KEY;
    const sessionUser = authorizedViaApiKey ? null : await getSessionUser(req);
    // Any logged-in account linked to an employee record can punch for itself:
    // employees, and managers (who are registered as employees too).
    const authorizedViaSession = !authorizedViaApiKey && !!sessionUser && !!sessionUser.employeeId;
    if (!authorizedViaApiKey && !authorizedViaSession) {
      logSecurityEvent('punch_auth_failed', { ip: getClientIp(req), hadApiKeyHeader: !!apiKey, hadSession: !!sessionUser });
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

    // Settle what this punch *is* once, before anything is checked against it. A
    // missing field used to fall back differently in different checks here, so
    // omitting it skipped the location check and was then stored as 'biometric' —
    // the most trusted source there is.
    let punchSource = source || (authorizedViaSession ? 'remote' : 'biometric');

    if (authorizedViaSession) {
      if (employee_id !== sessionUser.employeeId) {
        logSecurityEvent('punch_auth_failed', { ip: getClientIp(req), reason: 'session employee_id mismatch', sessionEmployeeId: sessionUser.employeeId, requestedEmployeeId: employee_id });
        return sendJson(res, 403, { error: 'You can only punch your own attendance.' });
      }
      if (!['wifi', 'remote'].includes(punchSource)) {
        return sendJson(res, 403, { error: 'Only office WiFi or remote punches are allowed from a logged-in session.' });
      }
    }

    const employee = await getEmployee(employee_id);
    if (!employee) return sendJson(res, 404, { error: `Unknown employee_id: ${employee_id}` });

    // Already in the office: a remote punch sent from the office network (the page was
    // opened elsewhere, or the WiFi check raced a network switch) is an office punch.
    if (punchSource === 'remote' && isOnOfficeWifi(req)) punchSource = 'wifi';

    // WiFi punch: there's no browser API to check SSID, so "on the office network" is
    // verified by matching the caller's public IP against the configured office IP(s).
    // Not being on it isn't an error: the Punch button falls back to a remote punch.
    if (punchSource === 'wifi' && !isOnOfficeWifi(req)) {
      return sendJson(res, 409, { error: "You're not on the office WiFi.", code: 'not_on_office_wifi' });
    }
    // Remote punches must carry the phone's real coordinates — a typed-in place name
    // can't be verified.
    let coords = null;
    if (punchSource === 'remote') {
      coords = String(location || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (!coords || Math.abs(Number(coords[1])) > 90 || Math.abs(Number(coords[2])) > 180) {
        return sendJson(res, 400, { error: "Punching from outside the office needs your phone's location. Allow location access and try again." });
      }
    }

    const ts = timestamp || formatTimestamp(new Date());
    const dir = direction || await inferPunchDirection(employee_id, ts);
    // Turn the captured "lat,lng" into a readable address so a manager sees a place,
    // not coordinates. Best-effort: never blocks the punch.
    const locationAddress = coords ? await reverseGeocode(coords[1], coords[2]) : '';
    const inserted = await recordPunch(employee_id, ts, dir, punchSource, '', coords ? location : '', marked_by || '', locationAddress);

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
      logSecurityEvent('adms_auth_failed', { ip: getClientIp(req), path: parsed.pathname, sn });
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('unauthorized device');
    }
    await recordDeviceContact(sn);

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
        const counts = await ingestAttlogText(sn, text);
        ingested = counts.ingested;
        duplicates = counts.received - counts.ingested;
      }
      if (ingested > 0) console.log(`[adms] ingested ${ingested} punch(es) from device ${sn}`);
      // The device resends its unacknowledged log on every retry, so a batch
      // showing up again in full (all duplicates) is normal, not an error.
      if (duplicates > 0) console.log(`[adms] skipped ${duplicates} duplicate punch(es) from device ${sn}`);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK');
    }

    // Command polling: hands the device the oldest queued re-sync, if any. With nothing
    // to send, this is also where an auto-checkout held during an outage resumes.
    if (parsed.pathname === '/iclock/getrequest' && req.method === 'GET') {
      const command = await db.prepare("SELECT * FROM device_commands WHERE sn = ? AND status = 'queued' ORDER BY id ASC LIMIT 1").get(sn);
      if (command) {
        const claimed = await db.prepare("UPDATE device_commands SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'queued'")
          .run(formatTimestamp(new Date()), command.id);
        if (claimed.changes) {
          console.log(`[adms] sent command #${command.id} to device ${sn}: ${command.command}`);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end(`C:${command.id}:${command.command}`);
        }
      }
      await resumeHeldAutoCheckout(sn);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK');
    }

    // The device's answer to a command ("ID=12&Return=0&CMD=DATA" per line).
    if (parsed.pathname === '/iclock/devicecmd' && req.method === 'POST') {
      const acks = parseDeviceCmdAcks(await readTextBody(req));
      for (const ack of acks) {
        await db.prepare("UPDATE device_commands SET status = ?, return_code = ?, done_at = ? WHERE id = ? AND sn = ? AND status IN ('queued', 'sent')")
          .run(ack.ok ? 'done' : 'failed', ack.returnCode, formatTimestamp(new Date()), ack.id, sn);
        console.log(`[adms] device ${sn} answered command #${ack.id}: Return=${ack.returnCode}`);
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK');
    }

    // Newer firmwares send a re-sync's records here instead of /iclock/cdata.
    if (parsed.pathname === '/iclock/querydata' && req.method === 'POST') {
      const text = await readTextBody(req);
      const tableName = (parsed.searchParams.get('tablename') || parsed.searchParams.get('table') || '').toUpperCase();
      if (tableName === 'ATTLOG' || tableName === 'TRANSACTION') {
        const cmdId = Number(parsed.searchParams.get('cmdid')) || null;
        const { received, ingested } = await ingestAttlogText(sn, text, cmdId);
        console.log(`[adms] querydata from device ${sn}: ${received} record(s), ${ingested} new`);
      }
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
      logSecurityEvent('cron_auth_failed', { ip: getClientIp(req) });
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
    const outcome = await runScheduledAutoCheckout();
    return sendJson(res, 200, { ok: true, ran: 'auto-checkout', outcome });
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
    // Must be the caller's IP, not the socket's. On Vercel every request arrives from
    // the platform's own proxy, so req.socket.remoteAddress is the same value for
    // everyone — which silently inverts what the rate limit does: the username+IP key
    // collapses to username alone, so anyone on the internet could lock a real user out
    // with five bad attempts, the exact attack the key was chosen to prevent.
    const ip = getClientIp(req) || 'unknown';

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
      'Set-Cookie': `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000)}`,
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
      await db.prepare('UPDATE users SET language = ?, language_set = 1 WHERE id = ?').run(lang, user.userId);
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
    if (isManagementRole(user)) {
      const dateStr = parsed.searchParams.get('date') || todayStr();
      // Single-day snapshot instead of a live computeDayStatus() call per employee —
      // same batching as computeMonthlyStatusGrid, just a one-day range. See
      // createAttendanceSnapshot's comment for why this matters on a network-backed db.
      const snapshot = await createAttendanceSnapshot(dateStr, dateStr, dateStr);
      const rows = await Promise.all(snapshot.employees.map(async employee => ({ employee, status: await snapshot.computeDayStatus(employee.id, dateStr) })));
      // Managers are registered as employees, so they punch like one; the main admin
      // login isn't linked to an employee and gets no card.
      const selfEmployee = user.employeeId ? await getEmployee(user.employeeId) : null;
      const myAttendance = selfEmployee ? { employee: selfEmployee, dayStatus: await computeDayStatus(selfEmployee.id, todayStr()), onOfficeWifi: isOnOfficeWifi(req) } : null;
      const device = CONFIG.ZK_DEVICE_SN ? await getDeviceStatus(CONFIG.ZK_DEVICE_SN) : null;
      const offlineDevice = device && shouldShowOfflineAlert(device.last_seen) ? device : null;
      return sendHtml(res, await renderAdminAttendance(dateStr, rows, user, { basePath: '/dashboard', title: 'Dashboard', activeNav: 'dashboard', showStats: true, myAttendance, offlineDevice }));
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
    const forceOnboardingTour = parsed.searchParams.get('tour') === '1';
    const missedCheckoutDays = await getUncorrectedMissedCheckouts(employeeId);
    return sendHtml(res, await renderDashboard(employee, dayStatus, punches, user, overtimeMinutes, overtimeAuthorized, leaveBalances, breaks, forceOnboardingTour, missedCheckoutDays, isOnOfficeWifi(req)));
  }

  // Marks the current onboarding content as seen — called when the tour finishes
  // (or is skipped) or the "what's new" modal is dismissed. Not called by the
  // ?tour=1 replay, so replaying never marks a real "what's new" as read.
  if (parsed.pathname === '/onboarding/ack' && req.method === 'POST') {
    await db.prepare('UPDATE users SET onboarding_seen_version = ? WHERE id = ?').run(ONBOARDING.CURRENT_VERSION, user.userId);
    return sendJson(res, 200, { ok: true });
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
    if (parsed.searchParams.get('view') === 'company' && isManagementRole(user)) {
      return sendHtml(res, await renderCompanyCalendar(year, month, employeeId, user));
    }
    const employee = await getEmployee(employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    return sendHtml(res, await renderCalendar(employee, year, month, user));
  }

  if (parsed.pathname === '/leave' && req.method === 'GET') {
    if (isManagementRole(user)) {
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
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Only an admin or manager can approve or reject leave.'); }
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
    if (isManagementRole(user)) {
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
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Only an admin or manager can approve or reject permission requests.'); }
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

  if (parsed.pathname === '/corrections' && req.method === 'GET') {
    if (isManagementRole(user)) {
      return sendHtml(res, await renderAdminCorrections(await getAllCorrectionRequests(), user));
    }
    const employeeId = await resolveEmployeeId();
    const employee = await getEmployee(employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    const prefill = { date: parsed.searchParams.get('date') || '', kind: parsed.searchParams.get('kind') || '' };
    return sendHtml(res, await renderCorrections(employee, await getCorrectionRequests(employeeId), user, null, prefill));
  }

  if (parsed.pathname === '/corrections/apply' && req.method === 'POST') {
    // Filed by the employee themselves only — same rule as permission requests.
    if (user.role !== 'employee') { res.writeHead(403); return res.end('Only an employee can request a correction for themselves.'); }
    const employee = await getEmployee(user.employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    const form = await readFormBody(req);
    const kind = form.kind;
    const request = {
      date: (form.date || '').trim(),
      kind,
      check_in_time: kind === 'check_out' ? null : (form.check_in_time || '').trim(),
      check_out_time: kind === 'check_in' ? null : (form.check_out_time || '').trim(),
      reason: (form.reason || '').trim(),
    };
    const error = request.reason ? await validateCorrection(employee, request) : { key: 'corrections.err_reason' };
    if (error) {
      return sendHtml(res, await renderCorrections(employee, await getCorrectionRequests(employee.id), user, error, request));
    }
    await db.prepare(
      'INSERT INTO correction_requests (employee_id, date, kind, check_in_time, check_out_time, reason, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(employee.id, request.date, request.kind, request.check_in_time, request.check_out_time, request.reason, 'pending', formatTimestamp(new Date()));
    res.writeHead(302, { Location: `/corrections?employee_id=${encodeURIComponent(employee.id)}` });
    return res.end();
  }

  if (parsed.pathname === '/corrections/decide' && req.method === 'POST') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Only an admin or manager can approve or reject corrections.'); }
    const form = await readFormBody(req);
    const request = await db.prepare('SELECT * FROM correction_requests WHERE id = ?').get(form.id);
    if (!request) { res.writeHead(404); return res.end('Unknown correction request'); }
    if (request.status !== 'pending') {
      res.writeHead(302, { Location: '/corrections' });
      return res.end();
    }
    const summary = `${request.employee_id}: ${request.kind} on ${request.date} (${correctionTimesText(request, 'en')})`;
    if (form.action === 'approve') {
      const employee = await getEmployee(request.employee_id);
      const error = employee
        ? await validateCorrection(employee, request, { excludeId: request.id, forApproval: true })
        : { key: 'corrections.err_date' };
      if (error) {
        const message = `Can't approve ${employee ? employee.name : request.employee_id}'s correction for ${request.date}: ${t('en', error.key, error.vars)} Reject it instead.`;
        return sendHtml(res, await renderAdminCorrections(await getAllCorrectionRequests(), user, message));
      }
      // Claim the request first so a double-click can't insert the punches twice.
      const claimed = await db.prepare("UPDATE correction_requests SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'")
        .run(formatTimestamp(new Date()), user.username, request.id);
      if (claimed.changes) {
        if (request.check_in_time) await recordPunch(request.employee_id, `${request.date} ${request.check_in_time}:00`, 'in', 'correction', `Correction #${request.id}`, '', user.username);
        if (request.check_out_time) await recordPunch(request.employee_id, `${request.date} ${request.check_out_time}:00`, 'out', 'correction', `Correction #${request.id}`, '', user.username);
        await createNotification(request.employee_id, `Your correction for ${request.date} (${correctionTimesText(request, 'en')}) has been approved.`);
        await logAdminAction(user.username, 'approve', 'correction_request', request.id, summary);
      }
    } else if (form.action === 'reject') {
      const rejected = await db.prepare("UPDATE correction_requests SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'")
        .run(formatTimestamp(new Date()), user.username, request.id);
      if (rejected.changes) {
        await createNotification(request.employee_id, `Your correction for ${request.date} (${correctionTimesText(request, 'en')}) has been rejected.`);
        await logAdminAction(user.username, 'reject', 'correction_request', request.id, summary);
      }
    }
    res.writeHead(302, { Location: '/corrections' });
    return res.end();
  }

  if (parsed.pathname === '/overtime' && req.method === 'GET') {
    if (isManagementRole(user)) {
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
    const isAdmin = isManagementRole(user);
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
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Only an admin or manager can approve or reject overtime requests.'); }
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

  if (parsed.pathname === '/admin/remote-punches' && req.method === 'GET') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
    const punches = await db.prepare(
      `SELECT * FROM punches WHERE source IN (${REMOTE_SOURCE_VALUES.map(() => '?').join(',')}) ORDER BY timestamp DESC LIMIT ?`
    ).all(...REMOTE_SOURCE_VALUES, REMOTE_PUNCH_LOG_LIMIT);
    return sendHtml(res, await renderAdminRemotePunches(punches, user));
  }

  // Retired: on-site duty became remote punching from the Dashboard's Punch button.
  if (parsed.pathname === '/onsite' && req.method === 'GET') {
    res.writeHead(302, { Location: isManagementRole(user) ? '/admin/remote-punches' : '/dashboard' });
    return res.end();
  }

  if (parsed.pathname === '/field-trip' && req.method === 'GET') {
    if (!CONFIG.LOCATIONIQ_API_KEY) { res.writeHead(404); return res.end('Not found'); }
    if (isManagementRole(user)) {
      const trips = await db.prepare('SELECT * FROM field_trips ORDER BY id DESC LIMIT 200').all();
      return sendHtml(res, await renderAdminFieldTrips(trips, user));
    }
    const employeeId = user.employeeId;
    const trips = await db.prepare('SELECT * FROM field_trips WHERE employee_id = ? ORDER BY id DESC LIMIT 20').all(employeeId);
    return sendHtml(res, await renderFieldTrip(employeeId, trips, user));
  }

  if (parsed.pathname === '/field-trip/decide' && req.method === 'POST') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Only an admin or manager can approve or reject field trips.'); }
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
    if (isManagementRole(user)) {
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

  // Retired path (renamed to the fuller Employee Registration form/tab) — redirect
  // so any old bookmark/link still lands somewhere useful.
  if (parsed.pathname === '/admin/add-employee' && req.method === 'GET') {
    res.writeHead(302, { Location: '/admin/employee-registration' });
    return res.end();
  }

  if (parsed.pathname === '/admin/employee-registration' && req.method === 'GET') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
    const createdId = parsed.searchParams.get('created');
    let justCreated = createdId ? await getEmployee(createdId) : null;
    if (justCreated) {
      // Derived from the request itself rather than a fixed constant — this app has no
      // single canonical hostname (custom domain vs. the vercel.app one), so whichever
      // host the admin is actually browsing on is the one the employee should be told.
      const proto = req.headers['x-forwarded-proto'] || 'https';
      justCreated = { ...justCreated, loginUrl: `${proto}://${req.headers.host}` };
    }
    return sendHtml(res, await renderEmployeeRegistration(user, null, justCreated));
  }

  if (parsed.pathname === '/admin/employee-registration' && req.method === 'POST') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
    const form = await readFormBody(req);
    const name = (form.name || '').trim();
    const role = (form.role || '').trim();
    const designation = (form.designation || '').trim();
    const branch = (form.branch || '').trim();
    const reportsTo = (form.reports_to || '').trim();
    const shiftStart = (form.shift_start || '').trim();
    const shiftEnd = (form.shift_end || '').trim();
    const dateJoined = (form.date_joined || '').trim();
    const email = (form.email || '').trim();
    // Defaults to 'employee' on anything unrecognized rather than erroring the whole
    // registration over it — this field only controls in-app permissions, never
    // employment data, so failing safe (least privilege) beats blocking the form.
    const accountRole = ACCOUNT_ROLES.includes(form.account_role) ? form.account_role : 'employee';
    if (!name || !shiftStart || !shiftEnd || !dateJoined) {
      return sendHtml(res, await renderEmployeeRegistration(user, 'Name, shift start, shift end, and date joined are all required.'));
    }
    const mobile = normalizeMobile(form.mobile);
    if (!mobile) {
      return sendHtml(res, await renderEmployeeRegistration(user, 'Enter a valid 10-digit mobile number.'));
    }
    if (email && !isValidEmail(email)) {
      return sendHtml(res, await renderEmployeeRegistration(user, 'Enter a valid email address.'));
    }
    if (role && !EMPLOYMENT_TYPES.includes(role)) {
      return sendHtml(res, await renderEmployeeRegistration(user, 'Unknown role.'));
    }
    if (branch && !CONFIG.BRANCHES.includes(branch)) {
      return sendHtml(res, await renderEmployeeRegistration(user, 'Unknown branch.'));
    }
    if (reportsTo && !(await getEmployee(reportsTo))) {
      return sendHtml(res, await renderEmployeeRegistration(user, 'Unknown "reports to" employee.'));
    }
    // nextEmployeeId() reads the current max and is not atomic with the insert below —
    // two admins registering at once (or one impatient double-tap) can both compute the
    // same id and race to insert it. Rather than let the loser crash with an unhandled
    // UNIQUE constraint error (which the global handler would show as a bare "Something
    // went wrong"), retry with a freshly recomputed id a few times before giving up.
    let id;
    const MAX_ID_RACE_RETRIES = 5;
    for (let attempt = 1; ; attempt++) {
      id = await nextEmployeeId();
      try {
        await db.prepare(
          'INSERT INTO employees (id, name, shift_start, shift_end, date_joined, role, designation, branch, reports_to, mobile, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, name, shiftStart, shiftEnd, dateJoined, role || null, designation || null, branch || null, reportsTo || null, mobile, email || null);
        break;
      } catch (err) {
        const isIdCollision = /unique constraint/i.test(err && err.message || '') && /employees/i.test(err && err.message || '');
        if (!isIdCollision || attempt >= MAX_ID_RACE_RETRIES) {
          if (isIdCollision) {
            return sendHtml(res, await renderEmployeeRegistration(user, 'Another registration just took this employee ID — please try again.'));
          }
          throw err;
        }
        // Loop again with a newly computed id; another INSERT has landed in the meantime.
      }
    }
    for (const type of BALANCE_POOL_LEAVE_TYPES) {
      await db.prepare('INSERT INTO leave_balances (employee_id, leave_type, balance) VALUES (?, ?, ?)').run(id, type, DEFAULT_LEAVE_BALANCE[type]);
    }
    await db.prepare('INSERT INTO users (username, password_hash, role, employee_id, must_change_password) VALUES (?, ?, ?, ?, 1)').run(id, hashPassword('password123'), accountRole, id);
    await logAdminAction(user.username, 'add_employee', 'employee', id, `${name} (${accountRole})`);
    // Back to this form (not straight to the dashboard) so the admin sees the new
    // login details immediately, in the one place they need to copy them from.
    res.writeHead(302, { Location: `/admin/employee-registration?created=${encodeURIComponent(id)}` });
    return res.end();
  }

  if (parsed.pathname === '/admin/employee/reset-password' && req.method === 'POST') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
    const form = await readFormBody(req);
    const employeeId = form.employee_id;
    const employee = await getEmployee(employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    // Same contract as a brand-new account: a known default, forced to change at next
    // login. Also revokes any session the employee currently holds — if the reset was
    // requested because the account is compromised or the phone was lost, leaving an
    // old session alive would defeat the point.
    await db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE employee_id = ?').run(hashPassword('password123'), employeeId);
    await db.prepare('DELETE FROM sessions WHERE employee_id = ?').run(employeeId);
    await logAdminAction(user.username, 'reset_password', 'employee', employeeId, employee.name);
    res.writeHead(302, { Location: `/admin/employee-registration?created=${encodeURIComponent(employeeId)}` });
    return res.end();
  }

  // Two trust levels, same shape as /api/punch: an employee's own logged-in session
  // (restricted below to their own employee_id) or a management session (may specify
  // any employee_id, to upload on someone's behalf). There is no device/API-key path
  // here — this is not something the biometric device or any external system posts to.
  if (parsed.pathname === '/api/employee-documents/upload' && req.method === 'POST') {
    let body;
    try {
      body = await readDocumentUploadBody(req);
    } catch (err) {
      if (err && err.statusCode === 413) return sendJson(res, 413, { error: 'File is too large.' });
      return sendJson(res, 400, { error: 'Invalid request body.' });
    }
    const { employee_id, doc_type, filename, content_type, data_base64 } = body;
    if (!employee_id || !doc_type || !filename || !content_type || !data_base64) {
      return sendJson(res, 400, { error: 'employee_id, doc_type, filename, content_type, and data_base64 are all required.' });
    }
    if (user.role === 'employee') {
      if (employee_id !== user.employeeId) {
        logSecurityEvent('document_upload_auth_failed', { ip: getClientIp(req), reason: 'session employee_id mismatch', sessionEmployeeId: user.employeeId, requestedEmployeeId: employee_id });
        return sendJson(res, 403, { error: 'You can only upload your own documents.' });
      }
    } else if (!isManagementRole(user)) {
      return sendJson(res, 403, { error: 'Admin or manager access only.' });
    }
    if (!DOCUMENT_TYPE_KEYS.includes(doc_type)) {
      return sendJson(res, 400, { error: 'Unknown document type.' });
    }
    if (!ALLOWED_DOCUMENT_CONTENT_TYPES.includes(content_type)) {
      return sendJson(res, 400, { error: 'Only JPEG, PNG, WebP, or PDF files are accepted.' });
    }
    const employee = await getEmployee(employee_id);
    if (!employee) { return sendJson(res, 404, { error: 'Unknown employee.' }); }
    let data;
    try {
      data = Buffer.from(data_base64, 'base64');
    } catch {
      return sendJson(res, 400, { error: 'Could not decode the uploaded file.' });
    }
    // The 3MB body allowance above covers base64 overhead loosely — the real limit
    // that matters is the decoded file size, checked here precisely.
    if (data.length === 0 || data.length > MAX_DOCUMENT_BYTES) {
      return sendJson(res, 413, { error: `File must be between 1 byte and ${Math.floor(MAX_DOCUMENT_BYTES / (1024 * 1024))}MB.` });
    }
    await db.prepare(
      'INSERT INTO employee_documents (employee_id, doc_type, filename, content_type, size_bytes, data, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(employee_id, doc_type, String(filename).slice(0, 255), content_type, data.length, data, user.username, formatTimestamp(new Date()));
    await logAdminAction(user.username, 'upload_document', 'employee', employee_id, `${DOCUMENT_TYPES.find(d => d.key === doc_type).label}: ${filename}`);
    return sendJson(res, 200, { ok: true });
  }

  // Employee's own view — upload only, no view/download of what's already on file
  // (that is deliberately management-only, see /admin/employee/documents below).
  if (parsed.pathname === '/documents' && req.method === 'GET') {
    if (user.role !== 'employee') { res.writeHead(403); return res.end("This page is for an employee's own documents."); }
    const employee = await getEmployee(user.employeeId);
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    const existing = await db.prepare('SELECT doc_type, filename, uploaded_at FROM employee_documents WHERE employee_id = ? ORDER BY uploaded_at DESC').all(user.employeeId);
    return sendHtml(res, await renderEmployeeDocuments(employee, existing, user));
  }

  // Management view — the only place any of these files can actually be seen again.
  if (parsed.pathname === '/admin/employee/documents' && req.method === 'GET') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
    const employee = await getEmployee(parsed.searchParams.get('employee_id'));
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    const docs = await db.prepare('SELECT id, doc_type, filename, content_type, size_bytes, uploaded_by, uploaded_at FROM employee_documents WHERE employee_id = ? ORDER BY uploaded_at DESC').all(employee.id);
    return sendHtml(res, await renderAdminEmployeeDocuments(employee, docs, user));
  }

  if (parsed.pathname === '/admin/employee/documents/download' && req.method === 'GET') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
    const doc = await db.prepare('SELECT * FROM employee_documents WHERE id = ?').get(parsed.searchParams.get('id'));
    if (!doc) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': doc.content_type,
      'Content-Length': doc.size_bytes,
      // inline (not attachment) so an image/PDF opens in the browser tab rather than
      // forcing a download dialog; the filename still comes along either way.
      'Content-Disposition': `inline; filename="${String(doc.filename).replace(/"/g, '')}"`,
    });
    return res.end(Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data));
  }

  if (parsed.pathname === '/admin/employee/edit' && req.method === 'GET') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
    const employee = await getEmployee(parsed.searchParams.get('employee_id'));
    if (!employee) { res.writeHead(404); return res.end('Unknown employee'); }
    return sendHtml(res, await renderEditEmployee(employee, user));
  }

  if (parsed.pathname === '/admin/employee/edit' && req.method === 'POST') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
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
    const email = (form.email || '').trim();
    if (!name || !shiftStart || !shiftEnd || !dateJoined) {
      return sendHtml(res, await renderEditEmployee(employee, user, 'Name, shift start, shift end, and date joined are all required.'));
    }
    const mobile = normalizeMobile(form.mobile);
    if (!mobile) {
      return sendHtml(res, await renderEditEmployee(employee, user, 'Enter a valid 10-digit mobile number.'));
    }
    if (email && !isValidEmail(email)) {
      return sendHtml(res, await renderEditEmployee(employee, user, 'Enter a valid email address.'));
    }
    if (role && !EMPLOYMENT_TYPES.includes(role)) {
      return sendHtml(res, await renderEditEmployee(employee, user, 'Unknown role.'));
    }
    // Also accepts the value already on file for this employee, even if it has since
    // been renamed or removed from the configured list — otherwise editing any other
    // field on this employee (or just re-saving the form untouched) would be blocked
    // with "Unknown branch." until the admin manually picks a currently-valid one.
    if (branch && branch !== employee.branch && !CONFIG.BRANCHES.includes(branch)) {
      return sendHtml(res, await renderEditEmployee(employee, user, 'Unknown branch.'));
    }
    if (reportsTo === employeeId) {
      return sendHtml(res, await renderEditEmployee(employee, user, 'An employee cannot report to themselves.'));
    }
    if (reportsTo && !(await getEmployee(reportsTo))) {
      return sendHtml(res, await renderEditEmployee(employee, user, 'Unknown "reports to" employee.'));
    }
    const currentAccountRole = await accountRoleForEmployee(employeeId);
    // Same "absent or invalid keeps the current value" rule as branch above — an old
    // cached form or a stray request without this field must not silently demote
    // someone, since account_role governs what the employee's login can do.
    const accountRole = ACCOUNT_ROLES.includes(form.account_role) ? form.account_role : currentAccountRole;
    await db.prepare(
      'UPDATE employees SET name = ?, shift_start = ?, shift_end = ?, date_joined = ?, role = ?, designation = ?, branch = ?, reports_to = ?, mobile = ?, email = ? WHERE id = ?'
    ).run(name, shiftStart, shiftEnd, dateJoined, role || null, designation || null, branch || null, reportsTo || null, mobile, email || null, employeeId);
    if (accountRole !== currentAccountRole) {
      await db.prepare('UPDATE users SET role = ? WHERE employee_id = ?').run(accountRole, employeeId);
      // Session role is copied in at login time, not re-read per request — without this,
      // the old permission level would keep working until the account's next login.
      await db.prepare('DELETE FROM sessions WHERE employee_id = ?').run(employeeId);
      await logAdminAction(user.username, 'change_account_role', 'employee', employeeId, `${name}: ${currentAccountRole} -> ${accountRole}`);
    }
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
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
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
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
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
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
    const { year, month, monthStr } = parseMonthParam(parsed);
    const [statusGrid, leaveRows] = await Promise.all([computeMonthlyStatusGrid(year, month), computeLeaveReport(year, month)]);
    const punchInRows = computePunchInReport(statusGrid);
    const punchInGrid = computePunchInGrid(statusGrid);
    const workingHours = computeWorkingHoursGrid(statusGrid);
    const muster = computeMusterReport(statusGrid);
    return sendHtml(res, await renderReports(monthStr, punchInRows, punchInGrid, workingHours, leaveRows, muster, user));
  }

  if (parsed.pathname === '/admin/reports/hours-worked.csv' && req.method === 'GET') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
    const { year, month, monthStr } = parseMonthParam(parsed);
    const grid = computeWorkingHoursGrid(await computeMonthlyStatusGrid(year, month));
    const dayHeaders = Array.from({ length: grid.daysInMonth }, (_, i) => String(i + 1));
    const csv = toCsv(
      ['Employee ID', 'Name', ...dayHeaders, 'Total'],
      grid.rows.map(r => [r.id, r.name, ...r.cells.map(c => c.text), r.total])
    );
    await logAdminAction(user.username, 'download_report', 'hours_worked_report', monthStr, '');
    return sendCsv(res, `hours-worked-${monthStr}.csv`, csv);
  }

  if (parsed.pathname === '/admin/reports/punch-in.csv' && req.method === 'GET') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
    const { year, month, monthStr } = parseMonthParam(parsed);
    const rows = computePunchInReport(await computeMonthlyStatusGrid(year, month));
    const csv = toCsv(
      ['Employee ID', 'Name', 'Present', 'Late', 'Half Day', 'Absent', 'Total Hours Worked', 'Overtime Hours', 'Missed Check-outs', 'Corrections Used'],
      rows.map(r => [r.id, r.name, r.present, r.late, r.halfDay, r.absent, r.totalHours, r.overtimeHours, r.missedCheckouts, r.correctionsUsed])
    );
    await logAdminAction(user.username, 'download_report', 'punch_in_report', monthStr, '');
    return sendCsv(res, `punch-in-report-${monthStr}.csv`, csv);
  }

  if (parsed.pathname === '/admin/reports/punch-in-detail.csv' && req.method === 'GET') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
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
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
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
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
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
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
    return sendHtml(res, await renderAdminSettings(user));
  }

  if (parsed.pathname === '/admin/device/resync' && req.method === 'POST') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
    const form = await readFormBody(req);
    const from = (form.from || '').trim();
    const to = (form.to || '').trim();
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
    let error = null;
    if (!CONFIG.ZK_DEVICE_SN) error = 'Set the device serial number first.';
    else if (!isDate(from) || !isDate(to)) error = 'Choose a From and To date.';
    else if (from > to) error = 'From must be on or before To.';
    else if (to > todayStr()) error = "To can't be in the future.";
    // Keeps one reply from the device to a manageable size.
    else if ((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000 > 31) error = 'Re-sync at most 31 days at a time.';
    if (error) return sendHtml(res, await renderAdminSettings(user, { error }));
    await queueDeviceResync(CONFIG.ZK_DEVICE_SN, `${from} 00:00:00`, `${to} 23:59:59`, `Manual (${user.username})`, user.username);
    await logAdminAction(user.username, 'device_resync', 'device', CONFIG.ZK_DEVICE_SN, `${from} to ${to}`);
    return sendHtml(res, await renderAdminSettings(user, { notice: `Re-sync for ${from} to ${to} requested. The device picks it up the next time it checks in (about every 30 seconds while it's online).` }));
  }

  if (parsed.pathname === '/admin/settings' && req.method === 'POST') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
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
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
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
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
    return sendHtml(res, await renderDevicePins(user));
  }

  if (parsed.pathname === '/admin/set-device-pin' && req.method === 'POST') {
    if (!isManagementRole(user)) { res.writeHead(403); return res.end('Admin or manager access only.'); }
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
  console.log(`[inbound] ${req.method} ${req.url} from ${getClientIp(req)}`);
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
