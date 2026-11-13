'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// server.js builds its database client at import time, so give it a throwaway URL.
// Requiring it starts no listener — that's behind `require.main === module`.
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || 'file::memory:';
const { SETTING_DEFS, hidesValue } = require('../server');

// Saving a setting records its old and new value in the activity log, which is
// readable in-app and exported to CSV. Every setting therefore has to be classified,
// and this list is the classification: adding a setting fails this test until someone
// decides which side it belongs on.
const VALUES_RECORDED = [
  'OFFICE_RADIUS_METERS',
  'DEVICE_CLOCK_OFFSET_MINUTES',
  'LOCATIONIQ_BASE_URL',
  'PLACES_COUNTRY',
  'PLACES_VIEWBOX',
  'REPORT_EMAILS',
  'REPORT_EMAIL_FROM',
  'SHIFT_RULES_EFFECTIVE_FROM',
];

// The credentials. ZK_DEVICE_SN is one too: the ADMS push protocol has no header
// authentication, so that serial alone is what lets a caller write punches for anyone.
const VALUES_NEVER_RECORDED = [
  'PUNCH_API_KEY',
  'LOCATIONIQ_API_KEY',
  'RESEND_API_KEY',
  'ZK_DEVICE_SN',
];

test('every setting is classified as loggable or not', () => {
  assert.deepEqual(SETTING_DEFS.map(d => d.key).sort(),
    [...VALUES_RECORDED, ...VALUES_NEVER_RECORDED].sort(),
    'a new setting must be added to one of the two lists in this test');
});

test('no credential\'s value can be written to the activity log', () => {
  for (const key of VALUES_NEVER_RECORDED) {
    const def = SETTING_DEFS.find(d => d.key === key);
    assert.ok(hidesValue(def), `${key} would have its value recorded`);
  }
});

test('ordinary settings do record what they changed from and to', () => {
  for (const key of VALUES_RECORDED) {
    const def = SETTING_DEFS.find(d => d.key === key);
    assert.equal(hidesValue(def), false, `${key} is not a credential`);
  }
});

test('hiding a value and hiding a field are separate decisions', () => {
  // The serial has to stay readable on the settings page — a wrong one silently drops
  // real punches, so an admin checks it against the device — while never being
  // written down. That is what logValue is for, and why it is not just `secret`.
  const sn = SETTING_DEFS.find(d => d.key === 'ZK_DEVICE_SN');
  assert.equal(sn.secret, undefined, 'the serial is shown in the form, not masked');
  assert.equal(hidesValue(sn), true, 'but its value is never recorded');

  // A secret is hidden in both senses, with no need to say so twice.
  const key = SETTING_DEFS.find(d => d.key === 'PUNCH_API_KEY');
  assert.equal(key.secret, true);
  assert.equal(key.logValue, undefined);
  assert.equal(hidesValue(key), true);

  assert.equal(hidesValue({}), false);
  assert.equal(hidesValue({ logValue: false }), true);
  assert.equal(hidesValue({ secret: true }), true);
});
