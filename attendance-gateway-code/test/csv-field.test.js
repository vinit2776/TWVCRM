'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// server.js builds its database client at import time, so give it a throwaway URL.
// Requiring it starts no listener — that's behind `require.main === module`.
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || 'file::memory:';
const { csvField, sendCsv } = require('../server');

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

// --- sendCsv -------------------------------------------------------------

function captureCsv(body) {
  const sent = {};
  sendCsv({ writeHead: (code, headers) => { sent.code = code; sent.headers = headers; },
            end: (chunk) => { sent.body = chunk; } }, 'report.csv', body);
  return sent;
}

test('csv: the response carries a UTF-8 BOM so Excel reads it as UTF-8', () => {
  const sent = captureCsv('Employee ID,Name\r\nEMP-001,Priya\r\n');
  assert.ok(Buffer.isBuffer(sent.body), 'body is a Buffer, so the BOM survives as bytes');
  assert.deepStrictEqual(sent.body.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
});

test('csv: a BOM-aware reader still sees the first header, not the BOM', () => {
  const sent = captureCsv('Employee ID,Name\r\n');
  assert.strictEqual(sent.body.toString('utf8').replace(/^\ufeff/, '').split(',')[0], 'Employee ID');
});

test('csv: non-ASCII names survive the round trip', () => {
  const sent = captureCsv('Employee ID,Name\r\nEMP-001,\u0baa\u0bbf\u0bb0\u0bbf\u0baf\u0bbe\r\n');
  assert.ok(sent.body.toString('utf8').includes('\u0baa\u0bbf\u0bb0\u0bbf\u0baf\u0bbe'));
});

test('csv: Content-Length counts the BOM, not just the text', () => {
  // A length computed from the string alone would be 3 bytes short and truncate
  // the last characters of the file.
  const text = 'a,b\r\n';
  const sent = captureCsv(text);
  assert.strictEqual(sent.headers['Content-Length'], Buffer.byteLength(text, 'utf8') + 3);
});
