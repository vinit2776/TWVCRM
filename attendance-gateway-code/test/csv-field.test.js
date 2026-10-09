'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// server.js builds its database client at import time, so give it a throwaway URL.
// Requiring it starts no listener — that's behind `require.main === module`.
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || 'file::memory:';
const { csvField } = require('../server');

test('csv: ordinary values pass through untouched', () => {
  assert.strictEqual(csvField('Priya Raman'), 'Priya Raman');
  assert.strictEqual(csvField('09:12'), '09:12');
  assert.strictEqual(csvField(480), '480');
  assert.strictEqual(csvField("O'Brien"), "O'Brien");
  assert.strictEqual(csvField('2+2'), '2+2'); // the + isn't leading
});

test('csv: null and undefined become empty, not the words', () => {
  assert.strictEqual(csvField(null), '');
  assert.strictEqual(csvField(undefined), '');
});

test('csv: quotes, commas and newlines are still quoted and escaped', () => {
  assert.strictEqual(csvField('Name, with comma'), '"Name, with comma"');
  assert.strictEqual(csvField('Say "hi"'), '"Say ""hi"""');
  assert.strictEqual(csvField('two\nlines'), '"two\nlines"');
});

test('csv: a leading = + - @ is neutralised so Excel treats it as text', () => {
  // Employee names reach every report as typed. Without this, a name entered as
  // =HYPERLINK(...) runs when someone opens the export.
  assert.strictEqual(csvField('=HYPERLINK("http://x","Click")'), '"\'=HYPERLINK(""http://x"",""Click"")"');
  assert.strictEqual(csvField('+1234567890'), "'+1234567890");
  assert.strictEqual(csvField('-50'), "'-50");
  assert.strictEqual(csvField('@channel'), "'@channel");
  assert.strictEqual(csvField('=cmd|calc!A0'), "'=cmd|calc!A0");
});

test('csv: a leading tab or CR is neutralised too', () => {
  assert.strictEqual(csvField('\tTabbed'), "'\tTabbed");
  assert.strictEqual(csvField('\rCarriage'), '"\'\rCarriage"');
});
