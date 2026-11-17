'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// server.js builds its database client at import time, so give it a throwaway URL.
// Requiring it starts no listener — that's behind `require.main === module`.
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || 'file::memory:';
const { apiReadScope, API_EMPLOYEE_FIELDS } = require('../server');

test('nobody gets a read without the punch key or a session', () => {
  assert.equal(apiReadScope(), null);
  assert.equal(apiReadScope({}), null);
  assert.equal(apiReadScope({ authorizedViaApiKey: false, user: null }), null);
});

test('the punch API key reads every employee', () => {
  assert.deepEqual(apiReadScope({ authorizedViaApiKey: true }), { all: true });
  // The key is the device's, not a person's, so a session is never consulted with it.
  assert.deepEqual(apiReadScope({ authorizedViaApiKey: true, user: { role: 'employee', employeeId: 'EMP-002' } }), { all: true });
});

test('admins and managers read every employee', () => {
  for (const role of ['admin', 'manager']) {
    assert.deepEqual(apiReadScope({ user: { role, employeeId: 'EMP-001' } }), { all: true });
  }
});

test('an employee is confined to their own record', () => {
  assert.deepEqual(apiReadScope({ user: { role: 'employee', employeeId: 'EMP-007' } }), { employeeId: 'EMP-007' });
});

test('a session with no employee behind it reads nothing', () => {
  // The bootstrap admin login isn't linked to an employee; a non-management account
  // in that state has no record of its own to be scoped to, so it gets no read.
  assert.equal(apiReadScope({ user: { role: 'employee', employeeId: null } }), null);
});

test('the employee payload never carries the biometric device PIN', () => {
  const fields = API_EMPLOYEE_FIELDS.split(',').map(f => f.trim());
  assert.ok(!fields.includes('device_pin'));
  assert.ok(fields.includes('id') && fields.includes('name'));
});
