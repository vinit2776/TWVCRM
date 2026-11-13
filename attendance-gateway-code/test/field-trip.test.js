'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanStops, routePoints, directionsCoords, parseRouteLegs, parseRate, validateRate, parseMaxStops, validateMaxStops,
  reimbursement, formatInr, cleanTripDate, cleanPhotos, tripStops, googleMapsUrl, MAX_PHOTO_BYTES,
} = require('../field-trip');

test('cleanStops keeps picked coordinates and leaves typed stops for geocoding', () => {
  const r = cleanStops([
    { address: ' The Work Villa — LGF ', lat: '13.0418', lon: '80.2341' },
    { address: 'Sharma Traders' },
  ]);
  assert.deepEqual(r.stops, [
    { address: 'The Work Villa — LGF', lat: 13.0418, lon: 80.2341 },
    { address: 'Sharma Traders' },
  ]);
});

test('cleanStops refuses too few, empty, too many and out-of-range stops', () => {
  assert.ok(cleanStops([{ address: 'Only one' }]).error);
  assert.ok(cleanStops('nope').error);
  assert.match(cleanStops([{ address: 'A' }, { address: '  ' }]).error, /Stop 2 is empty/);
  const eleven = Array.from({ length: 11 }, (_, i) => ({ address: `Place ${i}` }));
  assert.match(cleanStops(eleven, 10).error, /at most 10/);
  assert.equal(cleanStops(eleven, 12).stops.length, 11);
  assert.equal(cleanStops(Array.from({ length: 21 }, (_, i) => ({ address: `P${i}` })), 50).error, 'A trip can have at most 20 stops.');
  // Bad coordinates are dropped, so the server geocodes the address instead of routing to nowhere.
  assert.deepEqual(cleanStops([{ address: 'A', lat: 200, lon: 80 }, { address: 'B', lat: 13, lon: 'x' }]).stops, [{ address: 'A' }, { address: 'B' }]);
});

test('routePoints adds the first stop again for a round trip', () => {
  const stops = [{ address: 'A', lat: 1, lon: 2 }, { address: 'B', lat: 3, lon: 4 }];
  assert.deepEqual(routePoints(stops, false).map(s => s.address), ['A', 'B']);
  assert.deepEqual(routePoints(stops, true).map(s => s.address), ['A', 'B', 'A']);
  assert.equal(directionsCoords(routePoints(stops, true)), '2,1;4,3;2,1');
});

test('parseRouteLegs reads each leg and the total from the directions response', () => {
  const data = { code: 'Ok', routes: [{ distance: 27845, duration: 3720, legs: [{ distance: 9120 }, { distance: 12400 }, { distance: 6325 }] }] };
  assert.deepEqual(parseRouteLegs(data, 4), { distanceKm: 27.85, legsKm: [9.12, 12.4, 6.33], durationSec: 3720 });
  assert.throws(() => parseRouteLegs({ code: 'NoRoute' }, 2), /No driving route/);
  assert.throws(() => parseRouteLegs(data, 3), /incomplete route/);
});

test('rate setting: 0 or junk switches amounts off; validation bounds', () => {
  assert.equal(parseRate('8'), 8);
  assert.equal(parseRate('7.255'), 7.26);
  assert.equal(parseRate('0'), 0);
  assert.equal(parseRate('abc'), 0);
  assert.equal(validateRate('0'), null);
  assert.equal(validateRate('12.5'), null);
  assert.ok(validateRate('-1'));
  assert.ok(validateRate('101'));
  assert.ok(validateRate('ten'));
});

test('max stops setting', () => {
  assert.equal(parseMaxStops('5'), 5);
  assert.equal(parseMaxStops('99'), 20);
  assert.equal(parseMaxStops('1'), 10);
  assert.equal(validateMaxStops('2'), null);
  assert.ok(validateMaxStops('21'));
  assert.ok(validateMaxStops('3.5'));
});

test('reimbursement is distance times rate to the paisa, or null with no rate', () => {
  assert.equal(reimbursement(27.85, 8), 222.8);
  assert.equal(reimbursement(9.2, 7.5), 69);
  assert.equal(reimbursement(10.333, 3), 31);
  assert.equal(reimbursement(12, 0), null);
  assert.equal(reimbursement(12, null), null);
  assert.equal(formatInr(222.8), '₹222.80');
  assert.equal(formatInr(1500), '₹1,500');
  assert.equal(formatInr(null), '');
});

test('cleanTripDate allows today back to a week, never the future', () => {
  assert.deepEqual(cleanTripDate('', '2026-11-12'), { value: '2026-11-12' });
  assert.deepEqual(cleanTripDate('2026-11-05', '2026-11-12'), { value: '2026-11-05' });
  assert.match(cleanTripDate('2026-11-04', '2026-11-12').error, /7 days/);
  assert.match(cleanTripDate('2026-11-13', '2026-11-12').error, /future/);
  assert.ok(cleanTripDate('12/11/2026', '2026-11-12').error);
  // Across a month boundary.
  assert.deepEqual(cleanTripDate('2026-11-26', '2026-12-03'), { value: '2026-11-26' });
});

test('cleanPhotos checks type, size, count and the required setting', () => {
  const jpeg = { filename: 'receipt.jpg', content_type: 'image/jpeg', data_base64: Buffer.from('fake-jpeg').toString('base64') };
  const ok = cleanPhotos([jpeg]);
  assert.equal(ok.photos.length, 1);
  assert.equal(ok.photos[0].data.toString(), 'fake-jpeg');
  assert.deepEqual(cleanPhotos([]), { photos: [] });
  assert.match(cleanPhotos([], { required: true }).error, /at least one photo/);
  assert.match(cleanPhotos([{ ...jpeg, content_type: 'application/pdf' }]).error, /JPEG, PNG or WebP/);
  assert.match(cleanPhotos(Array(7).fill(jpeg)).error, /at most 6/);
  const big = { ...jpeg, data_base64: Buffer.alloc(MAX_PHOTO_BYTES + 1).toString('base64') };
  assert.match(cleanPhotos([big]).error, /too large/);
  assert.ok(cleanPhotos([{ ...jpeg, data_base64: '<script>' }]).error);
  assert.equal(cleanPhotos([{ ...jpeg, filename: 'a"b\r\n.jpg' }]).photos[0].filename, 'ab.jpg');
});

test('tripStops reads stored stops, falling back to from/to on older trips', () => {
  assert.deepEqual(tripStops({ stops: '[{"address":"A","km":0},{"address":"B","km":4.2}]' }).map(s => s.km), [0, 4.2]);
  assert.deepEqual(tripStops({ stops: null, from_address: 'Office', to_address: 'Bank' }), [{ address: 'Office' }, { address: 'Bank' }]);
  assert.deepEqual(tripStops({ stops: 'not json', from_address: 'X', to_address: 'Y' }).map(s => s.address), ['X', 'Y']);
});

test('googleMapsUrl routes through the same points', () => {
  const stops = [{ address: 'A', lat: 13.04, lon: 80.23 }, { address: 'Sharma Traders, Phase 2' }];
  assert.equal(googleMapsUrl(stops, false), 'https://www.google.com/maps/dir/13.04,80.23/Sharma%20Traders%2C%20Phase%202');
  assert.equal(googleMapsUrl(stops, true), 'https://www.google.com/maps/dir/13.04,80.23/Sharma%20Traders%2C%20Phase%202/13.04,80.23');
});
