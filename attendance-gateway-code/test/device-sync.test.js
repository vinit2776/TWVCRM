'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isDeviceOffline, shouldShowOfflineAlert, formatDuration, parseAttlogLine, parseDeviceCmdAcks, buildAttlogQuery, shiftTs,
} = require('../device-sync');

const at = (ts) => { const [d, t] = ts.split(' '); const [y, mo, day] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return new Date(y, mo - 1, day, h, mi, 0); };

test('offline: 35+ minutes since the device was last heard from', () => {
  assert.equal(isDeviceOffline('2026-10-06 10:00:00', at('2026-10-06 10:34')), false);
  assert.equal(isDeviceOffline('2026-10-06 10:00:00', at('2026-10-06 10:35')), true);
});

test('offline: one late 15-minute check-in is not an outage', () => {
  assert.equal(isDeviceOffline('2026-10-06 10:00:00', at('2026-10-06 10:31')), false);
});

test('offline: a device never heard from is not treated as offline', () => {
  assert.equal(isDeviceOffline(null, at('2026-10-06 10:00')), false);
});

test('alert: only during office hours (08:00-20:00)', () => {
  assert.equal(shouldShowOfflineAlert('2026-10-06 06:00:00', at('2026-10-06 07:59')), false);
  assert.equal(shouldShowOfflineAlert('2026-10-06 06:00:00', at('2026-10-06 08:00')), true);
  assert.equal(shouldShowOfflineAlert('2026-10-06 18:00:00', at('2026-10-06 19:59')), true);
  assert.equal(shouldShowOfflineAlert('2026-10-06 18:00:00', at('2026-10-06 20:00')), false);
});

test('ATTLOG: plain push format', () => {
  assert.deepEqual(parseAttlogLine('1\t2026-10-05 09:30:00\t0\t1\t0\t0'), { pin: '1', timestamp: '2026-10-05 09:30:00' });
});

test('ATTLOG: key=value query-reply format', () => {
  assert.deepEqual(parseAttlogLine('transaction cardno=\tpin=12\tverified=1\ttime=2026-10-05 18:31:02\tstatus=1'), { pin: '12', timestamp: '2026-10-05 18:31:02' });
});

test('ATTLOG: blank or incomplete lines are skipped', () => {
  assert.equal(parseAttlogLine('   '), null);
  assert.equal(parseAttlogLine('1'), null);
});

test('devicecmd acks: success, record count, and errors', () => {
  assert.deepEqual(parseDeviceCmdAcks('ID=3&Return=0&CMD=DATA\nID=4&Return=17&CMD=DATA\nID=5&Return=-1&CMD=DATA\n'), [
    { id: 3, returnCode: '0', ok: true },
    { id: 4, returnCode: '17', ok: true },
    { id: 5, returnCode: '-1', ok: false },
  ]);
});

test('re-sync command and time shifting', () => {
  assert.equal(buildAttlogQuery('2026-10-05 17:52:00', '2026-10-06 08:55:00'), 'DATA QUERY ATTLOG StartTime=2026-10-05 17:52:00\tEndTime=2026-10-06 08:55:00');
  assert.equal(shiftTs('2026-10-06 00:05:00', -10), '2026-10-05 23:55:00');
});

test('durations read naturally', () => {
  assert.equal(formatDuration(47), '47 min');
  assert.equal(formatDuration(893), '14h 53m');
  assert.equal(formatDuration(3060), '2d 3h');
});
