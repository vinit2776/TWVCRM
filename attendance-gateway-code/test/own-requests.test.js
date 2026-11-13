'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// server.js builds its database client at import time, so give it a throwaway URL.
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || 'file::memory:';
const {
  selfServiceEmployeeId, canFileOwnRequests, ownsRequest, ownPagePath,
  decideCellHtml, ownRequestTabsHtml, asOwnView,
} = require('../server');

const manager = { role: 'manager', username: 'priya', employeeId: 'TWV-007' };
const admin = { role: 'admin', username: 'ravi', employeeId: 'TWV-002' };
const mainAdmin = { role: 'admin', username: 'admin', employeeId: null };
const employee = { role: 'employee', username: 'arjun', employeeId: 'TWV-010' };

test('admins and managers on the employee list can file their own requests', () => {
  assert.equal(selfServiceEmployeeId(manager), 'TWV-007');
  assert.equal(selfServiceEmployeeId(admin), 'TWV-002');
  assert.equal(canFileOwnRequests(manager), true);
  assert.equal(canFileOwnRequests(admin), true);
  assert.equal(canFileOwnRequests(employee), true);
});

test('the main admin login, with no employee record, cannot file anything', () => {
  assert.equal(selfServiceEmployeeId(mainAdmin), null);
  assert.equal(canFileOwnRequests(mainAdmin), false);
  assert.equal(selfServiceEmployeeId(employee), null, 'employees use their own page, not My requests');
  assert.equal(canFileOwnRequests(null), false);
});

test('nobody owns a request that is not theirs; ids compare as strings', () => {
  assert.equal(ownsRequest(manager, { employee_id: 'TWV-007' }), true);
  assert.equal(ownsRequest(admin, { employee_id: 'TWV-007' }), false);
  assert.equal(ownsRequest(mainAdmin, { employee_id: 'TWV-007' }), false);
  assert.equal(ownsRequest({ role: 'manager', employeeId: 7 }, { employee_id: '7' }), true);
  assert.equal(ownsRequest(manager, null), false);
});

test('a person sees no Approve/Reject on their own row, others do', () => {
  const row = { id: 3, employee_id: 'TWV-007' };
  const own = decideCellHtml(manager, row, '/leave/decide', { id: 3 });
  assert.match(own, /Your request/);
  assert.doesNotMatch(own, /<form/);
  const other = decideCellHtml(admin, row, '/leave/decide', { id: 3 });
  assert.match(other, /action="\/leave\/decide"/);
  assert.match(decideCellHtml(mainAdmin, row, '/leave/decide', { id: 3 }), /value="approve"/);
});

test('after filing, management lands on My requests and employees on their page', () => {
  assert.equal(ownPagePath(asOwnView(manager), '/leave', 'TWV-007'), '/leave?mine=1');
  assert.equal(ownPagePath(employee, '/leave', 'TWV-010'), '/leave?employee_id=TWV-010');
});

test('Team approvals / My requests tabs only for management with an employee record', () => {
  assert.match(ownRequestTabsHtml(manager, 'leave'), /href="\/leave\?mine=1"/);
  assert.match(ownRequestTabsHtml(asOwnView(manager), 'notifications'), /Mine/);
  assert.equal(ownRequestTabsHtml(mainAdmin, 'leave'), '');
  assert.equal(ownRequestTabsHtml(employee, 'leave'), '');
  assert.equal(ownRequestTabsHtml(manager, 'dashboard'), '');
});
