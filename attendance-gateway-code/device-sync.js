'use strict';

// Pure helpers for keeping biometric punches safe when the office PC running the
// relay (or the office internet) is off. The device keeps every punch in its own
// memory and retries, but the app needs to notice the outage, ask the device to
// resend that period once it's back, and hold the 19:00 auto-checkout meanwhile.
// Kept out of server.js so they can be unit-tested without a database.

// The device polls /iclock/getrequest every ~30s (Delay=30), even when nobody punches,
// so this much silence means it can't reach the app.
const DEVICE_OFFLINE_MINUTES = 15;
// The dashboard warning only shows during office hours: [start, end).
const DEVICE_ALERT_START_HOUR = 8;
const DEVICE_ALERT_END_HOUR = 20;
// A re-sync sent to the device but never acknowledged is given up on after this.
const DEVICE_COMMAND_TIMEOUT_MINUTES = 10;
// An automatic re-sync starts this long before the device was last heard from, so a
// punch made just before the outage (and not yet pushed) is included.
const RESYNC_OVERLAP_MINUTES = 10;

function pad(n) { return String(n).padStart(2, '0'); }
function formatTs(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function parseTs(ts) {
  const [d, t = '00:00:00'] = ts.split(' ');
  const [y, mo, day] = d.split('-').map(Number);
  const [h, mi, s = 0] = t.split(':').map(Number);
  return new Date(y, mo - 1, day, h, mi, s);
}
function shiftTs(ts, minutes) {
  const d = parseTs(ts);
  d.setMinutes(d.getMinutes() + minutes);
  return formatTs(d);
}
function minutesSince(ts, now = new Date()) {
  return (now.getTime() - parseTs(ts).getTime()) / 60000;
}

// "47 min", "14h 53m", "2d 3h" — for outage lengths in messages and the Settings card.
function formatDuration(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

function isDeviceOffline(lastSeen, now = new Date()) {
  return !!lastSeen && minutesSince(lastSeen, now) >= DEVICE_OFFLINE_MINUTES;
}
function shouldShowOfflineAlert(lastSeen, now = new Date()) {
  const hour = now.getHours();
  return isDeviceOffline(lastSeen, now) && hour >= DEVICE_ALERT_START_HOUR && hour < DEVICE_ALERT_END_HOUR;
}

// One ATTLOG record. Two shapes are accepted: the plain push format
// "<PIN>\t<YYYY-MM-DD HH:MM:SS>\t..." and the key=value format some firmwares use
// when answering a DATA QUERY ("transaction pin=1\ttime=2026-10-05 09:30:00\t...").
function parseAttlogLine(line) {
  const trimmed = String(line).trim();
  if (!trimmed) return null;
  const fields = trimmed.split('\t');
  if (fields.some(f => f.includes('='))) {
    const kv = {};
    for (const f of fields) {
      const eq = f.indexOf('=');
      if (eq === -1) continue;
      const key = f.slice(0, eq).trim().split(/\s+/).pop().toLowerCase();
      kv[key] = f.slice(eq + 1).trim();
    }
    const pin = kv.pin || kv.userid;
    const timestamp = kv.time || kv.checktime;
    return pin && timestamp ? { pin, timestamp } : null;
  }
  const [pin, timestamp] = fields;
  return pin && timestamp ? { pin: pin.trim(), timestamp: timestamp.trim() } : null;
}

// Body of POST /iclock/devicecmd: one "ID=12&Return=0&CMD=DATA" line per command.
// Return >= 0 is success (some firmwares put a record count there); negative is an error.
function parseDeviceCmdAcks(text) {
  return String(text).split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const params = new URLSearchParams(l);
    const id = Number(params.get('ID'));
    const returnCode = params.get('Return');
    return Number.isInteger(id) && id > 0 ? { id, returnCode, ok: returnCode != null && Number(returnCode) >= 0 } : null;
  }).filter(Boolean);
}

// The ZKTeco push-protocol command asking the device to upload its attendance log
// for a time range again. Times are in the device's own clock.
function buildAttlogQuery(startTs, endTs) {
  return `DATA QUERY ATTLOG StartTime=${startTs}\tEndTime=${endTs}`;
}

module.exports = {
  DEVICE_OFFLINE_MINUTES,
  DEVICE_ALERT_START_HOUR,
  DEVICE_ALERT_END_HOUR,
  DEVICE_COMMAND_TIMEOUT_MINUTES,
  RESYNC_OVERLAP_MINUTES,
  shiftTs,
  minutesSince,
  formatDuration,
  isDeviceOffline,
  shouldShowOfflineAlert,
  parseAttlogLine,
  parseDeviceCmdAcks,
  buildAttlogQuery,
};
