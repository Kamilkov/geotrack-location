'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTime, parseWorkout, coarsenRoute } = require('../srv/lib/health');
const { circleToWkt, prepareZones } = require('../srv/lib/geo');
const fixture = require('./fixtures/health-workouts.json');

const walk = () => structuredClone(fixture.data.workouts[0]);
const zone = (ID, lat, lon, r, isPrivate) => ({ ID, KIND: 'circle', RADIUSM: r, ISPRIVATE: isPrivate, CENTRELAT: lat, CENTRELON: lon, WKT: circleToWkt(lat, lon, r) });
// Synthetic private zone around 42.50/1.50 (r 100 m): the fixture's first two route points lie inside it.
const ZONES = prepareZones([zone('home', 42.5, 1.5, 100, true), zone('park', 42.502, 1.5009, 100, false)]);

test('parseTime: the app format with offset, ISO with Z or offset; nothing without an offset', () => {
  assert.equal(parseTime('2026-09-22 17:43:46 +0200').toISOString(), '2026-09-22T15:43:46.000Z');
  assert.equal(parseTime('2024-02-06 14:30:00 -0800').toISOString(), '2024-02-06T22:30:00.000Z');
  assert.equal(parseTime('2026-10-25 02:30:00 +0100').toISOString(), '2026-10-25T01:30:00.000Z'); // after the DST switch
  assert.equal(parseTime('2026-09-22T15:43:46Z').toISOString(), '2026-09-22T15:43:46.000Z');
  assert.equal(parseTime('2026-09-22T17:43:46.5+02:00').toISOString(), '2026-09-22T15:43:46.500Z');
  for (const bad of ['2026-09-22 17:43:46', 'yesterday', '', null, undefined, 1695390226, '2026-13-45 99:00:00 +0200']) assert.equal(parseTime(bad), null, String(bad));
});

test('parseWorkout: the fixture walk → every Workouts element, converted and rounded', () => {
  const { workout, warnings } = parseWorkout(walk());
  const { raw, ...rest } = workout;
  assert.deepEqual(rest, {
    ID: '7B3E3D5C-1D2A-4F0E-9A51-2C4B8E6F0A11', name: 'Outdoor Walk',
    startedAt: '2026-09-22T15:43:46.000Z', endedAt: '2026-09-22T15:48:46.000Z', durationS: 300,
    distanceM: 620, activeEnergyKcal: 32.4, elevationUpM: 12.3, steps: 313,
    hrMin: 92, hrAvg: 108, hrMax: 121, temperatureC: 18.5, humidityPct: 61, isIndoor: false,
  });
  assert.deepEqual(warnings, []);
  const r = JSON.parse(raw);
  for (const k of ['route', 'heartRateData', 'heartRateRecovery', 'stepCount']) assert.equal(k in r, false, k);
  assert.deepEqual(r.intensity, { qty: 4.1, units: 'kcal/hr·kg' }); // unknown extra fields survive in raw
  assert.equal(r.location, 'Outdoor');
});

test('parseWorkout: raw strips coordinates and time-series data under any key, at any depth', () => {
  const w = walk();
  w.locations = w.route; // the route under a name the parser does not know
  delete w.route;
  w.splits = [{ index: 0, point: { lat: 42.5003, lon: 1.5002 } }]; // a coordinate nested inside an unrelated array
  w.segments = { first: { latitude: 42.5006, longitude: 1.5004 } }; // a coordinate nested inside an unrelated object
  const { raw } = parseWorkout(w).workout;
  assert.ok(!raw.includes('42.5003') && !raw.includes('42.5006'), 'a real coordinate value leaked into raw');
  assert.ok(!raw.includes('"lat"') && !raw.includes('"latitude"'), 'a coordinate key leaked into raw');
  const r = JSON.parse(raw);
  assert.equal('locations' in r, false); // the whole unknown-keyed series is gone, not just its coordinates
});

test('parseWorkout: raw drops per-second energy series wherever named; keeps unrelated extra fields', () => {
  const w = walk();
  w.activeEnergy = [{ date: '2026-09-22 17:43:47 +0200', qty: 1.2, units: 'kcal' }];
  w.basalEnergy = [{ date: '2026-09-22 17:43:47 +0200', qty: 0.9, units: 'kcal' }];
  w.segments = [{ start: 0, end: 300, index: 0 }];
  const { raw } = parseWorkout(w).workout;
  const r = JSON.parse(raw);
  assert.equal('activeEnergy' in r, false);
  assert.equal('basalEnergy' in r, false);
  assert.deepEqual(r.segments, [{ start: 0, end: 300, index: 0 }]);
  assert.deepEqual(r.intensity, { qty: 4.1, units: 'kcal/hr·kg' });
  assert.deepEqual(r.metadata, {});
  assert.equal(r.location, 'Outdoor');
  assert.deepEqual(r.heartRate, { min: { qty: 92, units: 'bpm' }, avg: { qty: 108.4, units: 'bpm' }, max: { qty: 121, units: 'bpm' } });
});

