'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { speedKind, tripsOf, segmented, inWindow, pair, difference, silences, unshared, hasPositions, instant } = require('../scripts/compare-devices');

const S = { stillMinutes: 30, stillRadiusM: 50, minTripPoints: 3, maxAccuracyM: 50, maxAccuracyOutsideM: 35, modeMinutes: 5, stopMinutes: 10, walkMinM: 500, gapMinutes: 15 };
const t0 = Date.parse('2026-09-22T08:00:00Z');
const at = (min) => new Date(t0 + min * 60000);
// As the runner hands positions to the segmenter, plus the speed (km/h) the fallback kind needs.
const P = (min, lat, zone = null, base = false, extra = {}) => ({ ts: at(min), lat, lon: 1.5, accuracy: 5, zone_ID: zone, zoneIsBase: base, zoneCreatesVisit: false, activities: null, velocity: 4, ...extra });
const T = (start, end, kind = 'walk', lengthM = 1000) => ({ startedAt: at(start), endedAt: at(end), kind, lengthM, points: 5 });

test('speedKind is the stored trips\' fallback: by the median speed, unknown without speeds', () => {
  assert.equal(speedKind([]), 'unknown');
  assert.equal(speedKind([null, null]), 'unknown');
  assert.equal(speedKind([4, 5, 4, null]), 'walk');
  assert.equal(speedKind([30, 40]), 'drive');
  assert.equal(speedKind([7, 20]), 'unknown'); // median 13.5
});

test('tripsOf segments from an empty state and measures each trip on its own accepted positions', () => {
  const home = (min) => P(min, 42.5, 'home', true);
  const pts = [home(0), home(5), P(10, 42.51), P(15, 42.52), P(20, 42.53), P(25, 42.52, null, false, { accuracy: 40 }), P(30, 42.52), P(35, 42.51), home(40)];
  const trips = tripsOf(pts, S, 'smoke');
  assert.equal(trips.length, 1);
  const [t] = trips;
  assert.deepEqual([t.startedAt.toISOString(), t.endedAt.toISOString(), t.kind], [at(5).toISOString(), at(40).toISOString(), 'walk']);
  assert.equal(t.points, 7, 'the 40 m position outside every zone is not accepted and not counted');
  assert.ok(Math.abs(t.lengthM - 6672) <= 2, `six steps of 0.01° north, got ${t.lengthM}`);
});

test('tripsOf takes the kind the segmenter names, not the speed fallback; the fallback only where the segmenter has none', () => {
  const home = (min) => P(min, 42.5, 'home', true);
  // Every position says 4 km/h unless told otherwise. The segmenter's kind comes from the motion activity (a drive is confirmed after modeMinutes).
  const outing = (extra) => [home(0), home(5), ...[10, 15, 20, 25, 30, 35].map((min, i) => P(min, 42.51 + i * 0.01, null, false, extra)), home(40)];
  assert.deepEqual(tripsOf(outing({ activities: 'automotive' }), S, 'smoke').map((t) => t.kind), ['drive']);
  assert.deepEqual(tripsOf(outing({ activities: 'walking' }), S, 'smoke').map((t) => t.kind), ['walk']);
  assert.deepEqual(tripsOf(outing({ activities: 'walking', velocity: 40 }), S, 'smoke').map((t) => t.kind), ['walk'], 'fast on foot is still a walk');
  assert.deepEqual(tripsOf(outing({ velocity: 40 }), S, 'smoke').map((t) => t.kind), ['drive'], 'no motion activity: the speed decides');
});

test('segmented also tells when a trip is still under way at the end of the positions', () => {
  const home = (min) => P(min, 42.5, 'home', true);
  const out = [home(0), home(5), P(10, 42.51), P(15, 42.52), P(20, 42.53), P(25, 42.54)];
  const r = segmented(out, S, 'smoke');
  assert.deepEqual(r.trips, []);
  assert.equal(r.underWay.toISOString(), at(5).toISOString());
  // Back home: the trip is closed and nothing is under way.
  const back = segmented([...out, P(30, 42.52), home(35)], S, 'smoke');
  assert.equal(back.trips.length, 1);
  assert.equal(back.underWay, null);
});

