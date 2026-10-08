'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { segment, classOf, encodeMotion, decodeMotion } = require('../srv/lib/segmenter');
const { haversineM } = require('../srv/lib/geo');

const S = { stillMinutes: 30, stillRadiusM: 50, minTripPoints: 3, maxAccuracyM: 100, modeMinutes: 5, stopMinutes: 10, walkMinM: 500, gapMinutes: 15 };
const HOME = 'home', SHOP = 'shop', WORK = 'work';
const t0 = Date.parse('2026-09-22T08:00:00Z');
const at = (min) => new Date(t0 + min * 60000);
const iso = (d) => d.toISOString();
// ~0.001 deg lat ≈ 111 m
// flags: { base, visit }; act: iOS motion activities as the runner passes them ("walking", "stationary,automotive", ...)
const P = (min, lat, lon, zone = null, flags = {}, acc = 5, act = null) => ({
  ts: at(min), lat, lon, accuracy: acc, zone_ID: zone, zoneIsBase: !!flags.base, zoneCreatesVisit: !!flags.visit, activities: act,
});
const B = { base: true }, V = { visit: true };
const fresh = () => ({ device: 'iphone', lastTS: null, lastZone_ID: null, lastZoneIsBase: false, anchor: null, openTrip: null, motion: null });

// Local metric grid around the synthetic origin 42.50/1.50: x east, y north, in metres.
const M = (x, y) => ({ lat: 42.5 + y / 111320, lon: 1.5 + x / (111320 * Math.cos((42.5 * Math.PI) / 180)) });
const F = (ts, xy, act, zone = null, flags = {}) => ({ ts, ...M(...xy), accuracy: 5, zone_ID: zone, zoneIsBase: !!flags.base, zoneCreatesVisit: !!flags.visit, activities: act });

// ---------------------------------------------------------------- existing behaviour, no motion data

test('classOf maps iOS motion activities', () => {
  assert.equal(classOf('automotive'), 'drive');
  assert.equal(classOf('stationary,automotive'), 'drive');
  assert.equal(classOf('walking'), 'foot');
  assert.equal(classOf('running'), 'foot');
  assert.equal(classOf('cycling'), 'foot');
  assert.equal(classOf('stationary'), 'still');
  assert.equal(classOf(''), null);
  assert.equal(classOf(null), null);
  assert.equal(classOf('unknown'), null);
});

test('leaving home opens a trip; a plain zone on the way only emits events; entering home closes the trip', () => {
  const pts = [
    P(0, 42.5, 1.5, HOME, B), P(5, 42.5, 1.5, HOME, B),
    P(10, 42.51, 1.5), P(15, 42.52, 1.5), P(20, 42.53, 1.5, SHOP), P(25, 42.53, 1.5, SHOP),
    P(30, 42.52, 1.5), P(35, 42.51, 1.5), P(40, 42.5, 1.5, HOME, B),
  ];
  const { events, trips, state } = segment(pts, fresh(), S);
  assert.deepEqual(events.map((e) => [e.kind, e.zone_ID, iso(e.at)]), [
    ['enter', HOME, iso(at(0))],
    ['leave', HOME, iso(at(5))], ['enter', SHOP, iso(at(20))],
    ['leave', SHOP, iso(at(25))], ['enter', HOME, iso(at(40))],
  ]);
  assert.equal(trips.length, 1);
  assert.equal(iso(trips[0].startedAt), iso(at(5)));
  assert.equal(iso(trips[0].endedAt), iso(at(40)));
  assert.equal(trips[0].startZone_ID, HOME); assert.equal(trips[0].endZone_ID, HOME);
  assert.equal(trips[0].points.length, 8);
  assert.equal(trips[0].kind, null, 'no motion data: the runner decides the kind by speed');
  assert.equal(state.openTrip, null);
});

test('fallback without motion data: stillness closes a trip at the anchor time; a later move opens a new one', () => {
  const pts = [P(0, 42.5, 1.5), P(5, 42.51, 1.5), P(10, 42.52, 1.5),
    P(15, 42.52, 1.5), P(30, 42.52, 1.5001), P(45, 42.52, 1.5), // still for 35 min
    P(50, 42.53, 1.5), P(55, 42.54, 1.5)];
  const { trips, state } = segment(pts, fresh(), S);
  assert.equal(trips.length, 1);
  assert.equal(iso(trips[0].endedAt), iso(at(10)));
  assert.ok(state.openTrip, 'second trip open');
  assert.equal(iso(state.openTrip.startedAt), iso(at(45)));
});

test('starts inside a base zone: no trip, no invented leave', () => {
  const { events, trips, state } = segment([P(0, 42.5, 1.5, HOME, B), P(5, 42.5, 1.5, HOME, B)], fresh(), S);
  assert.deepEqual(events.map((e) => e.kind), ['enter']);
  assert.equal(trips.length, 0); assert.equal(state.openTrip, null);
});

test('inaccurate positions are ignored entirely', () => {
  const pts = [P(0, 42.5, 1.5), P(5, 42.51, 1.5), P(10, 42.9, 1.9, SHOP, {}, 5000), P(15, 42.52, 1.5)];
  const { events, state } = segment(pts, fresh(), S);
  assert.equal(events.length, 0);
  assert.equal(state.openTrip.points.length, 3);
});

test('trips shorter than minTripPoints are dropped', () => {
  // home -> work with no fix in between: 2 points, below minTripPoints (3)
  const { trips } = segment([P(0, 42.5, 1.5, HOME, B), P(5, 42.6, 1.6, WORK, B)], fresh(), S);
  assert.equal(trips.length, 0);
});

test('two runs equal one run (watermark continuity)', () => {
  const pts = [P(0, 42.5, 1.5, HOME, B), P(5, 42.5, 1.5, HOME, B), P(10, 42.51, 1.5), P(15, 42.52, 1.5),
    P(20, 42.53, 1.5, SHOP), P(25, 42.53, 1.5, SHOP), P(30, 42.52, 1.5), P(35, 42.51, 1.5), P(40, 42.5, 1.5, HOME, B)];
  const one = segment(pts, fresh(), S);
  const a = segment(pts.slice(0, 4), fresh(), S);
  const b = segment(pts.slice(4), a.state, S);
  assert.deepEqual([...a.events, ...b.events], one.events);
  assert.deepEqual([...a.trips, ...b.trips], one.trips);
  assert.deepEqual(b.state, one.state);
});

test('resegment-reset state (lastZone_ID set, lastTS null): leave event uses the position ts, no throw', () => {
  const state = { ...fresh(), lastZone_ID: SHOP };
  const { events } = segment([P(0, 42.6, 1.6)], state, S);
  assert.deepEqual(events.map((e) => [e.kind, e.zone_ID, iso(e.at)]), [['leave', SHOP, iso(at(0))]]);
});

test('resegment-reset state with a base last zone: the trip opens at the first known position', () => {
  const state = { ...fresh(), lastZone_ID: HOME, lastZoneIsBase: true };
  const { events, state: out } = segment([P(0, 42.6, 1.6)], state, S);
  assert.deepEqual(events.map((e) => e.kind), ['leave']);
  assert.ok(out.openTrip);
  assert.equal(iso(out.openTrip.startedAt), iso(at(0)));
});

test('trip ID is deterministic from device and start time', () => {
  const pts = [P(0, 42.5, 1.5, HOME, B), P(5, 42.51, 1.5), P(10, 42.52, 1.5), P(15, 42.53, 1.5), P(20, 42.5, 1.5, HOME, B)];
  const x = segment(pts, fresh(), S), y = segment(pts, fresh(), S);
  assert.equal(x.trips[0].ID, y.trips[0].ID);
  assert.match(x.trips[0].ID, /^[0-9a-f-]{36}$/);
});

