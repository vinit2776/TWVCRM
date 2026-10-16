'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseLatLng, distanceMeters, isWithinOffice, branchAt, isBranchDeviation, MULTI_BRANCH,
  renameEmployeeBranch, renameEmployeeBranches,
} = require('../geofence');

const OFFICE = { lat: 13.06184, lng: 80.24674 };

test('parse: "lat, lng" with or without spaces', () => {
  assert.deepEqual(parseLatLng('13.06184, 80.24674'), OFFICE);
  assert.deepEqual(parseLatLng(' 13.06184,80.24674 '), OFFICE);
});

test('parse: anything that is not a real coordinate pair is rejected', () => {
  assert.equal(parseLatLng(''), null);
  assert.equal(parseLatLng(null), null);
  assert.equal(parseLatLng('Office, Chennai'), null);
  assert.equal(parseLatLng('91, 80'), null);
  assert.equal(parseLatLng('13, 181'), null);
});

test('distance: about 111 m per 0.001 degree of latitude', () => {
  const d = distanceMeters(OFFICE, { lat: OFFICE.lat + 0.001, lng: OFFICE.lng });
  assert.ok(Math.abs(d - 111.2) < 1, `got ${d}`);
});

test('office: punches from the office itself are inside a 150 m radius', () => {
  // The two Punch-button punches made at the office on 12-13 Oct 2026.
  assert.equal(isWithinOffice({ lat: 13.06182, lng: 80.24672 }, OFFICE, 150), true);
  assert.equal(isWithinOffice({ lat: 13.06185, lng: 80.24675 }, OFFICE, 150), true);
});

test('office: a punch a few km away is outside', () => {
  assert.equal(isWithinOffice({ lat: 13.03921, lng: 80.24678 }, OFFICE, 150), false);
});

test('office: the radius edge is inclusive', () => {
  const p = { lat: OFFICE.lat + 0.001, lng: OFFICE.lng };
  const d = distanceMeters(OFFICE, p);
  assert.equal(isWithinOffice(p, OFFICE, d), true);
  assert.equal(isWithinOffice(p, OFFICE, d - 1), false);
});

test('office: with no office location or no point, nothing is inside', () => {
  assert.equal(isWithinOffice(OFFICE, null, 150), false);
  assert.equal(isWithinOffice(null, OFFICE, 150), false);
  assert.equal(isWithinOffice(OFFICE, OFFICE, 0), false);
});

const BRANCHES = [
  { name: 'T. Nagar', location: OFFICE },
  { name: 'Velachery', location: { lat: 12.97950, lng: 80.21800 } },
  { name: 'No location yet', location: null },
];

test('branch: a punch at a branch finds it; away from all of them, none', () => {
  assert.equal(branchAt({ lat: 13.06182, lng: 80.24672 }, BRANCHES, 150).name, 'T. Nagar');
  assert.equal(branchAt({ lat: 12.97960, lng: 80.21810 }, BRANCHES, 150).name, 'Velachery');
  assert.equal(branchAt({ lat: 13.03921, lng: 80.24678 }, BRANCHES, 150), null);
});

test('branch: with overlapping radii the nearest branch wins', () => {
  const close = [
    { name: 'A', location: { lat: 13.0000, lng: 80.0000 } },
    { name: 'B', location: { lat: 13.0010, lng: 80.0000 } },
  ];
  assert.equal(branchAt({ lat: 13.0007, lng: 80.0000 }, close, 150).name, 'B');
  assert.equal(branchAt({ lat: 13.0003, lng: 80.0000 }, close, 150).name, 'A');
});

test('branch: the employee\'s own branch wins whenever they are within its radius', () => {
  // Two branches 22 m apart in one building, as LGF and Arcade Center are: GPS put
  // this LGF punch 1.3 m nearer Arcade Center.
  const sameBuilding = [
    { name: 'LGF', location: { lat: 13.061981804658464, lng: 80.24683335350925 } },
    { name: 'Arcade Center', location: { lat: 13.061978981125167, lng: 80.24662440563422 } },
  ];
  const punch = { lat: 13.06182, lng: 80.24672 };
  assert.equal(branchAt(punch, sameBuilding, 150).name, 'Arcade Center');
  assert.equal(branchAt(punch, sameBuilding, 150, 'LGF').name, 'LGF');
  assert.equal(branchAt(punch, sameBuilding, 150, 'Arcade Center').name, 'Arcade Center');
});

test('branch: outside their own branch\'s radius, the nearest branch still counts', () => {
  assert.equal(branchAt({ lat: 13.06182, lng: 80.24672 }, BRANCHES, 150, 'Velachery').name, 'T. Nagar');
  assert.equal(branchAt({ lat: 13.03921, lng: 80.24678 }, BRANCHES, 150, 'T. Nagar'), null);
  // An own branch that isn't configured, or has no location, falls back to nearest.
  assert.equal(branchAt({ lat: 13.06182, lng: 80.24672 }, BRANCHES, 150, 'Gone').name, 'T. Nagar');
  assert.equal(branchAt({ lat: 13.06182, lng: 80.24672 }, [{ name: 'X' }, ...BRANCHES], 150, 'X').name, 'T. Nagar');
});

