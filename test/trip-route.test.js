'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stitch, thin, lengthM, computeTripRoute, refreshTripRoute } = require('../srv/lib/trip-route');
const { haversineM } = require('../srv/lib/geo');

// Synthetic line near 42.50/1.50 heading north: 0.0001° of latitude is about 11.1 m.
const T0 = Date.UTC(2026, 8, 22, 10, 0, 0);
const pt = (sec, k, lon = 1.5) => {
  const lat = +(42.5 + k * 0.0001).toFixed(6);
  return { t: T0 + sec * 1000, lat, lon, wkt: `${lon} ${lat}` };
};
const secs = (points) => points.map((p) => (p.t - T0) / 1000);
const every = (from, to, step, k = (s) => s / 10) => Array.from({ length: (to - from) / step + 1 }, (_, i) => pt(from + i * step, k(from + i * step)));

test('stitch: without Watch points the phone line is the line', () => {
  const phone = [pt(0, 0), pt(300, 5), pt(600, 10)];
  assert.deepEqual(stitch(phone, []), { points: phone, source: 'phone' });
  assert.deepEqual(stitch([], []), { points: [], source: 'phone' });
});

test('stitch: a Watch route over the whole trip replaces every phone point', () => {
  const phone = [pt(0, 0), pt(300, 30), pt(600, 60)], watch = every(0, 600, 1);
  const line = stitch(phone, watch);
  assert.equal(line.source, 'watch');
  assert.deepEqual(line.points, watch);
  assert.equal(lengthM(line.points), lengthM(watch));
});

test('stitch: a workout that starts mid-trip keeps the phone points before it, in time order', () => {
  const phone = [pt(0, 0), pt(300, 30), pt(600, 60), pt(900, 90)], watch = every(600, 900, 10);
  const line = stitch(phone, watch);
  assert.equal(line.source, 'mixed');
  assert.deepEqual(secs(line.points), [0, 300, ...secs(watch)]);
});

test('stitch: phone points inside a gap of the Watch route are kept', () => {
  const watch = [...every(0, 100, 10), ...every(220, 400, 10)];
  const line = stitch([pt(50, 5), pt(160, 16), pt(300, 30)], watch);
  assert.equal(line.source, 'mixed');
  assert.deepEqual(secs(line.points).filter((s) => s > 100 && s < 220), [160]);
  assert.equal(line.points.length, watch.length + 1);
});

test('stitch: a phone point 30 s from the nearest Watch point is dropped, at 31 s it is kept', () => {
  const watch = [pt(100, 10)];
  assert.deepEqual(secs(stitch([pt(70, 7), pt(130, 13)], watch).points), [100]);
  assert.deepEqual(secs(stitch([pt(69, 7), pt(131, 13)], watch).points), [69, 100, 131]);
  assert.equal(stitch([pt(70, 7)], watch).source, 'watch');
  assert.equal(stitch([pt(69, 7)], watch).source, 'mixed');
});

test('stitch: two workouts recording the same seconds keep every point, ordered by time', () => {
  const watch = [pt(0, 0), pt(1, 1), pt(1, 1, 1.6), pt(2, 2), pt(2, 2, 1.6)];
  const line = stitch([], watch);
  assert.equal(line.points.length, 5);
  assert.deepEqual(secs(line.points), [0, 1, 1, 2, 2]);
});

test('coarsened ends: a repeated zone centre adds no length and thins to one point at each end', () => {
  const centre = (sec) => pt(sec, 0);
  const watch = [centre(0), centre(1), centre(2), ...every(3, 60, 1, (s) => 30 + s), centre(61), centre(62)];
  assert.equal(lengthM([centre(0), centre(1), centre(2)]), 0);
  const drawn = thin(watch);
  assert.deepEqual([drawn[0].lat, drawn[1].lat !== drawn[0].lat], [42.5, true]);
  assert.deepEqual([drawn.at(-1).lat, drawn.at(-2).lat !== 42.5], [42.5, true]);
});