test('long stop, then leave: the trip starts at the last still position, not at the start of the stop', () => {
  const still = [];
  for (let m = 45; m <= 300; m += 15) still.push(P(m, 42.52, 1.5));
  const { trips, state } = segment([...still, P(305, 42.53, 1.5), P(310, 42.54, 1.5)], fresh(), S);
  assert.equal(trips.length, 0);
  assert.equal(iso(state.openTrip.startedAt), iso(at(300)));
  assert.deepEqual(state.openTrip.points.map(iso), [at(300), at(305), at(310)].map(iso));
});

// ---------------------------------------------------------------- visit zones

test('a visit zone confirmed by a walking fix ends the trip at arrival and starts the next at departure', () => {
  const pts = [
    P(0, 42.5, 1.5, HOME, B), P(5, 42.5, 1.5, HOME, B),
    P(10, 42.51, 1.5), P(15, 42.52, 1.5),
    P(20, 42.53, 1.5, SHOP, V), P(26, 42.53, 1.5, SHOP, V, 5, 'walking'), P(32, 42.53, 1.5, SHOP, V, 5, 'stationary'),
    P(37, 42.52, 1.5), P(42, 42.51, 1.5), P(47, 42.5, 1.5, HOME, B),
  ];
  const { events, trips, state } = segment(pts, fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.startZone_ID, t.endZone_ID]), [
    [iso(at(5)), iso(at(20)), HOME, SHOP],
    [iso(at(32)), iso(at(47)), SHOP, HOME],
  ]);
  const shop = events.filter((e) => e.zone_ID === SHOP);
  assert.deepEqual(shop.map((e) => [e.kind, iso(e.at), iso(e.positionTS), !!e.passThrough]), [
    ['enter', iso(at(20)), iso(at(26)), false], // backdated to arrival, emitted with the confirming fix
    ['leave', iso(at(32)), iso(at(37)), false],
  ]);
  assert.equal(state.openTrip, null);
});

test('a visit zone left without a walking fix is passed through: no boundary, events flagged', () => {
  // Traffic jam at the shop door: 8 minutes inside, the phone says automotive throughout.
  const pts = [
    P(0, 42.5, 1.5, HOME, B), P(1, 42.505, 1.5, null, {}, 5, 'automotive'), P(2, 42.51, 1.5, null, {}, 5, 'automotive'),
    ...[3, 4, 5, 6, 7, 8, 9, 10].map((m, i) => P(m, 42.52 + i * 0.0002, 1.5, SHOP, V, 5, i % 2 ? 'stationary,automotive' : 'automotive')),
    P(11, 42.53, 1.5, null, {}, 5, 'automotive'), P(12, 42.54, 1.5, null, {}, 5, 'automotive'), P(13, 42.5, 1.5, HOME, B, 5, 'automotive'),
  ];
  const { events, trips } = segment(pts, fresh(), S);
  assert.equal(trips.length, 1, 'the jam neither ends nor splits the drive');
  assert.equal(trips[0].kind, 'drive');
  assert.equal(trips[0].endZone_ID, HOME);
  assert.deepEqual(events.filter((e) => e.zone_ID === SHOP).map((e) => [e.kind, iso(e.at), !!e.passThrough]), [
    ['enter', iso(at(3)), true], ['leave', iso(at(10)), true],
  ]);
});

test('a visit stay confirmed in a later run than it started ends the trip at arrival', () => {
  const pts = [
    P(0, 42.5, 1.5, HOME, B), P(5, 42.51, 1.5, null, {}, 5, 'automotive'), P(10, 42.52, 1.5, null, {}, 5, 'automotive'),
    P(15, 42.53, 1.5, SHOP, V, 5, 'automotive'), P(19, 42.5301, 1.5, SHOP, V, 5, 'walking'),
  ];
  const a = segment(pts.slice(0, 4), fresh(), S);
  assert.equal(a.events.filter((e) => e.zone_ID === SHOP).length, 0, 'no event before confirmation');
  const b = segment(pts.slice(4), a.state, S);
  assert.deepEqual(b.events.map((e) => [e.kind, e.zone_ID, iso(e.at)]), [['enter', SHOP, iso(at(15))]]);
  assert.deepEqual(b.trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.endZone_ID]), [[iso(at(0)), iso(at(15)), SHOP]]);
});

test('leaving a confirmed stay after a long visit restarts the stillness clock: the departure trip is not dropped', () => {
  const pts = [
    P(0, 42.5, 1.5, HOME, B), P(5, 42.5, 1.5, HOME, B), P(10, 42.51, 1.5), P(15, 42.52, 1.5),
    P(20, 42.53, 1.5, SHOP, V), P(30, 42.53, 1.5, SHOP, V, 5, 'walking'), P(40, 42.53, 1.5, SHOP, V),
    P(50, 42.53, 1.5, SHOP, V), P(60, 42.53, 1.5, SHOP, V),
    P(65, 42.5302, 1.5), P(70, 42.54, 1.5), P(75, 42.55, 1.5),
  ];
  const { trips, state } = segment(pts, fresh(), S);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].endZone_ID, SHOP);
  assert.equal(state.openTrip.startZone_ID, SHOP);
  assert.equal(iso(state.openTrip.startedAt), iso(at(60)));
  assert.deepEqual(state.openTrip.points.map(iso), [at(60), at(65), at(70), at(75)].map(iso));
});

// ---------------------------------------------------------------- motion rules

const driveLine = (fromMin, toMin, x0, dxPerMin, act = 'automotive') => {
  const out = [];
  for (let m = fromMin; m <= toMin; m++) out.push(F(at(m), [x0 + (m - fromMin) * dxPerMin, 0], act));
  return out;
};

test('a stray walking fix and a short plain stationary pause do not split or stop a drive', () => {
  const pts = [
    F(at(0), [0, 0], 'stationary', HOME, B),
    ...driveLine(1, 8, 300, 800),
    F(at(9), [6000, 0], 'walking'),                         // one misread
    ...driveLine(10, 14, 6800, 800),
    F(at(15), [10800, 0], 'stationary'), F(at(17), [10800, 0], 'stationary'), F(at(18), [10810, 0], 'stationary'), // 3 min at a light
    ...driveLine(19, 25, 11600, 800),
    F(at(26), [0, 0], 'automotive', HOME, B),
  ];
  const { trips } = segment(pts, fresh(), S);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].kind, 'drive');
  assert.deepEqual([iso(trips[0].startedAt), iso(trips[0].endedAt)], [iso(at(0)), iso(at(26))]);
});

test('drive, stop, drive: still for stopMinutes ends the drive where the car stopped; the next drive starts at the last still fix', () => {
  const pts = [
    F(at(0), [0, 0], 'stationary', HOME, B),
    ...driveLine(1, 10, 300, 800),                          // parks at x = 7500 at minute 10
    F(at(12), [7510, 0], 'stationary'), F(at(15), [7505, 10], null), F(at(18), [7510, 5], 'stationary'),
    F(at(22), [7500, 15], 'stationary'), F(at(25), [7510, 0], 'stationary'),   // 13 min still, well under stillMinutes
    ...driveLine(27, 33, 8300, 800),
  ];
  const { trips, state } = segment(pts, fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind]), [[iso(at(0)), iso(at(10)), 'drive']]);
  assert.ok(state.openTrip);
  assert.equal(iso(state.openTrip.startedAt), iso(at(25)));
  assert.equal(state.openTrip.mode, 'drive');
});

test('a 35-minute crawl within 50 m reported as automotive stays one drive (motion evidence overrides the fallback)', () => {
  const crawl = [];
  for (let m = 12; m <= 47; m += 5) crawl.push(F(at(m), [7500 + (m - 12), 0], (m / 5) % 2 ? 'stationary,automotive' : 'automotive'));
  const pts = [F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 10, 300, 800), ...crawl, ...driveLine(48, 55, 8300, 800), F(at(56), [0, 0], 'automotive', HOME, B)];
  const { trips } = segment(pts, fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind]), [[iso(at(0)), iso(at(56)), 'drive']]);
});

