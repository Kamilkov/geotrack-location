const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coarsen } = require('../srv/lib/coarsen');

const row = { device: 'iphone', lat: 42.501234, lon: 1.501234, accuracy: 5, ssid: 'HomeNet', raw: JSON.stringify({ _type: 'location', lat: 42.501234, lon: 1.501234, tst: 1, acc: 5, SSID: 'HomeNet', BSSID: 'aa:bb:cc:dd:ee:ff' }) };
const zone = { ID: 'z1', ISPRIVATE: true, CENTRELAT: '42.500000', CENTRELON: '1.500000' };

test('private zone: coordinates replaced by centre, raw stripped, flag set, zone kept', () => {
  const r = coarsen(row, zone);
  assert.equal(r.lat, 42.5); assert.equal(r.lon, 1.5);
  assert.equal(r.isCoarsened, true); assert.equal(r.zone_ID, 'z1');
  const raw = JSON.parse(r.raw);
  assert.equal(raw.lat, undefined); assert.equal(raw.lon, undefined); assert.equal(raw.acc, 5);
  assert.equal(row.lat, 42.501234, 'input not mutated');
});

test('private zone: Wi-Fi identity removed too (a BSSID is geolocatable)', () => {
  const r = coarsen(row, zone);
  const raw = JSON.parse(r.raw);
  assert.equal(raw.BSSID, undefined); assert.equal(raw.SSID, undefined);
  assert.equal(r.ssid, null);
  assert.equal(row.ssid, 'HomeNet', 'input not mutated');
});

test('non-private zone: only zone_ID set', () => {
  const r = coarsen(row, { ID: 'z2', ISPRIVATE: false, CENTRELAT: '0', CENTRELON: '0' });
  assert.equal(r.lat, 42.501234); assert.equal(r.isCoarsened, false); assert.equal(r.zone_ID, 'z2');
  assert.equal(r.ssid, 'HomeNet'); assert.match(r.raw, /BSSID/);
});

test('no zone: unchanged apart from defaults', () => {
  const r = coarsen(row, null);
  assert.equal(r.zone_ID, null); assert.equal(r.isCoarsened, false); assert.equal(r.lat, 42.501234);
});

test('private zone with no centre: throws instead of coarsening to (0,0)', () => {
  assert.throws(
    () => coarsen(row, { ID: 'z3', ISPRIVATE: true, CENTRELAT: null, CENTRELON: null }),
    /private zone z3 has no centre; cannot coarsen/,
  );
});

test('coarsening keeps the motion activities', () => {
  const r = coarsen({ ...row, activities: 'walking' }, zone);
  assert.equal(r.isCoarsened, true);
  assert.equal(r.activities, 'walking');
});
