'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLatLng, distanceMeters, isWithinOffice, branchAt, isBranchDeviation, MULTI_BRANCH } = require('../geofence');

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