test('drive, then a walk of 500 m or more, then drive again: three trips, the middle one a walk', () => {
  const walk = [];
  for (let i = 1; i <= 12; i++) walk.push(F(at(10 + i), [7500, i * 70], 'walking'));   // 840 m in 12 min
  const back = [];
  for (let i = 1; i <= 6; i++) back.push(F(at(22 + i), [7500 - i * 800, 840], 'automotive'));
  const pts = [F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 10, 300, 800), ...walk, ...back, F(at(29), [0, 0], 'automotive', HOME, B)];
  const { trips } = segment(pts, fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind]), [
    [iso(at(0)), iso(at(10)), 'drive'],   // ends at the last drive fix
    [iso(at(10)), iso(at(22)), 'walk'],   // from the car to the last walking fix
    [iso(at(22)), iso(at(29)), 'drive'],
  ]);
});

test('an on-foot stretch shorter than walkMinM is a stop, not a walk', () => {
  const walk = [];
  for (let i = 1; i <= 12; i++) walk.push(F(at(10 + i), [7500, i * 30], 'walking'));   // 360 m
  const back = [];
  for (let i = 1; i <= 6; i++) back.push(F(at(22 + i), [7500 - i * 800, 360], 'automotive'));
  const pts = [F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 10, 300, 800), ...walk, ...back, F(at(29), [0, 0], 'automotive', HOME, B)];
  const { trips } = segment(pts, fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind]), [
    [iso(at(0)), iso(at(10)), 'drive'],
    [iso(at(22)), iso(at(29)), 'drive'],
  ]);
});

test('a single stray automotive fix during a walk does not split it', () => {
  const pts = [F(at(0), [0, 0], 'stationary', HOME, B)];
  for (let i = 1; i <= 20; i++) pts.push(F(at(i), [0, i * 80], i === 10 ? 'automotive' : 'walking'));
  pts.push(F(at(21), [0, 0], 'walking', HOME, B));
  const { trips } = segment(pts, fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind]), [[iso(at(0)), iso(at(21)), 'walk']]);
});

test('GPS wander on still fixes never opens a trip', () => {
  // 8 minutes of wander, shorter than stopMinutes, so no stop rule could hide an opened trip
  const pts = [0, 2, 4, 6, 8].map((m, i) => F(at(m), [i % 2 ? 90 : 0, 0], 'stationary'));
  const { trips, state } = segment(pts, fresh(), S);
  assert.equal(trips.length, 0);
  assert.equal(state.openTrip, null);
});

test('a silent gap that ends with an automotive fix near the car still closes the parked trip at the fallback (M1)', () => {
  // Park (last drive fix at x = 7500), then 60 silent minutes (> stillMinutes = 30), then an
  // automotive fix 20 m from the car (starting the car, or walking back to it), then drive on.
  // That fix is evidence gathered by the SAME fix the fallback must judge the gap on — it must
  // not retroactively excuse the silence that already happened before it arrived.
  const pts = [
    F(at(0), [0, 0], 'stationary', HOME, B),
    ...driveLine(1, 10, 300, 800),        // parks at x = 7500 at minute 10
    F(at(70), [7520, 5], 'automotive'),   // 60 min silent, then 20 m from the anchor
    ...driveLine(71, 78, 8300, 800),
  ];
  // gapMinutes 0: with the gap rule on, the 60 minutes are a silence and the fallback is never reached
  const { trips, state } = segment(pts, fresh(), { ...S, gapMinutes: 0 });
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind]), [[iso(at(0)), iso(at(10)), 'drive']],
    'the first trip closes at the parking fix, via the fallback');
  assert.ok(state.openTrip, 'a second trip opens after the gap');
  assert.equal(iso(state.openTrip.startedAt), iso(at(70)));
  assert.equal(state.openTrip.mode, 'drive');
});

// ---------------------------------------------------------------- a day like 2026-09-23, synthetic coordinates

const T = (hms) => new Date(`2026-09-23T${hms}Z`);
const day = () => {
  const f = [
    F(T('15:00:00'), [0, 0], 'stationary', HOME, B), F(T('15:10:00'), [0, 0], 'stationary', HOME, B), F(T('15:17:48'), [0, 0], 'stationary', HOME, B),
  ];
  for (let i = 0; i < 14; i++) f.push(F(new Date(T('15:18:30').getTime() + i * 60000), [400 + i * 800, 0], 'automotive'));
  // drive-by: two fixes inside the supermarket circle, then on
  f.push(F(T('15:32:35'), [11600, 0], 'automotive', SHOP, V), F(T('15:32:51'), [11632, 0], 'stationary,automotive', SHOP, V));
  f.push(F(T('15:35:03'), [11832, 0], 'automotive'));
  for (let i = 0; i < 22; i++) f.push(F(new Date(T('15:36:00').getTime() + i * 60000), [12600 + i * 800, 0], 'automotive'));
  const P0 = 12600 + 21 * 800 + 400; // parking
  f.push(F(T('15:57:42'), [P0, 0], 'automotive'));
  // in town: two walking fixes, then mostly still (a shop), a short walk, still, and off again
  f.push(F(T('16:02:41'), [P0, 200], 'walking'), F(T('16:02:51'), [P0, 213], 'walking'), F(T('16:07:49'), [P0, 250], null),
    F(T('16:12:46'), [P0, 250], 'stationary'), F(T('16:17:50'), [P0, 251], null), F(T('16:22:49'), [P0, 300], 'stationary'),
    F(T('16:27:44'), [P0, 302], 'stationary'), F(T('16:32:51'), [P0, 313], 'stationary'), F(T('16:37:51'), [P0, 313], 'stationary'),
    F(T('16:42:51'), [P0, 338], 'walking'), F(T('16:47:49'), [P0, 483], 'stationary'), F(T('16:52:06'), [P0, 685], 'automotive'));
  for (let i = 0; i < 16; i++) f.push(F(new Date(T('16:53:00').getTime() + i * 60000), [P0 - (i + 1) * 800, 685], 'automotive'));
  // shopping: arrive by car, walk inside, stand at the till, drive home
  f.push(F(T('17:08:37'), [11600, 30], 'automotive', SHOP, V), F(T('17:12:49'), [11620, 40], 'walking', SHOP, V),
    F(T('17:17:51'), [11610, 35], 'stationary', SHOP, V));
  for (let i = 0; i < 9; i++) f.push(F(new Date(T('17:18:30').getTime() + i * 60000), [11000 - i * 1200, 0], 'automotive'));
  f.push(F(T('17:27:40'), [0, 0], 'automotive', HOME, B));
  return f;
};

test('a day like 2026-09-23: three drives, the drive-by passed through, the city a stop, one shop visit', () => {
  const { events, trips, state } = segment(day(), fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt).slice(11, 19), iso(t.endedAt).slice(11, 19), t.kind, t.startZone_ID, t.endZone_ID]), [
    ['15:17:48', '15:57:42', 'drive', HOME, null],
    ['16:47:49', '17:08:37', 'drive', null, SHOP],
    ['17:17:51', '17:27:40', 'drive', SHOP, HOME],
  ]);
  assert.deepEqual(events.map((e) => [e.kind, e.zone_ID, iso(e.at).slice(11, 19), !!e.passThrough]), [
    ['enter', HOME, '15:00:00', false],
    ['leave', HOME, '15:17:48', false],
    ['enter', SHOP, '15:32:35', true], ['leave', SHOP, '15:32:51', true],
    ['enter', SHOP, '17:08:37', false], ['leave', SHOP, '17:17:51', false],
    ['enter', HOME, '17:27:40', false],
  ]);
  assert.equal(state.openTrip, null);
});

