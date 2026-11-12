'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// server.js builds its database client at import time, so give it a throwaway URL.
// Requiring it starts no listener — that's behind `require.main === module`.
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || 'file::memory:';
const { SETTING_DEFS_BY_KEY } = require('../server');
const { LAUNCH_DATE, BRANCH_SHIFT_RULES_FROM } = require('../attendance-logic');

const def = SETTING_DEFS_BY_KEY.SHIFT_RULES_EFFECTIVE_FROM;

test('the cut-off setting ships as the date the branch rules went live', () => {
  assert.equal(def.fallback, BRANCH_SHIFT_RULES_FROM);
  assert.equal(def.validate(BRANCH_SHIFT_RULES_FROM), null);
  assert.equal(def.validate(LAUNCH_DATE), null); // applying the rules to all of history is allowed
});

test('the cut-off setting refuses anything that is not a usable date', () => {
  for (const bad of ['', 'soon', '2026-13-45', '11/12/2026', '2026-11-1', '2026-11-12T00:00']) {
    assert.match(String(def.validate(bad)), /date/i, `expected ${bad} to be refused`);
  }
  // Before the gateway existed there is nothing to re-measure, and a date that early is
  // more likely a typo than an intention.
  assert.match(String(def.validate('2020-01-01')), /launch date/);
});

test('a stored value that somehow got past validation falls back, never to an unusable date', () => {
  assert.equal(def.parse('2026-12-01'), '2026-12-01');
  for (const bad of ['', 'soon', null, undefined, '2026-11-1']) {
    assert.equal(def.parse(bad), BRANCH_SHIFT_RULES_FROM);
  }
});