test('inWindow counts trips wholly inside, lists the ones an edge cuts, drops the warm-up', () => {
  const trips = [T(-120, -60), T(-10, 20), T(30, 60), T(100, 130)];
  const { counted, cut } = inWindow(trips, at(0), at(120));
  assert.deepEqual(counted, [trips[2]]);
  assert.deepEqual(cut, [trips[1], trips[3]]);
});

test('pair matches each trip with the one it overlaps longest; a trip without a partner is a difference', () => {
  const a = [T(0, 30), T(60, 90)], b = [T(2, 29), T(58, 95), T(200, 210)];
  const r = pair(a, b);
  assert.deepEqual(r.pairs, [{ a: a[0], b: b[0] }, { a: a[1], b: b[1] }]);
  assert.deepEqual([r.onlyA, r.onlyB], [[], [b[2]]]);
  // One device splits a trip the other keeps whole: the longer half pairs, the shorter is left over.
  const whole = [T(0, 60)], halves = [T(0, 25), T(30, 60)];
  const s = pair(whole, halves);
  assert.deepEqual(s.pairs, [{ a: whole[0], b: halves[1] }]);
  assert.deepEqual(s.onlyB, [halves[0]]);
});

test('pair: trips that overlap equally pair in the order given, and trips that only touch are not a pair', () => {
  const whole = [T(0, 30)], halves = [T(0, 15), T(15, 30)];
  const a = pair(whole, halves);
  assert.deepEqual(a.pairs, [{ a: whole[0], b: halves[0] }]);
  assert.deepEqual(a.onlyB, [halves[1]]);
  const b = pair(halves, whole);
  assert.deepEqual(b.pairs, [{ a: halves[0], b: whole[0] }]);
  assert.deepEqual(b.onlyA, [halves[1]]);
  // Nothing in common but the instant one ends and the other starts.
  const c = pair([T(0, 30)], [T(30, 60)]);
  assert.deepEqual([c.pairs, c.onlyA.length, c.onlyB.length], [[], 1, 1]);
});

test('difference: within 5 minutes and 10 % and of the same kind is ok', () => {
  assert.equal(difference({ a: T(0, 30, 'walk', 1000), b: T(4, 26, 'walk', 910) }).ok, true);
  assert.equal(difference({ a: T(0, 30), b: T(6, 30) }).ok, false, 'start 6 minutes apart');
  assert.equal(difference({ a: T(0, 30), b: T(0, 36) }).ok, false, 'end 6 minutes apart');
  assert.equal(difference({ a: T(0, 30, 'walk', 1000), b: T(0, 30, 'walk', 880) }).ok, false, '12 % shorter');
  assert.equal(difference({ a: T(0, 30, 'walk'), b: T(0, 30, 'drive') }).ok, false, 'another kind');
  const d = difference({ a: T(0, 30, 'walk', 1000), b: T(3, 28, 'walk', 900) });
  assert.deepEqual([d.startMin, d.endMin, Math.round(d.lengthPct), d.sameKind], [3, 2, 10, true]);
});

test('difference: two trips of no length differ by 0 %, not by NaN; against one with a length they differ by 100 %', () => {
  const none = difference({ a: T(0, 30, 'walk', 0), b: T(0, 30, 'walk', 0) });
  assert.deepEqual([none.lengthPct, none.ok], [0, true]);
  const one = difference({ a: T(0, 30, 'walk', 0), b: T(0, 30, 'walk', 100) });
  assert.deepEqual([one.lengthPct, one.ok], [100, false]);
});