// What the runner keeps between runs: the Watermarks columns, the reloaded open trip and motionState.
const oneFixPerRun = (pts, settings = S) => {
  const posMap = new Map(pts.map((p) => [p.ts.getTime(), p]));
  let st = fresh(); const events = [], trips = [];
  for (const p of pts) {
    const o = segment([p], st, settings);
    events.push(...o.events); trips.push(...o.trips);
    // Recompute cum the way the runner will: sum haversineM between consecutive points.
    if (o.state.openTrip && o.state.openTrip.points.length > 0) {
      const cum = [0];
      for (let i = 1; i < o.state.openTrip.points.length; i++) {
        const prev = posMap.get(o.state.openTrip.points[i - 1].getTime());
        const curr = posMap.get(o.state.openTrip.points[i].getTime());
        cum.push(cum[i - 1] + (prev && curr ? haversineM(prev, curr) : 0));
      }
      o.state.openTrip.cum = cum;
    }
    const d = decodeMotion(encodeMotion(o.state));
    st = {
      device: 'iphone', lastTS: o.state.lastTS, lastZone_ID: o.state.lastZone_ID, lastZoneIsBase: o.state.lastZoneIsBase,
      anchor: o.state.anchor && { ts: o.state.anchor.ts, lat: o.state.anchor.lat, lon: o.state.anchor.lon, zone_ID: o.state.lastZone_ID, moving: d.anchorMoving },
      openTrip: o.state.openTrip && { ...o.state.openTrip, mode: d.openTripMode },
      motion: d.motion,
    };
  }
  return { events, trips };
};

test('one fix per run through the persisted state (JSON motion) equals one batch run', () => {
  const pts = day();
  const one = segment(pts, fresh(), S);
  const inc = oneFixPerRun(pts);
  assert.deepEqual(inc.trips, one.trips);
  assert.deepEqual(inc.events, one.events);
});

test('a jam where the phone goes silent stays one drive, also one fix per run (motion evidence survives the run boundary)', () => {
  // 10 min crawling (automotive), then 25 min without motion data, all within 50 m, then on: > stillMinutes since the anchor
  const jam = [];
  for (let m = 12; m <= 22; m += 2) jam.push(F(at(m), [7500 + (m - 12), 0], 'automotive'));
  for (let m = 27; m <= 47; m += 5) jam.push(F(at(m), [7512, 0], null));
  const pts = [F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 10, 300, 800), ...jam, ...driveLine(48, 55, 8300, 800), F(at(56), [0, 0], 'automotive', HOME, B)];
  const one = segment(pts, fresh(), S);
  assert.deepEqual(one.trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind]), [[iso(at(0)), iso(at(56)), 'drive']]);
  assert.deepEqual(oneFixPerRun(pts).trips, one.trips);
});

test('parked with no motion data: the fallback still closes the drive (the arrival fix itself is no motion evidence)', () => {
  const parked = [];
  for (let m = 15; m <= 50; m += 5) parked.push(F(at(m), [7505, 5], null));
  const pts = [F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 10, 300, 800), ...parked];
  const { trips } = segment(pts, fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind]), [[iso(at(0)), iso(at(10)), 'drive']]);
});

test('encodeMotion / decodeMotion round-trip dates and survive a null column', () => {
  const { state } = segment(day().slice(0, 30), fresh(), S);
  const d = decodeMotion(encodeMotion(state));
  assert.ok(d.motion.lastDrive.ts instanceof Date);
  assert.equal(iso(d.motion.lastDrive.ts), iso(state.motion.lastDrive.ts));
  assert.equal(d.openTripMode, state.openTrip.mode);
  const empty = decodeMotion(null);
  assert.equal(empty.openTripMode, null);
  assert.equal(empty.motion.stay, null);
});

// ---------------------------------------------------------------- motion regression tests: stale runs scope

test('a walking fix outside the shop does not affect the departure trip (runs scoped to trip)', () => {
  // Insert F(T('17:18:10'), [11600, 180], 'walking') between 17:17:51 and 17:18:30 in the day.
  // The fix is outside the shop circle (y=180 is > 40+100), so it arrives after the trip has been decided.
  const dayPts = day();
  const outsideFix = F(T('17:18:10'), [11600, 180], 'walking');
  const withOutside = [
    ...dayPts.filter((f) => f.ts < T('17:18:00')),
    outsideFix,
    ...dayPts.filter((f) => f.ts > T('17:18:00')),
  ];
  const { trips } = segment(withOutside, fresh(), S);
  assert.deepEqual(
    trips.slice(2).map((t) => [iso(t.startedAt).slice(11, 19), iso(t.endedAt).slice(11, 19), t.kind, t.startZone_ID, t.endZone_ID]),
    [['17:17:51', '17:27:40', 'drive', SHOP, HOME]],
    'third trip is unaffected by the outside walking fix'
  );
});

test('a stale drive run must not turn a short walk into a drive', () => {
  // Yesterday's confirmed drive (6:00-6:08), then stationary at home; today a ~519 m walk (no
  // single run spans modeMinutes, so no mode is confirmed and walkMinM does not apply), then home.
  // The trip must have kind null (the runner's median-velocity fallback decides it), never
  // 'drive' carried over from yesterday's stale driveRun.
  const pts = [
    F(at(0), [0, 3000], 'automotive'), F(at(6), [0, 1000], 'automotive'), F(at(8), [0, 0], 'automotive', HOME, B),
    F(at(60), [0, 0], 'stationary', HOME, B), F(at(120), [0, 0], 'stationary', HOME, B),
    F(at(122), [0, 120], null), F(at(123), [0, 180], 'walking'), F(at(125), [0, 260], 'walking'), F(at(127), [0, 120], 'walking'),
    F(at(129), [0, 0], 'walking', HOME, B),
  ];
  const { trips } = segment(pts, fresh(), S);
  const t = trips[trips.length - 1];
  assert.equal(iso(t.startedAt), iso(at(120)));
  assert.equal(iso(t.endedAt), iso(at(129)));
  assert.equal(t.kind, null, 'no mode confirmed: kind must be null, not drive');
  assert.equal(t.startZone_ID, HOME);
  assert.equal(t.endZone_ID, HOME);
});

// Helper for "drive, then walk, then drive" scenario; factor it so both batch and incremental tests use the same positions.
const driveWalkDrivePositions = () => {
  const walk = [];
  for (let i = 1; i <= 12; i++) walk.push(F(at(10 + i), [7500, i * 70], 'walking'));   // 840 m in 12 min
  const back = [];
  for (let i = 1; i <= 6; i++) back.push(F(at(22 + i), [7500 - i * 800, 840], 'automotive'));
  return [F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 10, 300, 800), ...walk, ...back, F(at(29), [0, 0], 'automotive', HOME, B)];
};

test('drive, then walk, then drive (batch): three trips with the middle one a walk', () => {
  const pts = driveWalkDrivePositions();
  const { trips } = segment(pts, fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind]), [
    [iso(at(0)), iso(at(10)), 'drive'],   // ends at the last drive fix
    [iso(at(10)), iso(at(22)), 'walk'],   // from the car to the last walking fix
    [iso(at(22)), iso(at(29)), 'drive'],
  ]);
});

test('drive, then walk, then drive (one fix per run): incremental equals batch', () => {
  const pts = driveWalkDrivePositions();
  const one = segment(pts, fresh(), S);
  const inc = oneFixPerRun(pts);
  assert.deepEqual(inc.trips, one.trips, 'trips equal');
  assert.deepEqual(inc.events, one.events, 'events equal');
});

// ---------------------------------------------------------------- silence: gaps longer than gapMinutes are not bridged

