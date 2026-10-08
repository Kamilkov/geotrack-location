'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summaryDiff, rateDiff, pointDiff, sameRate, samePoint, pairRows, compareWorkout, instant } = require('../scripts/compare-workouts');

// Synthetic: a walk near 42.50/1.50 that started at 2026-09-22T15:43:46Z.
const t0 = Date.parse('2026-09-22T15:43:46Z');
const at = (s) => new Date(t0 + s * 1000);
const W = (extra = {}) => ({ name: 'Outdoor Walk', isIndoor: false, startedAt: at(0), endedAt: at(300), durationS: 300, distanceM: 620, elevationUpM: 12.3,
  activeEnergyKcal: 32.4, steps: 313, hrMin: 92, hrAvg: 108, hrMax: 121, temperatureC: 18.5, humidityPct: 61, ...extra });
const H = (s, bpm = 100, extra = {}) => ({ phase: 'workout', ts: at(s), bpmMin: bpm, bpmAvg: bpm, bpmMax: bpm, source: 'Apple Watch', ...extra });
const P = (s, extra = {}) => ({ ts: at(s), lat: 42.51 + s * 0.00001, lon: 1.5, altitudeM: 1000, speedMs: 1.3, courseDeg: 10, horizontalAccuracyM: 4, verticalAccuracyM: 3, zone_ID: null, isCoarsened: false, ...extra });
const COARSE = (s, zone = 'home') => ({ ts: at(s), lat: 42.5, lon: 1.5, altitudeM: null, speedMs: null, courseDeg: null, horizontalAccuracyM: 4, verticalAccuracyM: null, zone_ID: zone, isCoarsened: true });

test('summaryDiff: the same summary within rounding has no difference', () => {
  assert.deepEqual(summaryDiff(W(), W()), []);
  assert.deepEqual(summaryDiff(W(), W({ startedAt: at(1), endedAt: at(299), durationS: 301, distanceM: 626, elevationUpM: 13.3, activeEnergyKcal: 33.4,
    steps: 316, hrMin: 93, hrAvg: 107, hrMax: 122, temperatureC: 18, humidityPct: 62 })), []);
});

for (const [field, value] of [['name', 'Hiking'], ['isIndoor', true], ['startedAt', at(2)], ['endedAt', at(302)], ['durationS', 302], ['distanceM', 627],
  ['elevationUpM', 13.4], ['activeEnergyKcal', 33.5], ['steps', 317], ['hrMin', 94], ['hrAvg', 110], ['hrMax', 123], ['temperatureC', 19.1], ['humidityPct', 63]]) {
  test(`summaryDiff: ${field} beyond its tolerance is a difference`, () => {
    assert.deepEqual(summaryDiff(W(), W({ [field]: value })), [field]);
  });
}

test('summaryDiff: an empty value matches only an empty value', () => {
  assert.deepEqual(summaryDiff(W({ steps: null }), W({ steps: null })), []);
  assert.deepEqual(summaryDiff(W(), W({ steps: null, isIndoor: null })), ['isIndoor', 'steps']);
  assert.deepEqual(summaryDiff(W({ temperatureC: null }), W()), ['temperatureC']);
});

test('sameRate: phase, source and the three values', () => {
  assert.ok(sameRate(H(0), H(1)));
  assert.ok(sameRate(H(0, 100), H(0, 100.1)));
  assert.ok(!sameRate(H(0), H(0, 100, { phase: 'recovery' })));
  assert.ok(!sameRate(H(0), H(0, 100, { source: 'iPhone' })));
  assert.ok(!sameRate(H(0), H(0, 100, { source: null })));
  for (const k of ['bpmMin', 'bpmAvg', 'bpmMax']) assert.ok(!sameRate(H(0), H(0, 100, { [k]: 100.2 })), k);
});

test('samePoint: place, altitude, speed, course, both accuracies and the zone', () => {
  assert.ok(samePoint(P(0), P(0)));
  assert.ok(samePoint(P(0), P(0, { lat: 42.510005, altitudeM: 1001, speedMs: 1.35, courseDeg: 11, horizontalAccuracyM: 4.5, verticalAccuracyM: 2.5 })));
  assert.ok(samePoint(P(0, { courseDeg: 359 }), P(0, { courseDeg: 0 })), 'degrees are compared on the circle');
  for (const [k, v] of [['lat', 42.51002], ['altitudeM', 1001.1], ['speedMs', 1.36], ['courseDeg', 12], ['horizontalAccuracyM', 4.6], ['verticalAccuracyM', 3.6], ['zone_ID', 'park']]) {
    assert.ok(!samePoint(P(0), P(0, { [k]: v })), k);
  }
  for (const k of ['altitudeM', 'speedMs', 'courseDeg', 'verticalAccuracyM']) assert.ok(!samePoint(P(0), P(0, { [k]: null })), `${k}: a value against none`);
  assert.ok(samePoint(P(0, { altitudeM: null, verticalAccuracyM: null }), P(0, { altitudeM: null, verticalAccuracyM: null })));
});

test('samePoint: a coarsened point matches only a coarsened point of the same zone', () => {
  assert.ok(samePoint(COARSE(0), COARSE(0)));
  assert.ok(!samePoint(COARSE(0), COARSE(0, 'office')));
  assert.ok(!samePoint(COARSE(0), P(0, { lat: 42.5, lon: 1.5, zone_ID: 'home' })), 'coarsened against uncoarsened at the same place');
});