test('parseWorkout: an outdoor workout without a route warns; an indoor one does not', () => {
  const WARNING = 'route: no points (outdoor workout without a route, or route data under an unknown key)';
  const w = walk();
  delete w.route;
  assert.ok(parseWorkout(w).warnings.includes(WARNING));
  w.isIndoor = true;
  assert.ok(!parseWorkout(w).warnings.includes(WARNING));
});

test('parseWorkout: imperial units convert; an unknown unit stores null with a warning', () => {
  const w = walk();
  Object.assign(w, { distance: { qty: 1, units: 'mi' }, elevationUp: { qty: 100, units: 'ft' }, temperature: { qty: 68, units: 'degF' }, activeEnergyBurned: { qty: 418.4, units: 'kJ' } });
  let p = parseWorkout(w);
  assert.deepEqual([p.workout.distanceM, p.workout.elevationUpM, p.workout.temperatureC, p.workout.activeEnergyKcal], [1609, 30.5, 20, 100]);
  w.distance = { qty: 3, units: 'furlong' };
  p = parseWorkout(w);
  assert.equal(p.workout.distanceM, null);
  assert.deepEqual(p.warnings, ['distance: unit "furlong" not understood, not stored']);
});

test('parseWorkout: absent optional fields are null, not missing (a resend must clear them)', () => {
  const w = walk();
  for (const k of ['distance', 'activeEnergyBurned', 'elevationUp', 'temperature', 'humidity', 'heartRate', 'heartRateData', 'heartRateRecovery', 'stepCount', 'route', 'isIndoor', 'duration']) delete w[k];
  const p = parseWorkout(w);
  for (const k of ['distanceM', 'activeEnergyKcal', 'elevationUpM', 'steps', 'hrMin', 'hrAvg', 'hrMax', 'temperatureC', 'humidityPct', 'isIndoor']) {
    assert.ok(k in p.workout, k);
    assert.equal(p.workout[k], null, k);
  }
  assert.equal(p.workout.durationS, 300); // from start/end when duration is absent
  assert.deepEqual([p.heartRate, p.route], [[], []]);
  // no route and isIndoor no longer true (deleted) → the empty-route warning fires
  assert.deepEqual(p.warnings, ['route: no points (outdoor workout without a route, or route data under an unknown key)']);
});

test('parseWorkout: incomplete workouts throw a reason', () => {
  const cases = [[null, /not an object/], [[], /not an object/], [{ ...walk(), id: undefined }, /missing id/], [{ ...walk(), id: 'x'.repeat(65) }, /longer than 64/],
    [{ ...walk(), start: undefined }, /start/], [{ ...walk(), end: '2026-09-22 17:48:46' }, /end/]];
  for (const [w, reason] of cases) assert.throws(() => parseWorkout(w), reason);
});

test('parseWorkout: heart-rate rows per phase in UTC; repeated and undated samples dropped with a warning', () => {
  const w = walk();
  w.heartRateData.push({ ...w.heartRateData[1], Avg: 150 }, { date: 'garbage', Avg: 100 });
  const { heartRate, warnings } = parseWorkout(w);
  assert.equal(heartRate.length, 7);
  assert.deepEqual(heartRate[1], { phase: 'workout', ts: '2026-09-22T15:44:46.000Z', bpmMin: 99, bpmAvg: 102.3, bpmMax: 105, source: 'Apple Watch' }); // first sample wins
  assert.deepEqual(heartRate.filter((h) => h.phase === 'recovery').map((h) => h.ts), ['2026-09-22T15:49:46.000Z', '2026-09-22T15:50:46.000Z']);
  assert.deepEqual(warnings, ['workout heart rate: 2 samples dropped (bad or repeated date, no value)']);
});

test('parseWorkout: heart-rate units other than bpm or count/min are stored as sent, with a warning', () => {
  const w = walk();
  for (const e of w.heartRateData) e.units = 'count/s';
  const { heartRate, warnings } = parseWorkout(w);
  assert.equal(heartRate[0].bpmAvg, 94.5);
  assert.deepEqual(warnings, ['workout heart rate: units "count/s", stored as sent']);
});

test('parseWorkout: route rows sorted by time, rounded; CoreLocation -1 markers become null', () => {
  const w = walk();
  w.route.reverse();
  const { route } = parseWorkout(w);
  assert.deepEqual(route.map((p) => p.ts.slice(11, 19)), ['15:43:46', '15:44:46', '15:45:46', '15:46:46', '15:47:46', '15:48:46']);
  assert.deepEqual(route[0], { ts: '2026-09-22T15:43:46.000Z', lat: 42.5003, lon: 1.5002, altitudeM: 1001.3, speedMs: 1.21, courseDeg: 12, horizontalAccuracyM: 4.2, verticalAccuracyM: 3.1 });
  assert.equal(route[3].courseDeg, 0); // 359.7 rounds to 360 → 0
  assert.deepEqual([route[4].speedMs, route[4].courseDeg, route[4].altitudeM, route[4].verticalAccuracyM], [null, null, null, null]);
});