test('gap: an open trip ends at the last position before the silence, in that position\'s zone', () => {
  const home = [F(at(60), [0, 0], 'stationary', HOME, B), F(at(65), [0, 0], 'stationary', HOME, B)];
  // drives off, last fix at minute 8, then 52 silent minutes, then at Home
  const open = segment([F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 8, 300, 800), ...home], fresh(), S);
  assert.deepEqual(open.trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind, t.startZone_ID, t.endZone_ID, t.points.length]),
    [[iso(at(0)), iso(at(8)), 'drive', HOME, null, 9]]);
  assert.deepEqual(open.events.map((e) => [e.kind, e.zone_ID, iso(e.at)]),
    [['enter', HOME, iso(at(0))], ['leave', HOME, iso(at(0))], ['enter', HOME, iso(at(60))]]);
  assert.equal(open.state.openTrip, null);
  // the same drive, its last fix inside a plain zone
  const inZone = segment([F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 7, 300, 800), F(at(8), [5900, 0], 'automotive', WORK), ...home], fresh(), S);
  assert.deepEqual(inZone.trips.map((t) => [iso(t.endedAt), t.endZone_ID]), [[iso(at(8)), WORK]]);
});

test('gap: a part of two positions before the silence is dropped', () => {
  const pts = [F(at(0), [0, 0], null), F(at(5), [400, 0], 'walking'), F(at(40), [5000, 0], 'walking')];
  const { trips, state } = segment(pts, fresh(), S);
  assert.deepEqual(trips, []);
  assert.equal(state.openTrip, null);
});

test('gap: leaving Home across the silence gives the leave event, timed at the last position at Home, and no trip', () => {
  // 13 hours silent, one position 19 km away, 4 hours silent, back at Home
  const pts = [P(0, 42.5, 1.5, HOME, B), P(5, 42.5, 1.5, HOME, B), P(800, 42.67, 1.5, null, {}, 5, 'walking'),
    P(1060, 42.5, 1.5, HOME, B), P(1065, 42.5, 1.5, HOME, B)];
  const { events, trips, state } = segment(pts, fresh(), S);
  assert.deepEqual(trips, []);
  assert.equal(state.openTrip, null);
  assert.deepEqual(events.map((e) => [e.kind, e.zone_ID, iso(e.at), iso(e.positionTS)]), [
    ['enter', HOME, iso(at(0)), iso(at(0))], ['leave', HOME, iso(at(5)), iso(at(800))], ['enter', HOME, iso(at(1060)), iso(at(1060))],
  ]);
});

test('gap: leaving Home across the silence, then a recorded walk: the trip starts after the silence', () => {
  const pts = [F(at(0), [0, 0], 'stationary', HOME, B), F(at(5), [0, 0], 'stationary', HOME, B),
    ...[65, 70, 75, 80, 85].map((m, i) => F(at(m), [3000 + i * 300, 0], 'walking'))];   // 60 silent minutes, then 3 km away
  const { events, trips, state } = segment(pts, fresh(), S);
  assert.deepEqual(events.map((e) => [e.kind, e.zone_ID, iso(e.at)]), [['enter', HOME, iso(at(0))], ['leave', HOME, iso(at(5))]]);
  assert.deepEqual(trips, []);
  assert.equal(iso(state.openTrip.startedAt), iso(at(65)));
  assert.equal(state.openTrip.startZone_ID, null);
  assert.equal(state.openTrip.points.length, 5);
  assert.ok(Math.abs(state.openTrip.cum.at(-1) - 1200) < 2, `1200 m walked, not ${Math.round(state.openTrip.cum.at(-1))}`);
  assert.equal(state.openTrip.mode, 'foot');
});

test('gap: the next trip starts at the first position after the silence, and the jump adds no length', () => {
  const pts = [F(at(0), [0, 0], null), F(at(5), [400, 0], 'walking'),
    F(at(40), [5000, 0], 'walking'), F(at(45), [5400, 0], 'walking'), F(at(50), [5800, 0], 'walking'), F(at(55), [6200, 0], 'walking')];
  const { trips, state } = segment(pts, fresh(), S);
  assert.deepEqual(trips, []);
  assert.equal(iso(state.openTrip.startedAt), iso(at(40)));
  assert.equal(state.openTrip.startZone_ID, null);
  assert.deepEqual(state.openTrip.points.map(iso), [40, 45, 50, 55].map((m) => iso(at(m))));
  assert.ok(Math.abs(state.openTrip.cum.at(-1) - 1200) < 2, `1200 m walked after the gap, not ${Math.round(state.openTrip.cum.at(-1))}`);
});

test('gap: drive fixes before and after the silence do not confirm a mode together', () => {
  // 3 minutes of driving, 20 silent minutes, 3 minutes of driving: neither run reaches modeMinutes
  const pts = [F(at(0), [0, 0], null), ...driveLine(1, 4, 800, 800), ...driveLine(24, 27, 20000, 800)];
  const { trips, state } = segment(pts, fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind, t.points.length]), [[iso(at(0)), iso(at(4)), null, 5]]);
  assert.equal(iso(state.openTrip.startedAt), iso(at(24)));
  assert.equal(state.openTrip.mode, null);
});

test('gap: exactly gapMinutes between two positions is no gap, one second more is', () => {
  const drive = [F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 8, 300, 800)];
  const exact = segment([...drive, F(at(23), [6000, 0], 'automotive')], fresh(), S);
  assert.deepEqual(exact.trips, []);
  assert.equal(exact.state.openTrip.points.length, 10);
  const over = segment([...drive, F(new Date(at(23).getTime() + 1000), [6000, 0], 'automotive')], fresh(), S);
  assert.deepEqual(over.trips.map((t) => iso(t.endedAt)), [iso(at(8))]);
  assert.equal(over.state.openTrip, null);
});

test('gap: silence between two positions at Home gives no event and no trip', () => {
  const { events, trips, state } = segment([P(0, 42.5, 1.5, HOME, B), P(5, 42.5, 1.5, HOME, B), P(400, 42.5, 1.5, HOME, B)], fresh(), S);
  assert.deepEqual(events.map((e) => [e.kind, iso(e.at)]), [['enter', iso(at(0))]]);
  assert.deepEqual(trips, []);
  assert.equal(state.openTrip, null);
});

test('gap: silence inside a confirmed stay, then elsewhere: the leave is timed at the last position inside, no trip starts at the stay', () => {
  const pts = [
    F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 8, 300, 800),
    F(at(9), [6000, 0], 'automotive', SHOP, V), F(at(11), [6010, 5], 'walking', SHOP, V), F(at(16), [6015, 5], 'walking', SHOP, V),
    F(at(90), [12000, 0], 'automotive'),   // 74 silent minutes, then far away
    ...driveLine(91, 97, 12800, 800),
  ];
  const { events, trips, state } = segment(pts, fresh(), S);
  assert.deepEqual(events.map((e) => [e.kind, e.zone_ID, iso(e.at)]), [
    ['enter', HOME, iso(at(0))], ['leave', HOME, iso(at(0))], ['enter', SHOP, iso(at(9))], ['leave', SHOP, iso(at(16))],
  ]);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind, t.endZone_ID]), [[iso(at(0)), iso(at(9)), 'drive', SHOP]]);
  assert.equal(iso(state.openTrip.startedAt), iso(at(90)));
  assert.equal(state.openTrip.startZone_ID, null);
});

test('gap: a position the accuracy limit rejects does not end the silence', () => {
  const pts = [F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 8, 300, 800),
    { ...F(at(15), [7000, 0], 'automotive'), accuracy: 5000 },   // 7 min after the last fix, but skipped
    F(at(30), [9000, 0], 'automotive')];                         // 22 min after the last accepted fix
  const { trips, state } = segment(pts, fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.endedAt), t.points.length]), [[iso(at(8)), 9]]);
  assert.equal(state.openTrip, null);
});

test('gap: gapMinutes 0 or absent switches the rule off', () => {
  const pts = [F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 8, 300, 800), F(at(60), [0, 0], 'stationary', HOME, B)];
  const { gapMinutes, ...without } = S;
  for (const settings of [{ ...S, gapMinutes: 0 }, without]) {
    const { trips } = segment(pts, fresh(), settings);
    assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.endZone_ID, t.points.length]), [[iso(at(0)), iso(at(60)), HOME, 10]]);
  }
  assert.equal(gapMinutes, 15);
});