test('silences: pauses over gapMinutes between accepted positions, the window\'s edges included', () => {
  const pts = [P(0, 42.5), P(5, 42.5), P(25, 42.5), P(30, 42.5, null, false, { accuracy: 500 }), P(35, 42.5)];
  // 5 → 25 is a silence; 35 → the window's end at 60 is one too: a device that never came back.
  assert.deepEqual(silences(pts, S, at(0), at(60)), [{ from: at(5), to: at(25) }, { from: at(35), to: at(60) }]);
  assert.deepEqual(silences(pts, S, at(0), at(40)), [{ from: at(5), to: at(25) }]);
  // The poor position at 30 does not count: without the one at 25 the silence runs from 5 to 35.
  assert.deepEqual(silences(pts.filter((p) => p.ts.getTime() !== at(25).getTime()), S, at(0), at(40)), [{ from: at(5), to: at(35) }]);
  // A silence that began before the window: its real start counts, not the window's edge.
  const across = [P(-14, 42.5), P(14, 42.5), P(20, 42.5), P(25, 42.5), P(30, 42.5)];
  assert.deepEqual(silences(across, S, at(0), at(30)), [{ from: at(-14), to: at(14) }]);
  // A poor position before the window is no mark; without any accepted one the window's edge is.
  assert.deepEqual(silences([P(-14, 42.5, null, false, { accuracy: 500 }), P(20, 42.5), P(25, 42.5), P(30, 42.5)], S, at(0), at(30)), [{ from: at(0), to: at(20) }]);
});

const GAP = S.gapMinutes * 60000;
const span = (from, to) => ({ from: at(from), to: at(to) });

test('unshared: a silence counts as shared only as far as the other device was silent too', () => {
  // Wholly inside the other's silence, or wider by less than gapMinutes at each end: shared.
  assert.deepEqual(unshared([span(12, 38)], [span(10, 40)], GAP), []);
  assert.deepEqual(unshared([span(5, 25)], [span(10, 40)], GAP), []);
  assert.deepEqual(unshared([span(0, 50)], [span(10, 40)], GAP), []);
  // No silence of the other device near it: not shared.
  assert.deepEqual(unshared([span(5, 25), span(100, 130)], [span(10, 40)], GAP), [span(100, 130)]);
  // An overlap alone excuses nothing: 90 minutes of silence against 5 of the other's.
  assert.deepEqual(unshared([span(0, 90)], [span(40, 45)], GAP), [span(0, 90)]);
  // Two silences of the other device cover it between them, whatever their order.
  assert.deepEqual(unshared([span(0, 60)], [span(30, 60), span(0, 32)], GAP), []);
  // The uncovered stretch lies between two of the other's silences.
  assert.deepEqual(unshared([span(0, 90)], [span(0, 20), span(60, 90)], GAP), [span(0, 90)]);
});

test('a device that sent nothing is one long silence the other does not share, and has no positions', () => {
  const live = [0, 5, 10, 40, 45, 50, 55, 60].map((min) => P(min, 42.5));
  const mine = silences([], S, at(0), at(60)), theirs = silences(live, S, at(0), at(60));
  assert.deepEqual(mine, [span(0, 60)]);
  assert.deepEqual(theirs, [span(10, 40)]);
  assert.deepEqual(unshared(mine, theirs, GAP), mine);
  assert.equal(hasPositions([], S, at(0), at(60)), false);
  assert.equal(hasPositions(live, S, at(0), at(60)), true);
  assert.equal(hasPositions(live, S, at(100), at(160)), false, 'positions outside the window do not count');
  assert.equal(hasPositions([P(5, 42.5, null, false, { accuracy: 500 })], S, at(0), at(60)), false, 'a position that is not accepted does not count');
});

test('instant: a date argument must be a string ending in Z or an offset', () => {
  assert.equal(instant('2026-10-10T00:00:00Z').toISOString(), '2026-10-10T00:00:00.000Z');
  assert.equal(instant('2026-10-10T02:00:00+02:00').toISOString(), '2026-10-10T00:00:00.000Z');
  for (const bad of [null, undefined, '', '2026-10-10T00:00:00', '2026-10-10', 'yesterday']) assert.ok(isNaN(instant(bad)), String(bad));
});