test('parseWorkout: route points with bad time, coordinates or accuracy are dropped with a warning', () => {
  const w = walk();
  w.route.push({ ...w.route[0] }, { ...w.route[1], timestamp: 'x' }, { ...w.route[2], timestamp: '2026-09-22 17:49:46 +0200', latitude: 91 }, { ...w.route[3], timestamp: '2026-09-22 17:50:46 +0200', horizontalAccuracy: -1 });
  const { route, warnings } = parseWorkout(w);
  assert.equal(route.length, 6);
  assert.deepEqual(warnings, ['route: 4 points dropped (bad or repeated timestamp, bad coordinates)']);
});

test('coarsenRoute: points in the private zone become its centre without altitude, speed, course; flags and counts', () => {
  const c = coarsenRoute(parseWorkout(walk()).route, ZONES);
  assert.equal(c.coarsened, 2);
  assert.equal(c.startsInPrivateZone, true);
  assert.equal(c.endsInPrivateZone, false);
  assert.deepEqual(c.route[0], { ts: '2026-09-22T15:43:46.000Z', lat: 42.5, lon: 1.5, altitudeM: null, speedMs: null, courseDeg: null, horizontalAccuracyM: 4.2, verticalAccuracyM: 3.1, zone_ID: 'home', isCoarsened: true });
  assert.deepEqual([c.route[2].lat, c.route[2].lon, c.route[2].altitudeM, c.route[2].zone_ID, c.route[2].isCoarsened], [42.5015, 1.5008, 1005.1, 'park', false]);
  assert.equal(c.route[5].zone_ID, null);
  assert.ok(!JSON.stringify(c.route).includes('42.5003') && !JSON.stringify(c.route).includes('42.5006'), 'real coordinates inside the zone must not survive');
});

test('coarsenRoute: ending inside the private zone sets endsInPrivateZone; no route → no flags', () => {
  const w = walk();
  w.route.reverse().forEach((p, i) => { p.timestamp = fixture.data.workouts[0].route[i].timestamp; });
  const c = coarsenRoute(parseWorkout(w).route, ZONES);
  assert.deepEqual([c.startsInPrivateZone, c.endsInPrivateZone, c.coarsened], [false, true, 2]);
  assert.deepEqual(coarsenRoute([], ZONES), { route: [], coarsened: 0, startsInPrivateZone: false, endsInPrivateZone: false });
});

test('parseWorkout: the workout as the iOS app sends it (test/fixtures/ios-workout.json, the app\'s encoder test produces it)', () => {
  const { workout, heartRate, route, warnings } = parseWorkout(structuredClone(require('./fixtures/ios-workout.json').data.workouts[0]));
  const { raw, ...rest } = workout;
  assert.deepEqual(rest, {
    ID: '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D', name: 'Outdoor Walk', startedAt: '2026-09-22T15:43:46.000Z', endedAt: '2026-09-22T15:48:46.000Z',
    durationS: 300, distanceM: 620, activeEnergyKcal: 32.4, elevationUpM: 12.3, steps: 313, hrMin: 92, hrAvg: 108, hrMax: 121,
    temperatureC: 18.5, humidityPct: 61, isIndoor: false,
  });
  assert.deepEqual(heartRate.map((h) => [h.phase, h.ts, h.bpmMin, h.bpmAvg, h.bpmMax, h.source]), [
    ['workout', '2026-09-22T15:43:51.000Z', 92, 92, 92, 'Apple Watch'], ['workout', '2026-09-22T15:46:16.000Z', 108, 108, 108, 'Apple Watch'],
    ['workout', '2026-09-22T15:48:41.000Z', 121, 121, 121, 'Apple Watch'],
    ['recovery', '2026-09-22T15:49:16.000Z', 104, 104, 104, 'Apple Watch'], ['recovery', '2026-09-22T15:50:46.000Z', 97, 97, 97, 'Apple Watch'],
  ]);
  assert.deepEqual(route, [
    { ts: '2026-09-22T15:43:46.000Z', lat: 42.5003, lon: 1.5002, altitudeM: 1001.3, speedMs: 1.21, courseDeg: 12, horizontalAccuracyM: 4.2, verticalAccuracyM: 3.1 },
    { ts: '2026-09-22T15:46:16.000Z', lat: 42.5025, lon: 1.501, altitudeM: 1008.8, speedMs: 1.41, courseDeg: 0, horizontalAccuracyM: 3.9, verticalAccuracyM: 3 },
    // What iOS marks as not available the app leaves out: stored as empty.
    { ts: '2026-09-22T15:48:46.000Z', lat: 42.5045, lon: 1.5014, altitudeM: null, speedMs: null, courseDeg: null, horizontalAccuracyM: 4, verticalAccuracyM: null },
  ]);
  assert.deepEqual(warnings, []);
  assert.ok(!raw.includes('42.5'), 'raw must hold no coordinate');
});