// A cut-off drive, a stub of two positions, and a walk home: two silences.
const gapDay = () => [
  F(at(0), [0, 0], 'stationary', HOME, B), F(at(5), [0, 0], 'stationary', HOME, B),
  ...driveLine(6, 12, 300, 800),                                          // silent after minute 12
  F(at(52), [9000, 0], 'walking'), F(at(53), [9000, 70], 'walking'),      // silent after minute 53
  ...[83, 88, 93, 98].map((m, i) => F(at(m), [900 - i * 280, 0], 'walking')),
  F(at(103), [0, 0], 'walking', HOME, B),
];

test('gap: a day with two silences (batch): the cut-off drive and the walk home, the stub dropped', () => {
  const { trips, events, state } = segment(gapDay(), fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind, t.startZone_ID, t.endZone_ID, t.points.length]), [
    [iso(at(5)), iso(at(12)), 'drive', HOME, null, 8],
    [iso(at(83)), iso(at(103)), 'walk', null, HOME, 5],
  ]);
  assert.deepEqual(events.map((e) => [e.kind, e.zone_ID, iso(e.at)]),
    [['enter', HOME, iso(at(0))], ['leave', HOME, iso(at(5))], ['enter', HOME, iso(at(103))]]);
  assert.equal(state.openTrip, null);
});

test('gap: a day with two silences (one fix per run): incremental equals batch', () => {
  const one = segment(gapDay(), fresh(), S);
  const inc = oneFixPerRun(gapDay());
  assert.deepEqual(inc.trips, one.trips, 'trips equal');
  assert.deepEqual(inc.events, one.events, 'events equal');
});

test('parked, fixes without motion data every 14 minutes (no silence), then an automotive fix: the fallback closes at the parking fix', () => {
  // The same guard as M1 with the gap rule on: no two fixes are more than gapMinutes apart, so only the
  // fallback can close the drive, and the automotive fix at minute 44 must not excuse the 34 minutes before it.
  const pts = [
    F(at(0), [0, 0], 'stationary', HOME, B),
    ...driveLine(1, 10, 300, 800),                                  // parks at x = 7500 at minute 10
    F(at(24), [7505, 5], null), F(at(38), [7510, 0], null),
    F(at(44), [7520, 5], 'automotive'),                             // 20 m from the parking fix
  ];
  const { trips, state } = segment(pts, fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind]), [[iso(at(0)), iso(at(10)), 'drive']]);
  assert.equal(state.openTrip, null);
});

// A drive, a silence, then a short drive and a walk: the trip after the silence is measured from its own fixes.
const driveSilenceDriveWalk = () => [
  F(at(0), [0, 0], 'stationary'), ...driveLine(1, 8, 300, 800),                                              // silent after minute 8
  F(at(68), [20000, 0], 'automotive'), F(at(71), [20600, 0], 'automotive'), F(at(73), [21000, 0], 'automotive'),
  ...Array.from({ length: 12 }, (_, i) => F(at(74 + i), [21000, (i + 1) * 70], 'walking')),                   // 840 m on foot
];

test('gap: a drive run alive before the silence does not swallow the first drive fix after it', () => {
  const { trips, state } = segment(driveSilenceDriveWalk(), fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind, t.points.length]), [
    [iso(at(0)), iso(at(8)), 'drive', 9],
    [iso(at(68)), iso(at(73)), 'drive', 3],   // 68 to 73 is five minutes of driving: confirmed by its own fixes
  ]);
  assert.equal(iso(state.openTrip.startedAt), iso(at(73)));
  assert.equal(state.openTrip.mode, 'foot');
  assert.ok(Math.abs(state.openTrip.cum.at(-1) - 840) < 2, `840 m on foot, not ${Math.round(state.openTrip.cum.at(-1))} m`);
});

test('gap: the positions after the silence give the same trips from the state a resegment resets to', () => {
  const all = driveSilenceDriveWalk(), last = all[8];   // the fix at minute 8, the last one before the silence
  const batch = segment(all, fresh(), S);
  // resegmentRaw's reset: the position before the cut as anchor and last position, no open trip, no motion runs
  const reset = { device: 'iphone', lastTS: last.ts, lastZone_ID: null, lastZoneIsBase: false,
    anchor: { ts: last.ts, lat: last.lat, lon: last.lon, zone_ID: null }, openTrip: null, motion: { lastPoint: { lat: last.lat, lon: last.lon } } };
  const after = segment(all.slice(9), reset, S);
  assert.deepEqual(after.trips, batch.trips.slice(1));
  assert.deepEqual(after.state.openTrip, batch.state.openTrip);
});

test('gap: a foot run alive before the silence does not swallow the first walking fix after it', () => {
  // the mirror image: a walk, a silence, five minutes on foot, then a drive
  const pts = [
    F(at(0), [0, 0], 'stationary'), ...Array.from({ length: 8 }, (_, i) => F(at(1 + i), [(i + 1) * 80, 0], 'walking')),   // silent after minute 8
    F(at(68), [20000, 0], 'walking'), F(at(71), [20300, 0], 'walking'), F(at(73), [20550, 0], 'walking'),
    ...driveLine(74, 85, 21350, 800),
  ];
  const { trips, state } = segment(pts, fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind, t.points.length]), [
    [iso(at(0)), iso(at(8)), 'walk', 9],
    [iso(at(68)), iso(at(73)), 'walk', 3],   // 550 m in five minutes on foot: confirmed by its own fixes
  ]);
  assert.equal(iso(state.openTrip.startedAt), iso(at(73)));
  assert.equal(state.openTrip.mode, 'drive');
});

// ---------------------------------------------------------------- silence after a stop: the trip ends where it stopped

const backHome = (min) => [F(at(min), [0, 0], 'stationary', HOME, B), F(at(min + 5), [0, 0], 'stationary', HOME, B)];
// A drive whose last driving fix (minute 8, x = 5900) lies in a plain zone, then three fixes of `act` there, then silence.
const parkedDrive = (act, step = 0) => [
  F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 7, 300, 800), F(at(8), [5900, 0], 'automotive', WORK),
  ...[10, 12, 14].map((m, i) => F(at(m), [5900 + (i + 1) * step, 5], act)),
  ...backHome(74),
];
const tripRows = (trips) => trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind, t.endZone_ID, t.points.length]);

test('gap: a drive parked and still before the silence ends at its last driving position, in that position\'s zone', () => {
  const { trips, state } = segment(parkedDrive('stationary'), fresh(), S);   // still for 4 minutes: the stop rule has not fired
  assert.deepEqual(tripRows(trips), [[iso(at(0)), iso(at(8)), 'drive', WORK, 9]]);
  assert.equal(state.openTrip, null);
});

test('gap: a drive left on foot before the silence ends at its last driving position; the steps belong to no trip', () => {
  const { trips, state } = segment(parkedDrive('walking', 70), fresh(), S);  // 4 minutes on foot: no mode confirmed
  assert.deepEqual(tripRows(trips), [[iso(at(0)), iso(at(8)), 'drive', WORK, 9]]);
  assert.equal(state.openTrip, null);
});

test('gap: a walk resting before the silence ends where the rest began', () => {
  const pts = [F(at(0), [0, 0], 'stationary'), ...Array.from({ length: 10 }, (_, i) => F(at(1 + i), [(i + 1) * 80, 0], 'walking')),
    F(at(11), [805, 0], 'stationary', WORK), F(at(14), [805, 5], 'stationary', WORK), F(at(17), [800, 5], 'stationary'),   // 6 minutes still
    ...backHome(77)];
  const { trips, state } = segment(pts, fresh(), S);
  assert.deepEqual(tripRows(trips), [[iso(at(0)), iso(at(11)), 'walk', WORK, 12]]);
  assert.equal(state.openTrip, null);
});

