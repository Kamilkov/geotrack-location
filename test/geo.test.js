const { test } = require('node:test');
const assert = require('node:assert/strict');
const { haversineM, circleToWkt, prepareZones, zoneOf } = require('../srv/lib/geo');

test('haversine: 1 degree of latitude is ~111.2 km', () => {
  const d = haversineM({ lat: 42, lon: 1 }, { lat: 43, lon: 1 });
  assert.ok(Math.abs(d - 111195) < 200, String(d));
});

test('haversine: same point is 0', () => {
  assert.equal(haversineM({ lat: 42.5, lon: 1.6 }, { lat: 42.5, lon: 1.6 }), 0);
});

test('circleToWkt: closed ring of n+1 points, every vertex at the radius', () => {
  const wkt = circleToWkt(42.50, 1.50, 300, 36);
  assert.ok(wkt.startsWith('POLYGON(('));
  const pts = wkt.slice(9, -2).split(', ').map((p) => p.split(' ').map(Number));
  assert.equal(pts.length, 37);
  assert.deepEqual(pts[0], pts[36]);
  for (const [lon, lat] of pts) {
    const d = haversineM({ lat: 42.50, lon: 1.50 }, { lat, lon });
    assert.ok(Math.abs(d - 300) < 0.5, String(d));
  }
});

// Zone rows as the handler's SELECT returns them (WKT from GEOM.ST_AsWKT(): HANA writes "POLYGON ((", and may hand back a Buffer).
const circle = (ID, lat, lon, r, isPrivate = false) => ({ ID, KIND: 'circle', RADIUSM: r, ISPRIVATE: isPrivate, CENTRELAT: String(lat), CENTRELON: String(lon), WKT: Buffer.from(circleToWkt(lat, lon, r).replace('POLYGON((', 'POLYGON ((')) });
const polygon = (ID, wkt, isPrivate = false) => ({ ID, KIND: 'polygon', RADIUSM: null, ISPRIVATE: isPrivate, CENTRELAT: null, CENTRELON: null, WKT: wkt });
const TRIANGLE = 'POLYGON ((1.5 42.5006, 1.4992 42.4994, 1.5008 42.4994, 1.5 42.5006))'; // ~70 m around 42.50/1.50

test('zoneOf: inside one circle, outside everything', () => {
  const zones = prepareZones([circle('A', 42.5, 1.5, 100)]);
  assert.equal(zoneOf(42.5003, 1.5003, zones)?.ID, 'A'); // ~40 m from the centre
  assert.equal(zoneOf(42.502, 1.5, zones), null); // ~220 m north
});

test('zoneOf: findZone precedence — private over public, polygon over circle, smallest circle', () => {
  const zones = prepareZones([
    circle('big', 42.5, 1.5, 500), circle('small', 42.5, 1.5, 100), polygon('tri', TRIANGLE),
    circle('pubAtB', 42.6, 1.6, 100), circle('privAtB', 42.6, 1.6, 300, true),
  ]);
  assert.equal(zoneOf(42.5, 1.5, zones).ID, 'tri'); // inside all three: the polygon wins even though larger circles contain it
  assert.equal(zoneOf(42.5, 1.5011, zones).ID, 'small'); // ~90 m east: outside the triangle, inside both circles → smaller
  assert.equal(zoneOf(42.5, 1.504, zones).ID, 'big'); // ~330 m east
  assert.equal(zoneOf(42.6, 1.6, zones).ID, 'privAtB'); // private beats the smaller public circle
  assert.equal(zoneOf(42.6, 1.6, zones).isPrivate, true);
});

test('zoneOf: holes and MULTIPOLYGON by the even-odd rule', () => {
  const holed = 'POLYGON ((1.49 42.49, 1.51 42.49, 1.51 42.51, 1.49 42.51, 1.49 42.49), (1.499 42.499, 1.501 42.499, 1.501 42.501, 1.499 42.501, 1.499 42.499))';
  const multi = 'MULTIPOLYGON (((1.49 42.49, 1.495 42.49, 1.495 42.495, 1.49 42.49)), ((1.505 42.505, 1.51 42.505, 1.51 42.51, 1.505 42.505)))';
  const h = prepareZones([polygon('holed', holed)]), m = prepareZones([polygon('multi', multi)]);
  assert.equal(zoneOf(42.495, 1.495, h)?.ID, 'holed');
  assert.equal(zoneOf(42.5, 1.5, h), null); // in the hole
  assert.equal(zoneOf(42.491, 1.494, m)?.ID, 'multi');
  assert.equal(zoneOf(42.506, 1.509, m)?.ID, 'multi');
  assert.equal(zoneOf(42.5, 1.5, m), null);
});

test('prepareZones: a private zone without a centre throws; centres become numbers', () => {
  assert.throws(() => prepareZones([polygon('p', TRIANGLE, true)]), /no centre/);
  const [z] = prepareZones([circle('A', 42.5, 1.5, 100, true)]);
  assert.deepEqual([z.centreLat, z.centreLon, z.isPrivate], [42.5, 1.5, true]);
  assert.equal(prepareZones([{ ...circle('B', 42.5, 1.5, 100), ISPRIVATE: 1 }])[0].isPrivate, true); // HANA may answer 1/0
});

test('prepareZones: a private zone whose geometry parses to nothing fails closed; a public one does not', () => {
  assert.throws(() => prepareZones([{ ...circle('home', 42.5, 1.5, 100, true), WKT: null }]), /no usable geometry/);
  assert.throws(() => prepareZones([{ ...circle('home', 42.5, 1.5, 100, true), WKT: {} }]), /no usable geometry/);
  const [z] = prepareZones([{ ...circle('pub', 42.5, 1.5, 100, false), WKT: null }]);
  assert.equal(zoneOf(42.5, 1.5, [z]), null);
});