test('deviation: only a single-branch employee at another branch', () => {
  assert.equal(isBranchDeviation('T. Nagar', 'Velachery'), true);
  assert.equal(isBranchDeviation('T. Nagar', 'T. Nagar'), false);
  assert.equal(isBranchDeviation(MULTI_BRANCH, 'Velachery'), false);
  assert.equal(isBranchDeviation(null, 'Velachery'), false);
  assert.equal(isBranchDeviation('', 'Velachery'), false);
  assert.equal(isBranchDeviation('T. Nagar', ''), false);
});

test('employee branches: one name, all of them, or a JSON list of a few', () => {
  const { employeeBranches, employeeBranchValue } = require('../geofence');
  assert.deepEqual(employeeBranches('LGF'), { all: false, names: ['LGF'] });
  assert.deepEqual(employeeBranches(MULTI_BRANCH), { all: true, names: [] });
  assert.deepEqual(employeeBranches('["LGF","Arcade Center"]'), { all: false, names: ['LGF', 'Arcade Center'] });
  assert.deepEqual(employeeBranches(null), { all: false, names: [] });
  assert.deepEqual(employeeBranches('[not json'), { all: false, names: ['[not json'] });
  assert.equal(employeeBranchValue(['LGF']), 'LGF');
  assert.equal(employeeBranchValue(['LGF', 'Arcade Center', 'LGF']), '["LGF","Arcade Center"]');
  assert.equal(employeeBranchValue([]), null);
});

test('employee branches: label and rename', () => {
  const { employeeBranchLabel, renameEmployeeBranch } = require('../geofence');
  assert.equal(employeeBranchLabel('["LGF","Arcade Center"]'), 'LGF, Arcade Center');
  assert.equal(employeeBranchLabel(MULTI_BRANCH), 'All branches');
  assert.equal(employeeBranchLabel(null), '');
  assert.equal(renameEmployeeBranch('["LGF","Arcade Center"]', 'LGF', 'LGF Floor'), '["LGF Floor","Arcade Center"]');
  assert.equal(renameEmployeeBranch('LGF', 'LGF', 'LGF Floor'), 'LGF Floor');
  assert.equal(renameEmployeeBranch('Perungudi', 'LGF', 'LGF Floor'), 'Perungudi');
  assert.equal(renameEmployeeBranch(MULTI_BRANCH, 'LGF', 'LGF Floor'), MULTI_BRANCH);
});

test('deviation: only at a branch outside an employee\'s selected few', () => {
  const few = '["T. Nagar","Velachery"]';
  assert.equal(isBranchDeviation(few, 'Velachery'), false);
  assert.equal(isBranchDeviation(few, 'T. Nagar'), false);
  assert.equal(isBranchDeviation(few, 'Perungudi'), true);
});

test('branch: any of an employee\'s selected branches within radius wins over a nearer other one', () => {
  const sameBuilding = [
    { name: 'LGF', location: { lat: 13.061981804658464, lng: 80.24683335350925 } },
    { name: 'Arcade Center', location: { lat: 13.061978981125167, lng: 80.24662440563422 } },
    { name: 'Kamala Arcade', location: { lat: 13.056436446421618, lng: 80.25594272871878 } },
  ];
  const punch = { lat: 13.06182, lng: 80.24672 };
  assert.equal(branchAt(punch, sameBuilding, 150, '["Kamala Arcade","LGF"]').name, 'LGF');
  assert.equal(branchAt(punch, sameBuilding, 150, '["Kamala Arcade","Arcade Center"]').name, 'Arcade Center');
  assert.equal(branchAt(punch, sameBuilding, 150, MULTI_BRANCH).name, 'Arcade Center');
});

test('rename: several branches renamed in one save are applied in a single pass', () => {
  // Branch renames land as one map, not one call after another. Applying A->B and then
  // B->A in sequence would move an employee at A to B and straight back to A; the
  // branches table already guards the same swap with its two-pass __renaming__ step.
  const swap = new Map([['LGF', 'Arcade Center'], ['Arcade Center', 'LGF']]);
  assert.equal(renameEmployeeBranches('LGF', swap), 'Arcade Center');
  assert.equal(renameEmployeeBranches('Arcade Center', swap), 'LGF');
  assert.equal(renameEmployeeBranches('["LGF","Perungudi"]', swap), '["Arcade Center","Perungudi"]');

  // Renaming two of an employee's three branches at once.
  const two = new Map([['LGF', 'LGF Floor'], ['Perungudi', 'Perungudi Annexe']]);
  assert.equal(
    renameEmployeeBranches('["LGF","Arcade Center","Perungudi"]', two),
    '["LGF Floor","Arcade Center","Perungudi Annexe"]',
  );

  // Untouched values come back as they were, so nothing needless is written.
  const raw = '["LGF","Arcade Center"]';
  assert.equal(renameEmployeeBranches(raw, new Map([['Perungudi', 'Elsewhere']])), raw);
  assert.equal(renameEmployeeBranches(MULTI_BRANCH, swap), MULTI_BRANCH);
  assert.equal(renameEmployeeBranches(null, swap), null);
  // The single-branch helper still behaves, and drops to one name when it should.
  assert.equal(renameEmployeeBranch('["LGF","Arcade Center"]', 'LGF', 'LGF Floor'), '["LGF Floor","Arcade Center"]');
  assert.equal(renameEmployeeBranch('LGF', 'LGF', 'LGF Floor'), 'LGF Floor');
});