test('gap: a drive followed by positions without motion data ends at the last position before the silence', () => {
  // no evidence that the driving stopped: the positions after the last driving fix may be driving
  const { trips } = segment(parkedDrive(null, 800), fresh(), S);
  assert.deepEqual(tripRows(trips), [[iso(at(0)), iso(at(14)), 'drive', null, 12]]);
});

test('gap: a drive left on foot before the silence (one fix per run): incremental equals batch', () => {
  const one = segment(parkedDrive('walking', 70), fresh(), S);
  const inc = oneFixPerRun(parkedDrive('walking', 70));
  assert.deepEqual(tripRows(inc.trips), [[iso(at(0)), iso(at(8)), 'drive', WORK, 9]]);
  assert.deepEqual(inc.trips, one.trips, 'trips equal');
  assert.deepEqual(inc.events, one.events, 'events equal');
});

// ---------------------------------------------------------------- a trip from Home back to Home: only the positions outside count

// The phone at Home, `outside` positions beyond the zone, then at Home again.
const awayAndBack = (outside, act = 'walking') => [
  F(at(0), [0, 0], 'stationary', HOME, B), F(at(5), [0, 0], 'stationary', HOME, B),
  ...outside.map(([min, x]) => F(at(min), [x, 0], act)),
  F(at(15), [0, 0], 'stationary', HOME, B), F(at(20), [0, 0], 'stationary', HOME, B),
];

test('a single stray position outside Home between two at Home is no trip; the zone events stay', () => {
  const { trips, events, state } = segment(awayAndBack([[7, 312]], null), fresh(), S);
  assert.deepEqual(trips, []);
  assert.equal(state.openTrip, null);
  assert.deepEqual(events.map((e) => [e.kind, e.zone_ID, iso(e.at)]),
    [['enter', HOME, iso(at(0))], ['leave', HOME, iso(at(5))], ['enter', HOME, iso(at(15))]]);
});

test('a trip from Home back to Home needs minTripPoints positions outside: two are too few, three are a trip', () => {
  const two = segment(awayAndBack([[7, 320], [9, 400]]), fresh(), S);
  assert.deepEqual(two.trips, []);
  assert.equal(two.state.openTrip, null);
  const three = segment(awayAndBack([[7, 320], [9, 400], [11, 320]]), fresh(), S);
  assert.deepEqual(three.trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.startZone_ID, t.endZone_ID, t.points.length]),
    [[iso(at(5)), iso(at(15)), HOME, HOME, 5]]);
});

test('a trip that arrives at Home from elsewhere still counts every position: two outside and the arrival are a trip', () => {
  const pts = [F(at(0), [900, 0], null), F(at(3), [600, 0], 'walking'), F(at(6), [0, 0], 'walking', HOME, B)];
  const { trips } = segment(pts, fresh(), S);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.startZone_ID, t.endZone_ID, t.points.length]),
    [[iso(at(0)), iso(at(6)), null, HOME, 3]]);
});

test('a single stray position outside Home (one fix per run): incremental equals batch', () => {
  const one = segment(awayAndBack([[7, 312]], null), fresh(), S);
  const inc = oneFixPerRun(awayAndBack([[7, 312]], null));
  assert.deepEqual(inc.trips, []);
  assert.deepEqual(inc.trips, one.trips, 'trips equal');
  assert.deepEqual(inc.events, one.events, 'events equal');
});

// ---------------------------------------------------------------- accuracy by place: stricter outside every zone

const A = { ...S, maxAccuracyM: 50, maxAccuracyOutsideM: 35 };
const acc = (p, accuracy) => ({ ...p, accuracy });
// The phone at Home at night; three junk positions outside, seconds apart; silence; at Home again.
const nightJunk = (accuracy = 46) => [
  F(at(0), [0, 0], 'stationary', HOME, B), F(at(5), [0, 0], 'stationary', HOME, B),
  ...[[5.1, 352], [5.15, 415], [5.2, 483]].map(([min, x]) => acc(F(at(min), [x, 0], null), accuracy)),
  F(at(45), [0, 0], 'stationary', HOME, B), F(at(50), [0, 0], 'stationary', HOME, B),
];
const stepsOf = (accuracy) => [F(at(0), [0, 0], null), F(at(2), [100, 0], 'walking'), acc(F(at(4), [200, 0], 'walking'), accuracy), F(at(6), [300, 0], 'walking')];
const minutes = (ms) => ms.map((m) => iso(at(m)));

test('accuracy: junk outside Home, less accurate than the limit outside zones, leaves no trip and no event', () => {
  const { trips, events, state } = segment(nightJunk(), fresh(), A);
  assert.deepEqual(trips, []);
  assert.equal(state.openTrip, null);
  assert.deepEqual(events.map((e) => [e.kind, e.zone_ID, iso(e.at)]), [['enter', HOME, iso(at(0))]]);
});

test('accuracy: outside zones a position of exactly maxAccuracyOutsideM counts, one metre worse does not', () => {
  assert.deepEqual(segment(stepsOf(35), fresh(), A).state.openTrip.points.map(iso), minutes([0, 2, 4, 6]));
  assert.deepEqual(segment(stepsOf(36), fresh(), A).state.openTrip.points.map(iso), minutes([0, 2, 6]));
});

test('accuracy: inside a zone the limit stays maxAccuracyM, so a walking position of 45 m confirms the visit', () => {
  const pts = [F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 8, 300, 800),
    F(at(9), [6000, 0], 'automotive', SHOP, V), acc(F(at(11), [6010, 5], 'walking', SHOP, V), 45)];
  const { events, trips } = segment(pts, fresh(), A);
  assert.deepEqual(events.map((e) => [e.kind, e.zone_ID, iso(e.at)]),
    [['enter', HOME, iso(at(0))], ['leave', HOME, iso(at(0))], ['enter', SHOP, iso(at(9))]]);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind, t.endZone_ID, t.points.length]), [[iso(at(0)), iso(at(9)), 'drive', SHOP, 10]]);
});

test('accuracy: a drive with one poor position outside zones in its middle stays one trip, without that position', () => {
  const line = driveLine(1, 8, 300, 800);
  line[3] = acc(line[3], 40);   // the position at minute 4
  const { trips } = segment([F(at(0), [0, 0], 'stationary', HOME, B), ...line, F(at(9), [0, 0], 'automotive', HOME, B)], fresh(), A);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind, t.points.length]), [[iso(at(0)), iso(at(9)), 'drive', 9]]);
  assert.deepEqual(trips[0].points.map(iso), minutes([0, 1, 2, 3, 5, 6, 7, 8, 9]));
});

test('accuracy: poor positions outside zones for longer than gapMinutes are a silence, the trip ends at the last accepted one', () => {
  const pts = [F(at(0), [0, 0], 'stationary', HOME, B), ...driveLine(1, 8, 300, 800),
    ...driveLine(9, 28, 6700, 800).map((p) => acc(p, 40)),   // 20 minutes of poor reception
    ...driveLine(29, 36, 22700, 800)];
  const { trips, state } = segment(pts, fresh(), A);
  assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.kind, t.points.length]), [[iso(at(0)), iso(at(8)), 'drive', 9]]);
  assert.equal(iso(state.openTrip.startedAt), iso(at(29)));
});

test('accuracy: maxAccuracyOutsideM 0 or absent switches the rule off, and maxAccuracyM is then the limit outside too', () => {
  const { maxAccuracyOutsideM, ...without } = A;
  for (const settings of [{ ...A, maxAccuracyOutsideM: 0 }, without]) {
    const { trips } = segment(nightJunk(), fresh(), settings);
    assert.deepEqual(trips.map((t) => [iso(t.startedAt), iso(t.endedAt), t.startZone_ID, t.endZone_ID, t.points.length]),
      [[iso(at(5)), iso(at(5.2)), HOME, null, 4]], 'the junk of 46 m is accepted, as before the rule');
    assert.deepEqual(segment(nightJunk(60), fresh(), settings).trips, [], 'junk of 60 m is over maxAccuracyM');
  }
  assert.equal(maxAccuracyOutsideM, 35);
});