test('rateDiff and pointDiff name the fields that differ, and nothing for rows that agree', () => {
  assert.deepEqual(rateDiff(H(0), H(1)), []);
  assert.deepEqual(rateDiff(H(0), H(0, 100, { phase: 'recovery', bpmAvg: 100.2, source: 'iPhone' })), ['phase', 'source', 'bpmAvg']);
  assert.deepEqual(pointDiff(P(0), P(0)), []);
  assert.deepEqual(pointDiff(P(0), P(0, { lat: 42.5101, speedMs: null, courseDeg: 12 })), ['place', 'speedMs', 'courseDeg']);
  assert.deepEqual(pointDiff(COARSE(0), P(0, { lat: 42.5, lon: 1.5, zone_ID: 'home' })), ['isCoarsened', 'altitudeM', 'speedMs', 'courseDeg', 'verticalAccuracyM']);
  assert.deepEqual(pointDiff(COARSE(0), COARSE(0, 'office')), ['zone_ID']);
});

test('pairRows: one to one, so three points never pass against one', () => {
  const still = (s) => P(s, { lat: 42.51 });
  const r = pairRows([still(0), still(1), still(2)], [still(1)], samePoint);
  assert.equal(r.matched, 1);
  assert.equal(r.missing.length, 2);
  assert.equal(r.different.length, 0);
});

test('pairRows: an extra sample just before the exact partner does not get in its way', () => {
  const r = pairRows([H(10, 100)], [H(9, 80), H(10, 100)], sameRate);
  assert.deepEqual([r.matched, r.different.length, r.missing.length, r.extra], [1, 0, 0, 1]);
});

test('pairRows: within one second either way, and each row of the app is taken once', () => {
  const r = pairRows([H(10), H(11), H(20)], [H(11), H(12), H(19)], sameRate);
  assert.deepEqual([r.matched, r.different.length, r.missing.length, r.extra], [3, 0, 0, 0]);
  assert.equal(pairRows([H(10)], [H(12)], sameRate).missing.length, 1); // two seconds after
  assert.equal(pairRows([H(10)], [H(8)], sameRate).missing.length, 1); // two seconds before
});

test('pairRows: a row whose only neighbour disagrees is different and names it; one without a neighbour is missing', () => {
  const r = pairRows([H(10, 100), H(60, 100)], [H(10, 90)], sameRate);
  assert.equal(r.matched, 0);
  assert.deepEqual(r.different.map((d) => [d.base.ts, d.nearest.ts]), [[at(10), at(10)]]);
  assert.deepEqual(r.missing.map((m) => m.ts), [at(60)]);
  assert.equal(r.extra, 1);
});

test('pairRows: a row without a partner names the nearest row not yet taken', () => {
  // Three rows within a second and none agrees: the one at the same second is named, not the first.
  const near = pairRows([H(10, 100)], [H(9, 80), H(10, 90), H(11, 70)], sameRate);
  assert.deepEqual(near.different.map((d) => d.nearest.ts), [at(10)]);
  // The row at 10 s is taken by the first base row: the second one names the row at 12 s, though the taken one is as near.
  const taken = pairRows([H(10, 100), H(11, 200)], [H(10, 100), H(12, 50)], sameRate);
  assert.deepEqual([taken.matched, taken.different.map((d) => [d.base.ts, d.nearest.ts])], [1, [[at(11), at(12)]]]);
});

test('pairRows: empty lists', () => {
  assert.deepEqual(pairRows([], [H(0)], sameRate), { matched: 0, different: [], missing: [], extra: 1 });
  assert.equal(pairRows([H(0)], [], sameRate).missing.length, 1);
});

test('compareWorkout: the same copy passes; more in the app\'s copy is no failure', () => {
  const base = { workout: W(), heartRate: [H(0), H(5)], route: [COARSE(0), P(60)] };
  assert.equal(compareWorkout(base, base).ok, true);
  const more = { workout: W(), heartRate: [H(0), H(5), H(10), H(310, 95, { phase: 'recovery' })], route: [COARSE(0), P(30), P(60), P(90)] };
  const r = compareWorkout(base, more);
  assert.equal(r.ok, true);
  assert.deepEqual([r.heartRate.extra, r.route.extra], [2, 2]);
  assert.equal(compareWorkout({ workout: W(), heartRate: [H(0)], route: [] }, more).ok, true, 'a route only the app has');
});

test('compareWorkout: a summary difference, a missing sample or a different point each fail', () => {
  const base = { workout: W(), heartRate: [H(0), H(5)], route: [P(0), P(60)] };
  assert.deepEqual(compareWorkout(base, { ...base, workout: W({ steps: null }) }).summary, ['steps']);
  assert.equal(compareWorkout(base, { ...base, workout: W({ steps: null }) }).ok, false);
  assert.equal(compareWorkout(base, { ...base, heartRate: [H(0)] }).ok, false);
  assert.equal(compareWorkout(base, { ...base, route: [P(0), P(60, { altitudeM: 1010 })] }).ok, false);
  assert.equal(compareWorkout(base, { ...base, route: [COARSE(0), P(60)] }).ok, false, 'coarsened in one copy only');
});

test('instant: a UTC instant needs a Z or an offset', () => {
  assert.equal(instant('2026-09-22T00:00:00Z').toISOString(), '2026-09-22T00:00:00.000Z');
  assert.equal(instant('2026-09-22T02:00:00+02:00').toISOString(), '2026-09-22T00:00:00.000Z');
  for (const bad of ['2026-09-22', '2026-09-22T00:00:00', undefined, null, '']) assert.ok(isNaN(instant(bad)), String(bad));
});
