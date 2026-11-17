'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanNote, ordinal, earlierAttempts, reapplyError, decisionNoteSuffix, NOTE_MAX_LENGTH } = require('../request-notes');

test('cleanNote requires a few characters of real text and trims it', () => {
  assert.deepEqual(cleanNote('  Approved, Arjun covers  '), { value: 'Approved, Arjun covers' });
  assert.deepEqual(cleanNote(''), { error: 'notes.err_required' });
  assert.deepEqual(cleanNote('   '), { error: 'notes.err_required' });
  assert.deepEqual(cleanNote('ok'), { error: 'notes.err_required' });
  assert.deepEqual(cleanNote(undefined), { error: 'notes.err_required' });
  assert.deepEqual(cleanNote('x'.repeat(NOTE_MAX_LENGTH + 1)), { error: 'notes.err_too_long' });
  assert.equal(cleanNote('x'.repeat(NOTE_MAX_LENGTH)).value.length, NOTE_MAX_LENGTH);
});

test('ordinal labels attempts', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
});

test('earlierAttempts walks back to the first request, oldest first', async () => {
  const rows = {
    1: { id: 1, previous_request_id: null },
    2: { id: 2, previous_request_id: 1 },
    3: { id: 3, previous_request_id: 2 },
  };
  const chain = await earlierAttempts(rows[3], id => rows[id]);
  assert.deepEqual(chain.map(r => r.id), [1, 2]);
  assert.deepEqual(await earlierAttempts(rows[1], id => rows[id]), []);
});

test('earlierAttempts stops at a missing link or a loop', async () => {
  const missing = { id: 5, previous_request_id: 4 };
  assert.deepEqual(await earlierAttempts(missing, () => undefined), []);
  const rows = { 7: { id: 7, previous_request_id: 8 }, 8: { id: 8, previous_request_id: 7 } };
  const chain = await earlierAttempts(rows[7], async id => rows[id]);
  assert.deepEqual(chain.map(r => r.id), [8]);
});

test('reapplyError allows only the employee\'s own rejected request, once', () => {
  const rejected = { id: 1, employee_id: 'EMP-001', status: 'rejected' };
  assert.equal(reapplyError(rejected, 'EMP-001', false), null);
  assert.equal(reapplyError(rejected, 'EMP-002', false), 'notes.err_reapply_unknown');
  assert.equal(reapplyError(undefined, 'EMP-001', false), 'notes.err_reapply_unknown');
  assert.equal(reapplyError({ ...rejected, status: 'pending' }, 'EMP-001', false), 'notes.err_reapply_not_rejected');
  assert.equal(reapplyError({ ...rejected, status: 'approved' }, 'EMP-001', false), 'notes.err_reapply_not_rejected');
  assert.equal(reapplyError(rejected, 'EMP-001', true), 'notes.err_reapply_done');
});

test('decisionNoteSuffix quotes the note for the notification', () => {
  assert.equal(decisionNoteSuffix('Need a handover plan', 'priya'), ' priya\'s note: "Need a handover plan"');
  assert.equal(decisionNoteSuffix('Fine', ''), ' Note: "Fine"');
  assert.equal(decisionNoteSuffix('', 'priya'), '');
});