test('accuracy: junk outside Home (one fix per run): incremental equals batch', () => {
  const one = segment(nightJunk(), fresh(), A);
  const inc = oneFixPerRun(nightJunk(), A);
  assert.deepEqual(inc.trips, []);
  assert.deepEqual(inc.trips, one.trips, 'trips equal');
  assert.deepEqual(inc.events, one.events, 'events equal');
});

test('accuracy: a limit outside larger than the one inside is taken as it is', () => {
  const pts = [F(at(0), [0, 0], null), F(at(2), [100, 0], 'walking'), acc(F(at(4), [200, 0], 'walking'), 55),
    acc(F(at(6), [300, 0], 'walking', WORK), 55), F(at(8), [400, 0], 'walking')];
  const { events, state } = segment(pts, fresh(), { ...A, maxAccuracyOutsideM: 60 });
  assert.deepEqual(state.openTrip.points.map(iso), minutes([0, 2, 4, 8]), '55 m outside counts, 55 m inside the zone does not');
  assert.deepEqual(events, [], 'the skipped position gave its zone no event');
});

test('accuracy: a position without an accuracy value outside zones counts', () => {
  assert.deepEqual(segment(stepsOf(null), fresh(), A).state.openTrip.points.map(iso), minutes([0, 2, 4, 6]));
});

// ---------------------------------------------------------------- the night of 2026-10-06: junk fixes and the stray rule for every trip

const SV = { ...S, maxAccuracyM: 50, maxAccuracyOutsideM: 35, maxVerticalAccuracyOutsideM: 100 };
const home = (min, act = 'stationary') => P(min, 42.5, 1.5, HOME, B, 20, act);
// A fix as the offline phone reported them that night: 679 and 1049 m out, 34 and 35 m horizontal, 147 and 160 m vertical.
const junk = (min, lat, acc, vac, act = null) => ({ ...P(min, lat, 1.5, null, {}, acc, act), verticalAccuracy: vac });

test('vertical accuracy: two junk fixes outside Home with a vertical accuracy over the limit leave no trip and no event', () => {
  const pts = [home(0), home(5), junk(9, 42.506, 34, 147), junk(10, 42.509, 35, 160), home(27), home(32)];
  const { events, trips } = segment(pts, fresh(), SV);
  assert.deepEqual(trips, []);
  assert.deepEqual(events.map((e) => [e.kind, e.zone_ID, iso(e.at)]), [['enter', HOME, iso(at(0))]], 'only the first position at Home');
});

test('vertical accuracy: the same fixes with a good vertical accuracy are positions like any other', () => {
  const pts = [home(0), home(5), junk(9, 42.506, 34, 15), junk(10, 42.509, 35, 12), junk(11, 42.512, 30, 10), home(27), home(32)];
  const { trips } = segment(pts, fresh(), SV);
  assert.equal(trips.length, 1);
});

test('every trip needs minTripPoints positions outside the zone it set out from: two outside Home, then a silence, is no trip', () => {
  // Without the vertical rule (the limit off), the two fixes count; the silence afterwards closed such a trip at its last fix.
  const S0 = { ...SV, maxVerticalAccuracyOutsideM: 0 };
  const pts = [home(0), home(5), junk(9, 42.506, 34, 147), junk(10, 42.509, 35, 160), home(27), home(32)];
  assert.deepEqual(segment(pts, fresh(), S0).trips, []);
  const three = [home(0), home(5), junk(9, 42.506, 34, 147), junk(10, 42.509, 35, 160), junk(11, 42.512, 30, 10), home(28), home(33)];
  assert.equal(segment(three, fresh(), S0).trips.length, 1, 'three outside are a trip');
});

test('every trip needs minTripPoints positions outside the zone it set out from: the start position at Home does not count', () => {
  // Home to the shop with two positions on the way: the start fix at Home plus two is not three outside Home.
  const pts = [home(0), home(5), P(10, 42.51, 1.5), P(15, 42.52, 1.5), P(20, 42.53, 1.5, SHOP), P(25, 42.53, 1.5, SHOP), P(60, 42.53, 1.5, SHOP)];
  assert.deepEqual(segment(pts, fresh(), SV).trips.map((t) => t.endZone_ID), [SHOP], 'two on the way plus the arrival are three outside Home');
  // One on the way, then the arrival and a 40-minute stillness at the shop: the trip ends where the stillness
  // began, with the start fix at Home plus two outside it, and two are too few.
  const short = [home(0), home(5), P(10, 42.51, 1.5), P(20, 42.53, 1.5, SHOP), P(60, 42.53, 1.5, SHOP)];
  assert.deepEqual(segment(short, fresh(), SV).trips, [], 'one on the way plus the arrival are two');
});

// ---------------------------------------------------------------- Home sleep (2026-10-06): the phone's GPS is off inside Home,
// iOS wakes the app at the zone edge, and the first fix carries OwnTracks' region trigger "c".

const sleptAtHome = (wakeTrigger) => [
  F(at(0), [0, 0], 'stationary', HOME, B), F(at(5), [0, 0], 'stationary', HOME, B),
  { ...F(at(485), [400, 0], 'walking'), trigger: wakeTrigger },                    // eight silent hours, then the edge
  ...[487, 489, 491, 493].map((m, i) => F(at(m), [500 + i * 100, 0], 'walking')),
];

test('Home sleep: the region-triggered fix after a silence that began at Home leaves Home there, and the trip starts there, from Home', () => {
  const { events, trips, state } = segment(sleptAtHome('c'), fresh(), S);
  assert.deepEqual(events.map((e) => [e.kind, e.zone_ID, iso(e.at), iso(e.positionTS)]),
    [['enter', HOME, iso(at(0)), iso(at(0))], ['leave', HOME, iso(at(485)), iso(at(485))]]);
  assert.deepEqual(trips, []);
  assert.deepEqual([iso(state.openTrip.startedAt), state.openTrip.startZone_ID], [iso(at(485)), HOME]);
});

test('Home sleep: without the trigger the silence is a silence: the leave is timed at the last position at Home, the trip starts from nowhere', () => {
  const { events, state } = segment(sleptAtHome(null), fresh(), S);
  assert.deepEqual(events.map((e) => [e.kind, e.zone_ID, iso(e.at)]), [['enter', HOME, iso(at(0))], ['leave', HOME, iso(at(5))]]);
  assert.deepEqual([iso(state.openTrip.startedAt), state.openTrip.startZone_ID], [iso(at(485)), null]);
});

test('Home sleep: the trigger without a silence, or after a silence that began elsewhere, changes nothing', () => {
  const quick = [F(at(0), [0, 0], 'stationary', HOME, B), F(at(5), [0, 0], 'stationary', HOME, B),
    { ...F(at(10), [400, 0], 'walking'), trigger: 'c' }, F(at(12), [500, 0], 'walking'), F(at(14), [600, 0], 'walking')];
  const q = segment(quick, fresh(), S);
  assert.deepEqual(q.events.map((e) => [e.kind, iso(e.at)]), [['enter', iso(at(0))], ['leave', iso(at(5))]], 'no silence: the leave is at the last position inside, as always');
  assert.equal(iso(q.state.openTrip.startedAt), iso(at(5)));
  const elsewhere = [F(at(0), [5000, 0], 'stationary'), F(at(5), [5000, 0], 'stationary'),
    { ...F(at(485), [5400, 0], 'walking'), trigger: 'c' }, F(at(487), [5500, 0], 'walking'), F(at(489), [5600, 0], 'walking')];
  const e = segment(elsewhere, fresh(), S);
  assert.deepEqual(e.events, []);
  assert.deepEqual([iso(e.state.openTrip.startedAt), e.state.openTrip.startZone_ID], [iso(at(485)), null]);
});