test('thin: first point and end of the line kept, no step under the minimum except the last', () => {
  const line = every(0, 100, 1, (s) => s / 10); // 1.1 m steps
  const drawn = thin(line, 5);
  assert.deepEqual([drawn[0], drawn.at(-1)], [line[0], line.at(-1)]);
  const steps = drawn.slice(1).map((p, i) => haversineM(drawn[i], p));
  assert.ok(steps.slice(0, -1).every((m) => m >= 5), 'a step under 5 m before the last');
  assert.ok(drawn.length < line.length / 3);
  assert.deepEqual(thin([pt(0, 0), pt(1, 0), pt(2, 0)]), [pt(0, 0)]);
  assert.deepEqual(thin([]), []);
});

test('an eight-hour route stitches and thins', () => {
  const watch = every(0, 28799, 1, (s) => s / 20); // 28,800 points, 0.55 m apart
  const line = stitch([pt(0, 0), pt(14000, 700), pt(28799, 1440)], watch);
  assert.equal(line.points.length, 28800);
  const drawn = thin(line.points);
  assert.ok(drawn.length > 1000 && drawn.length < 4000, `thinned to ${drawn.length}`);
  assert.ok(Math.abs(lengthM(drawn) - lengthM(line.points)) < 1, 'a straight line keeps its length');
});

/** A transaction that answers the reads of computeTripRoute and records everything it was asked. */
function fakeTx({ trip, watch = [], phone = [], line = { L: null, W: null } } = {}) {
  const reads = [], writes = [];
  const run = async (sql, params) => {
    if (/^UPDATE/.test(sql)) { writes.push({ sql, params }); return { changes: 1 }; }
    reads.push({ sql, params });
    if (/FROM GEOTRACK_TRIPS/.test(sql)) return trip ? [trip] : [];
    if (/FROM GEOTRACK_WORKOUTROUTE/.test(sql)) return watch;
    if (/FROM DUMMY/.test(sql)) return [line];
    if (/FROM GEOTRACK_POSITIONS/.test(sql)) return phone;
    throw new Error(`unexpected statement: ${sql}`);
  };
  return { run, reads, writes };
}
// Rows as HANA returns them: offset-less UTC timestamps, decimals as text.
const TRIP = { DEVICE: 'smoke', STARTEDAT: '2026-09-22T10:00:00.000', ENDEDAT: '2026-09-22T11:00:00.000', POINTCOUNT: 3, LENGTHSOURCE: 'phone' };
const row = (time, lat, lon = '1.500000') => ({ TS: `2026-09-22T${time}.000`, LAT: lat, LON: lon });
const SETTINGS = { maxAccuracyM: 100 };

test('computeTripRoute: nothing to write for an open or a missing trip', async () => {
  for (const trip of [{ ...TRIP, ENDEDAT: null }, undefined]) {
    const tx = fakeTx({ trip, watch: [row('10:10:00', '42.500100')] });
    assert.equal(await refreshTripRoute(tx, 'T1', SETTINGS, { atClose: true }), null);
    assert.deepEqual(tx.writes, []);
  }
});

test('computeTripRoute: a phone trip is computed at its close and left alone afterwards', async () => {
  const line = { L: 1234, W: Buffer.from('LINESTRING(1.5 42.5, 1.5 42.6, 1.5 42.7)') };
  const later = fakeTx({ trip: TRIP, line });
  assert.equal(await refreshTripRoute(later, 'T1', SETTINGS), null);
  assert.deepEqual(later.writes, []);

  const close = fakeTx({ trip: TRIP, line });
  const r = await refreshTripRoute(close, 'T1', SETTINGS, { atClose: true });
  assert.deepEqual(r, { lengthSource: 'phone', lengthM: 1234, routeWkt: 'LINESTRING(1.5 42.5, 1.5 42.6, 1.5 42.7)', points: 3 });
  assert.equal(close.writes.length, 2);
  assert.deepEqual(close.writes[0].params, [1234, 'LINESTRING(1.5 42.5, 1.5 42.6, 1.5 42.7)', 'phone', 'T1']);
  assert.match(close.writes[1].sql, /ROUTE = ST_GeomFromText\(ROUTEWKT, 4326\)/);
});

test('computeTripRoute: the phone line names the position at the trip\'s end, which the next trip may have taken', async () => {
  const tx = fakeTx({ trip: TRIP, line: { L: 10, W: Buffer.from('LINESTRING(1 2, 3 4)') } });
  await computeTripRoute(tx, 'T1', SETTINGS, { atClose: true });
  const own = ['T1', 'smoke', '2026-09-22T11:00:00.000Z'];
  assert.deepEqual(tx.reads.find((q) => /FROM DUMMY/.test(q.sql)).params, [...own, ...own]);
});

test('computeTripRoute: a trip of one position gets a length and a text line but no geometry', async () => {
  const tx = fakeTx({ trip: { ...TRIP, POINTCOUNT: 1 }, line: { L: null, W: Buffer.from('LINESTRING(1.5 42.5)') } });
  const r = await refreshTripRoute(tx, 'T1', SETTINGS, { atClose: true });
  assert.deepEqual([r.lengthM, r.points], [null, 1]);
  assert.equal(tx.writes.length, 1);
  assert.match(tx.writes[0].sql, /ROUTE = NULL/);
});

test('computeTripRoute: a trip that lost its Watch points goes back to the phone line', async () => {
  const tx = fakeTx({ trip: { ...TRIP, LENGTHSOURCE: 'watch' }, line: { L: 900, W: Buffer.from('LINESTRING(1.5 42.5, 1.5 42.6)') } });
  const r = await refreshTripRoute(tx, 'T1', SETTINGS);
  assert.deepEqual([r.lengthSource, r.lengthM], ['phone', 900]);
  assert.equal(tx.writes[0].params[2], 'phone');
});

test('computeTripRoute: Watch points are read for the trip\'s device, window and accuracy limit, and stitched', async () => {
  const watch = [row('10:10:00', '42.500000'), row('10:10:30', '42.500100'), row('10:11:00', '42.500200')];
  const phone = [row('10:00:00', '42.499000'), row('10:10:20', '42.500050'), row('11:00:00', '42.501000')];
  const tx = fakeTx({ trip: TRIP, watch, phone });
  const r = await refreshTripRoute(tx, 'T1', SETTINGS);
  assert.deepEqual(tx.reads.find((q) => /FROM GEOTRACK_WORKOUTROUTE/.test(q.sql)).params,
    ['smoke', '2026-09-22T10:00:00.000Z', '2026-09-22T11:00:00.000Z', 100]);
  assert.deepEqual(tx.reads.find((q) => /^SELECT TS, LAT, LON FROM GEOTRACK_POSITIONS/.test(q.sql)).params, ['T1', 'smoke', '2026-09-22T11:00:00.000Z']);
  assert.equal(r.lengthSource, 'mixed');
  // lon lat order, the stored text unchanged; the phone point at 10:10:20 is within 30 s of a Watch point
  assert.equal(r.routeWkt, 'LINESTRING(1.500000 42.499000, 1.500000 42.500000, 1.500000 42.500100, 1.500000 42.500200, 1.500000 42.501000)');
  const expected = [42.499, 42.5, 42.5001, 42.5002, 42.501].map((lat) => ({ lat, lon: 1.5 }));
  assert.equal(r.lengthM, Math.round(expected.slice(1).reduce((s, p, i) => s + haversineM(expected[i], p), 0)));
  assert.equal(r.points, 5);
  assert.deepEqual(tx.writes[0].params, [r.lengthM, r.routeWkt, 'mixed', 'T1']);
  assert.equal(tx.writes.length, 2);
});
