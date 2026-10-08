'use strict';
const cds = require('@sap/cds');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { insertPosition } = require('../srv/lib/store');
const { circleToWkt, haversineM } = require('../srv/lib/geo');
const runner = require('../srv/lib/segment-runner');
const { utcDate } = runner;

// The runner needs `srv` only to call .emit(); a script has no live IngestService.
const emitted = [];
runner.init({ emit: async (name, payload) => { emitted.push(payload.eventKey); console.log('event', name, payload.eventKey); } });

const device = 'smoke2';
const EQ = 'smoke2eq'; // device for the incremental == batch equivalence check
const PT = 'smoke2pt'; // pass-through (drive-by) check
const MO = 'smoke2mo'; // mode change and stop completing in a later run
const WR = 'smoke2wr'; // a Watch route during a trip: the close stitches it in
const HIKE = 'smoke2wr-hike';
const GP = 'smoke2gp'; // silences: a cut-off drive, a stub, a walk home
const AC = 'smoke2ac'; // accuracy by place: night junk outside Home; a poor position on the way, another in the shop
const HOME = randomUUID(), SHOP = randomUUID();

const mkCircle = (id, name, lat, lon, r, flags = {}) => cds.db.run(
  `INSERT INTO GEOTRACK_ZONES (ID, NAME, KIND, CENTRELAT, CENTRELON, RADIUSM, WKT, GEOM, ISBASE, ISPRIVATE, CREATESVISIT)
   VALUES (?, ?, 'circle', ?, ?, ?, ?, ST_GeomFromText(?, 4326), ?, ?, ?)`,
  [id, name, lat, lon, r, circleToWkt(lat, lon, r), circleToWkt(lat, lon, r), flags.base ? 1 : 0, flags.priv ? 1 : 0, flags.visit ? 1 : 0]);

// Synthetic day: 3 days ago at 08:00 UTC (past week, clear of real `iphone` data).
const day = new Date(Date.now() - 3 * 86400000);
day.setUTCHours(8, 0, 0, 0);
const at = (min) => new Date(day.getTime() + min * 60000);

const H = { lat: 42.5, lon: 1.5 }, S = { lat: 42.503, lon: 1.503 };
const lerp = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });

const row = (min, loc, zone_ID, moving, dev = device, act = null) => ({
  device: dev, ts: at(min), receivedAt: at(min), lat: loc.lat, lon: loc.lon, accuracy: 5,
  altitude: 0, velocity: moving ? 4 : 0, course: 0, battery: 90, batteryState: 2,
  connection: 'w', ssid: null, pressure: null, trigger: 't', zone_ID, isCoarsened: false,
  activities: act,
  raw: JSON.stringify({ _type: 'location', lat: loc.lat, lon: loc.lon, tst: Math.floor(at(min).getTime() / 1000) }),
});

// home x2 -> 4 moving (home -> shop) -> shop x2 -> 3 moving (shop -> home) -> home x2
const points = [
  row(0, H, HOME, false), row(5, H, HOME, false),
  row(10, lerp(H, S, 0.2), null, true), row(15, lerp(H, S, 0.4), null, true),
  row(20, lerp(H, S, 0.6), null, true), row(25, lerp(H, S, 0.8), null, true),
  row(30, S, SHOP, false), row(35, S, SHOP, false, device, 'walking'),
  row(40, lerp(S, H, 0.25), null, true), row(45, lerp(S, H, 0.5), null, true), row(50, lerp(S, H, 0.75), null, true),
  row(55, H, HOME, false), row(60, H, HOME, false),
];

// Equivalence fixture: every case where many small runs through the persisted watermark
// used to differ from one batch run.
const K = { lat: 42.506, lon: 1.5 };        // a park, in no zone
const K2 = { lat: 42.506, lon: 1.500853 };  // 70 m east of K
const FAR = { lat: 50, lon: 10 };
const W = { lat: 42.5, lon: 1.445 };      // a car park 4.5 km west of home, in no zone
const W2 = { lat: 42.49843, lon: 1.445 }; // 175 m south of it
const eqPoints = [
  row(0, H, HOME, false, EQ), row(5, H, HOME, false, EQ),
  ...[10, 15, 20, 25].map((m, i) => row(m, lerp(H, S, 0.2 * (i + 1)), null, true, EQ)),
  // shop (createsVisit: a trip boundary): the leave belongs to 08:40, not the 08:30 anchor (C1)
  row(30, S, SHOP, false, EQ), row(35, S, SHOP, false, EQ, 'walking'), row(40, S, SHOP, false, EQ),
  row(45, lerp(S, K, 1 / 3), null, true, EQ), row(50, lerp(S, K, 2 / 3), null, true, EQ),
  // still at K from 08:55: at 09:30 the trip closes at 08:55; 09:00–09:25 were tagged while it was open (I2)
  ...[55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105].map((m) => row(m, K, null, false, EQ)),
  { ...row(62, FAR, null, true, EQ), accuracy: 5000 }, // skipped by the segmenter, advances the watermark only
  // a 70 m jump opens a trip at 09:45, dropped after 30 still minutes (2 points < minTripPoints) (I1)
  ...[110, 115, 120, 125, 130, 135, 140, 145, 150, 155].map((m) => row(m, K2, null, false, EQ)),
  // leaving after the long stop: the trip starts at 10:35, the last still position (I3)
  ...[160, 165, 170].map((m, i) => row(m, lerp(K2, H, 0.25 * (i + 1)), null, true, EQ)),
  row(175, H, HOME, false, EQ), row(180, H, HOME, false, EQ),
].sort((x, y) => x.ts - y.ts);

/** Everything segmentation writes for a device, without trip IDs. */
async function snapshot(dev) {
  const trips = await cds.db.run(`SELECT STARTEDAT, ENDEDAT, STARTZONE_ID, ENDZONE_ID, POINTCOUNT, LENGTHM, DURATIONMIN, KIND, ROUTEWKT
    FROM GEOTRACK_TRIPS WHERE DEVICE = ? ORDER BY STARTEDAT`, [dev]);
  const events = await cds.db.run('SELECT DEVICE, ZONE_ID, KIND, "AT" FROM GEOTRACK_ZONEEVENTS WHERE DEVICE = ? ORDER BY "AT", KIND', [dev]);
  // tagged positions per trip (a tag pointing at a missing trip shows up under STARTEDAT null)
  const tags = await cds.db.run(`SELECT T.STARTEDAT, COUNT(*) N FROM GEOTRACK_POSITIONS P LEFT JOIN GEOTRACK_TRIPS T ON T.ID = P.TRIP_ID
    WHERE P.DEVICE = ? AND P.TRIP_ID IS NOT NULL GROUP BY T.STARTEDAT ORDER BY T.STARTEDAT`, [dev]);
  const [wm] = await cds.db.run(`SELECT SEGMENTEDTHROUGHTS, OPENTRIP_ID, ANCHORTS, ANCHORLAT, ANCHORLON, LASTZONE_ID, LASTTS
    FROM GEOTRACK_WATERMARKS WHERE DEVICE = ?`, [dev]);
  return {
    trips: trips.map((r) => ({ ...r, ROUTEWKT: r.ROUTEWKT?.toString() ?? null })), // LargeString comes back as a Buffer
    events, tags: tags.map((r) => ({ STARTEDAT: r.STARTEDAT, N: Number(r.N) })), wm,
  };
}
const brief = (x) => ({
  trips: x.trips.map((t) => `${t.STARTEDAT}..${t.ENDEDAT} pts=${t.POINTCOUNT} ${t.KIND} ${t.LENGTHM}m`),
  events: x.events.map((e) => `${e.KIND} ${e.ZONE_ID === HOME ? 'home' : e.ZONE_ID === SHOP ? 'shop' : e.ZONE_ID} ${e.AT}`),
  tags: x.tags.map((t) => `${t.STARTEDAT}: ${t.N}`),
});

async function cleanup() {
  for (const dev of [device, EQ, PT, MO, WR, GP, AC]) {
    await cds.db.run('UPDATE GEOTRACK_POSITIONS SET TRIP_ID = NULL WHERE DEVICE = ?', [dev]);
    await cds.db.run('DELETE FROM GEOTRACK_TRIPS WHERE DEVICE = ?', [dev]);
    await cds.db.run('DELETE FROM GEOTRACK_ZONEEVENTS WHERE DEVICE = ?', [dev]);
    await cds.db.run('DELETE FROM GEOTRACK_WATERMARKS WHERE DEVICE = ?', [dev]);
    await cds.db.run('DELETE FROM GEOTRACK_POSITIONS WHERE DEVICE = ?', [dev]);
  }
  await cds.db.run('DELETE FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ?', [HIKE]);
  await cds.db.run('DELETE FROM GEOTRACK_WORKOUTS WHERE ID = ?', [HIKE]);
  await cds.db.run("DELETE FROM GEOTRACK_ZONES WHERE NAME LIKE 'smoke-seg-%'");
}

(async () => {
  const started = Date.now();
  await cds.connect.to('db');
  await cleanup(); // in case a previous failed run left rows behind
  const [live] = await cds.db.run('SELECT * FROM GEOTRACK_SETTINGS WHERE ID = 1');
  assert.deepEqual([live.GAPMINUTES, live.MAXACCURACYM, live.MAXACCURACYOUTSIDEM], [15, 50, 35],
    'the settings row: gapMinutes 15, maxAccuracyM 50, maxAccuracyOutsideM 35');

  try {
    await mkCircle(HOME, 'smoke-seg-home', H.lat, H.lon, 30, { base: true });
    await mkCircle(SHOP, 'smoke-seg-shop', S.lat, S.lon, 30, { visit: true });

    // --- Equivalence: one position per run (the live cadence) == one batch resegment ---
    for (const p of eqPoints) { await insertPosition(p); await runner.run(EQ); }
    const incremental = await snapshot(EQ);
    await runner.resegment(EQ, eqPoints[0].ts);
    const batch = await snapshot(EQ);
    console.log('incremental:', brief(incremental));
    console.log('batch      :', brief(batch));
    assert.deepEqual(incremental, batch, 'one position per run must give exactly what one batch run gives');
    console.log('equivalence: incremental == batch');
    assert.equal(batch.trips.length, 3, 'home→shop, shop→park, park→home; the 70 m jump trip is dropped');
    assert.equal(batch.events.length, 5);
    const leaveShop = batch.events.find((e) => e.KIND === 'leave' && e.ZONE_ID === SHOP);
    assert.equal(utcDate(leaveShop.AT).toISOString(), at(40).toISOString(), 'leave = last position inside the shop');
    assert.deepEqual(batch.trips.map((t) => utcDate(t.STARTEDAT).toISOString()), [at(5), at(40), at(155)].map((d) => d.toISOString()));
    for (const t of batch.trips) assert.equal(t.POINTCOUNT, batch.tags.find((g) => g.STARTEDAT === t.STARTEDAT)?.N, `POINTCOUNT = tagged rows for ${t.STARTEDAT}`);

    // --- Step 4: restart continuity ---------------------------------------
    // run() always reloads state from GEOTRACK_WATERMARKS/TRIPS, never from
    // in-process memory, so calling it again after inserting more positions
    // is indistinguishable from a process restart mid-trip.
    for (const p of points.slice(0, 6)) await insertPosition(p);
    const a = await runner.run(device);
    console.log('run A (first half, trip still open):', a.events.length, 'events,', a.trips.length, 'closed trips');
    assert.equal(a.trips.length, 0, 'trip must still be open after the first half');
    const [{ OPENTRIP_ID: openAfterA }] = await cds.db.run('SELECT OPENTRIP_ID FROM GEOTRACK_WATERMARKS WHERE DEVICE = ?', [device]);

    for (const p of points.slice(6)) await insertPosition(p);
    const b = await runner.run(device);
    console.log('run B (second half, restart continuity):', b.events.length, 'events,', b.trips.length, 'closed trips');

    const tripRows = await cds.db.run('SELECT ID, STARTEDAT, ENDEDAT, STARTZONE_ID, ENDZONE_ID, POINTCOUNT, LENGTHM, DURATIONMIN, KIND, ROUTEWKT FROM GEOTRACK_TRIPS WHERE DEVICE = ? ORDER BY STARTEDAT', [device]);
    assert.equal(tripRows.length, 2, 'one trip per leg: the shop (createsVisit) is a trip boundary');
    assert.equal(tripRows[0].ID, openAfterA, 'restart continuity: run B closed the trip run A opened');
    const tripIds = tripRows.map((r) => r.ID);
    const firstTripId = tripIds[0];

    // --- Step 3: second run with no new positions must be a no-op ---------
    const c = await runner.run(device);
    console.log('run C (no new positions, idempotency check):', c.events.length, 'events,', c.trips.length, 'closed trips');
    assert.equal(c.events.length, 0, 'no new events on a repeat run');
    assert.equal(c.trips.length, 0, 'no new trips on a repeat run');

    console.log('Trips:', tripRows.map((r) => ({ ...r, ROUTEWKT: r.ROUTEWKT?.toString() })));
    const eventRows = await cds.db.run('SELECT ZONE_ID, KIND, "AT", POSITIONTS FROM GEOTRACK_ZONEEVENTS WHERE DEVICE = ? ORDER BY "AT"', [device]);
    console.log('ZoneEvents:', eventRows);
    assert.equal(eventRows.length, 5, 'enter/leave home, enter/leave shop, enter home');

    // independent haversine sum over the points each trip covers (leg 1: p[1..6], the last home
    // reading through the shop entry; leg 2: p[7..11], the last shop reading through the arrival home)
    for (const [t, tripPts] of [[tripRows[0], points.slice(1, 7)], [tripRows[1], points.slice(7, 12)]]) {
      const routeWkt = t.ROUTEWKT.toString(); // native SQL returns LargeString as a Buffer
      assert.equal(t.KIND, 'walk');
      assert.ok(routeWkt.startsWith('LINESTRING('), 'ROUTEWKT must start with LINESTRING(');
      let hsum = 0;
      for (let i = 1; i < tripPts.length; i++) hsum += haversineM(tripPts[i - 1], tripPts[i]);
      console.log('haversine sum of trip points (m):', Math.round(hsum), 'vs LENGTHM:', t.LENGTHM);
      assert.ok(Math.abs(t.LENGTHM - hsum) / hsum < 0.1, 'LENGTHM within 10% of haversine sum');
    }
    const t = tripRows[0];

    // --- resegment from the first point: must reproduce the same rows -----
    const r1 = await runner.resegment(device, points[0].ts);
    console.log('resegment(from first point):', r1);
    const tripsAfterR1 = await cds.db.run('SELECT ID FROM GEOTRACK_TRIPS WHERE DEVICE = ? ORDER BY STARTEDAT', [device]);
    const eventsAfterR1 = await cds.db.run('SELECT ZONE_ID, KIND, "AT" FROM GEOTRACK_ZONEEVENTS WHERE DEVICE = ? ORDER BY "AT"', [device]);
    assert.deepEqual(tripsAfterR1.map((r) => r.ID), tripIds, 'resegment reproduces the same trip IDs');
    assert.equal(eventsAfterR1.length, 5, 'resegment reproduces the same event rows');

    // --- late point, one minute before the day's first position: exercises ---
    // --- the resegment-behind-watermark path that schedule() would take -------
    const late = row(-1, H, HOME, false);
    await insertPosition(late);
    const r2 = await runner.resegment(device, late.ts);
    console.log('resegment(late point behind watermark, 07:59):', r2);
    const tripsAfterR2 = await cds.db.run('SELECT ID FROM GEOTRACK_TRIPS WHERE DEVICE = ? ORDER BY STARTEDAT', [device]);
    const eventsAfterR2 = await cds.db.run('SELECT ZONE_ID, KIND, "AT" FROM GEOTRACK_ZONEEVENTS WHERE DEVICE = ? ORDER BY "AT"', [device]);
    console.log('ZoneEvents after late point:', eventsAfterR2);
    assert.deepEqual(tripsAfterR2.map((r) => r.ID), tripIds, 'trip IDs unchanged after a behind-watermark resegment');
    assert.equal(eventsAfterR2.length, 5, 'still 5 events (the enter-home event now dates to the late point)');

    // --- Fix round 1, finding 1: resegment cut strictly inside the trip (between the ---
    // --- shop enter and shop leave events) must not throw and must reproduce the -------
    // --- identical final state (this is the exact geometry that used to crash: a real ---
    // --- last zone paired with a reset-to-null anchor). ---------------------------------
    const midTripTs = at(32); // strictly after shop enter (08:30), before shop leave (08:35)
    const r3 = await runner.resegment(device, midTripTs);
    console.log('resegment(mid-trip, between shop enter and shop leave):', r3);
    const tripsAfterR3 = await cds.db.run('SELECT ID FROM GEOTRACK_TRIPS WHERE DEVICE = ? ORDER BY STARTEDAT', [device]);
    const eventsAfterR3 = await cds.db.run('SELECT ZONE_ID, KIND, "AT" FROM GEOTRACK_ZONEEVENTS WHERE DEVICE = ? ORDER BY "AT"', [device]);
    assert.deepEqual(tripsAfterR3.map((r) => r.ID), tripIds, 'mid-trip resegment reproduces the same trip IDs');
    assert.deepEqual(eventsAfterR3, eventsAfterR2, 'mid-trip resegment reproduces identical event rows');

    // --- Fix round 1, finding 2: a low-accuracy position inside the trip window must ---
    // --- not get tagged with TRIP_ID, or LENGTHM/POINTCOUNT diverge from what the -------
    // --- segmenter itself saw. -----------------------------------------------------------
    const badPoint = { ...row(27, { lat: 50, lon: 10 }, null, true), accuracy: 5000 }; // far away, would wreck LENGTHM if tagged
    await insertPosition(badPoint);
    const r4 = await runner.resegment(device, points[0].ts);
    console.log('resegment(after inserting a low-accuracy point inside the trip window):', r4);
    const [tripAfterBad] = await cds.db.run('SELECT ID, POINTCOUNT, LENGTHM FROM GEOTRACK_TRIPS WHERE ID = ?', [firstTripId]);
    const [{ N: taggedCount }] = await cds.db.run('SELECT COUNT(*) N FROM GEOTRACK_POSITIONS WHERE TRIP_ID = ?', [tripAfterBad.ID]);
    const [badRow] = await cds.db.run('SELECT TRIP_ID FROM GEOTRACK_POSITIONS WHERE DEVICE = ? AND TS = ?', [device, badPoint.ts.toISOString()]);
    console.log('trip after bad-accuracy point:', tripAfterBad, 'tagged row count:', taggedCount, 'bad point TRIP_ID:', badRow.TRIP_ID);
    assert.equal(tripAfterBad.ID, firstTripId, 'same trip, just recomputed');
    assert.equal(badRow.TRIP_ID, null, 'the low-accuracy point must not be tagged with TRIP_ID');
    assert.equal(tripAfterBad.POINTCOUNT, taggedCount, 'POINTCOUNT must equal the actual tagged row count');
    assert.equal(tripAfterBad.LENGTHM, t.LENGTHM, 'LENGTHM unaffected by the low-accuracy point');

    // --- a fromTS past the watermark is clamped to it: nothing unsegmented is skipped ---
    const wmOf = async () => (await cds.db.run('SELECT SEGMENTEDTHROUGHTS FROM GEOTRACK_WATERMARKS WHERE DEVICE = ?', [device]))[0].SEGMENTEDTHROUGHTS;
    const wmBefore = await wmOf();
    console.log('resegment(fromTS a day past the watermark):', await runner.resegment(device, at(24 * 60)));
    assert.equal(await wmOf(), wmBefore, 'the watermark must not jump past unsegmented positions');

    // --- Pass-through: a drive past the shop (automotive inside) is recorded, flagged, never sent ---
    const ptPoints = [
      row(0, H, HOME, false, PT, 'stationary'), row(5, lerp(H, S, 0.5), null, true, PT, 'automotive'),
      row(6, S, SHOP, true, PT, 'automotive'), row(7, S, SHOP, true, PT, 'stationary,automotive'),
      row(8, lerp(S, K, 0.5), null, true, PT, 'automotive'), row(9, K, null, true, PT, 'automotive'),
    ];
    emitted.length = 0;
    for (const p of ptPoints) await insertPosition(p);
    await runner.run(PT);
    const ptEvents = () => cds.db.run(`SELECT KIND, VISITSTATUS, VISITID FROM GEOTRACK_ZONEEVENTS WHERE DEVICE = ? AND ZONE_ID = ? ORDER BY "AT", KIND`, [PT, SHOP]);
    let pt = await ptEvents();
    assert.deepEqual(pt.map((r) => [r.KIND, r.VISITSTATUS]), [['enter', 'passthrough'], ['leave', 'passthrough']]);
    assert.ok(!emitted.some((k) => k.startsWith(`${PT}|${SHOP}|`)), 'a drive-by is never emitted (no SiteVisit)');
    // an event sent to A4H under the old rules keeps its VISITID and becomes 'passthrough' on resegment
    const oldVisit = randomUUID();
    await cds.db.run(`UPDATE GEOTRACK_ZONEEVENTS SET VISITSTATUS = 'created', VISITID = ? WHERE DEVICE = ? AND ZONE_ID = ? AND KIND = 'enter'`, [oldVisit, PT, SHOP]);
    emitted.length = 0;
    await runner.resegment(PT, ptPoints[0].ts);
    assert.ok(!emitted.some((k) => k.startsWith(`${PT}|${SHOP}|`)), 'nor emitted when a resegment recomputes it');
    pt = await ptEvents();
    assert.deepEqual(pt.map((r) => [r.KIND, r.VISITSTATUS]), [['enter', 'passthrough'], ['leave', 'passthrough']]);
    assert.equal(pt[0].VISITID, oldVisit, 'the old A4H visit ID stays on the row');
    const [ptWm] = await cds.db.run('SELECT MOTIONSTATE FROM GEOTRACK_WATERMARKS WHERE DEVICE = ?', [PT]);
    assert.ok(ptWm.MOTIONSTATE, 'motion state persisted');
    console.log('pass-through: flagged, not emitted, old VISITID kept');

    // --- Mode change and stop completing in a later run (one fix per run): drive, park, a short
    // walk (split off at the last drive fix, then dropped under walkMinM), sit, drive home.
    // Velocity is 4 km/h throughout, so KIND 'drive' can only come from the segmenter. ---
    const moPoints = [
      row(0, H, HOME, false, MO, 'stationary'),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => row(m, lerp(H, W, m / 9), null, true, MO, 'automotive')),
      ...[10, 11, 12, 13, 14, 15, 16].map((m) => row(m, lerp(W, W2, (m - 9) / 7), null, true, MO, 'walking')),
      ...[17, 22, 28].map((m) => row(m, W2, null, false, MO, 'stationary')),
      ...[29, 30, 31, 32, 33, 34, 35].map((m) => row(m, lerp(W2, H, (m - 28) / 8), null, true, MO, 'automotive')),
      row(36, H, HOME, true, MO, 'automotive'),
    ];
    for (const p of moPoints) { await insertPosition(p); await runner.run(MO); }
    const moInc = await snapshot(MO);
    await runner.resegment(MO, moPoints[0].ts);
    const moBatch = await snapshot(MO);
    console.log('mode/stop incremental:', brief(moInc));
    console.log('mode/stop batch      :', brief(moBatch));
    assert.deepEqual(moInc, moBatch, 'mode change and stop completing in a later run: incremental == batch');
    for (const t of moBatch.trips) assert.equal(t.POINTCOUNT, moBatch.tags.find((g) => g.STARTEDAT === t.STARTEDAT)?.N, `POINTCOUNT = tagged rows for ${t.STARTEDAT}`);
    assert.deepEqual(moBatch.trips.map((t) => [utcDate(t.STARTEDAT).toISOString(), utcDate(t.ENDEDAT).toISOString(), t.KIND]),
      [[at(0), at(9), 'drive'], [at(28), at(36), 'drive']].map(([s, e, k]) => [s.toISOString(), e.toISOString(), k]), 'two drives; the short walk left no trip');
    // a cut inside the stretch the stop closed after the fact (the dropped walk) must not add a trip
    await runner.resegment(MO, at(12));
    assert.deepEqual(await snapshot(MO), moBatch, 'a cut inside the dropped walk reproduces the batch rows');
    console.log('mode/stop: incremental == batch; both drives KIND drive; short walk dropped');

    // --- a Watch route during the first leg, stored before the trip closes: the close stitches it in ---
    // 21 Watch points, one a minute from 08:08 to 08:28, zigzagging 24 m east of the straight line home → shop.
    const r6 = (p) => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) }); // as Decimal(9,6) stores it
    const watch = Array.from({ length: 21 }, (_, i) => {
      const p = lerp(H, S, (i + 1) / 22);
      return { ts: at(8 + i), ...r6(i % 2 ? { lat: p.lat, lon: p.lon + 0.0003 } : p) };
    });
    await cds.db.run(`INSERT INTO GEOTRACK_WORKOUTS (ID, DEVICE, NAME, STARTEDAT, ENDEDAT, ROUTEPOINTS) VALUES (?, ?, 'Hiking', ?, ?, ?)`,
      [HIKE, WR, at(8).toISOString(), at(28).toISOString(), watch.length]);
    for (const w of watch) {
      await cds.db.run(`INSERT INTO GEOTRACK_WORKOUTROUTE (WORKOUT_ID, TS, LAT, LON, POINT, HORIZONTALACCURACYM, ISCOARSENED)
        VALUES (?, ?, ?, ?, NEW ST_POINT(?, ?, 4326), 3, FALSE)`, [HIKE, w.ts.toISOString(), w.lat, w.lon, w.lon, w.lat]);
    }
    for (const p of points) await insertPosition({ ...p, device: WR });
    await runner.run(WR);
    const wrTrips = () => cds.db.run('SELECT LENGTHM, LENGTHSOURCE, ROUTEWKT FROM GEOTRACK_TRIPS WHERE DEVICE = ? ORDER BY STARTEDAT', [WR])
      .then((rows) => rows.map((t) => ({ lengthM: t.LENGTHM, source: t.LENGTHSOURCE, points: t.ROUTEWKT.toString().split(',').length })));
    const wr = await wrTrips();
    console.log('Watch route trips:', wr);
    // leg 1: the phone's positions at 08:10–08:25 fall on Watch minutes and drop out; 08:05 and 08:30 stay
    const stitched = [r6(H), ...watch, r6(S)];
    let wsum = 0;
    for (let i = 1; i < stitched.length; i++) wsum += haversineM(stitched[i - 1], stitched[i]);
    assert.deepEqual(wr.map((t) => t.source), ['mixed', 'phone']);
    assert.ok(Math.abs(wr[0].lengthM - Math.round(wsum)) <= 1, `leg 1 ${wr[0].lengthM} m vs ${Math.round(wsum)} m`);
    assert.equal(wr[0].points, 23, 'every step is longer than 5 m: nothing thinned');
    assert.ok(wr[0].lengthM > tripRows[0].LENGTHM, 'the zigzag is longer than the phone\'s straight line');
    assert.deepEqual([wr[1].lengthM, wr[1].points], [tripRows[1].LENGTHM, tripRows[1].ROUTEWKT.toString().split(',').length],
      'the leg without a Watch route measures what it measures without any workout');
    await runner.resegment(WR, points[0].ts);
    assert.deepEqual(await wrTrips(), wr, 'a resegment stitches the same line');
    console.log('Watch route: stitched at the close, the same after a resegment');
    // --- Silence: a gap longer than gapMinutes is not bridged. A drive cut off after 08:12, a stub of two
    // positions at the park, a walk home. One position per run through the persisted state == one batch. ---
    const gpPoints = [
      row(0, H, HOME, false, GP, 'stationary'), row(5, H, HOME, false, GP, 'stationary'),
      ...[6, 7, 8, 9, 10, 11, 12].map((m) => row(m, lerp(H, W, (m - 5) / 7), null, true, GP, 'automotive')),
      row(52, K, null, true, GP, 'walking'), row(53, K2, null, true, GP, 'walking'),
      ...[83, 88, 93, 98].map((m, i) => row(m, lerp(K, H, 0.1 + 0.225 * i), null, true, GP, 'walking')),
      row(103, H, HOME, false, GP, 'walking'),
    ];
    for (const p of gpPoints) { await insertPosition(p); await runner.run(GP); }
    const gpInc = await snapshot(GP);
    await runner.resegment(GP, gpPoints[0].ts);
    const gpBatch = await snapshot(GP);
    console.log('silence incremental:', brief(gpInc));
    console.log('silence batch      :', brief(gpBatch));
    assert.deepEqual(gpInc, gpBatch, 'silences: one position per run must give exactly what one batch run gives');
    assert.deepEqual(gpBatch.trips.map((t) => [utcDate(t.STARTEDAT).toISOString(), utcDate(t.ENDEDAT).toISOString(), t.KIND, t.STARTZONE_ID, t.ENDZONE_ID, t.POINTCOUNT]), [
      [at(5).toISOString(), at(12).toISOString(), 'drive', HOME, null, 8],   // ends where the recording stopped
      [at(83).toISOString(), at(103).toISOString(), 'walk', null, HOME, 5],  // starts at the first position after the silence
    ], 'the cut-off drive and the walk home; the stub of two positions left no trip');
    assert.deepEqual(gpBatch.tags.map((g) => g.N), [8, 5], 'the stub\'s positions are tagged to no trip');
    assert.deepEqual(gpBatch.events.map((e) => [e.KIND, e.ZONE_ID, utcDate(e.AT).toISOString()]),
      [['enter', HOME, at(0).toISOString()], ['leave', HOME, at(5).toISOString()], ['enter', HOME, at(103).toISOString()]]);
    const [gpWalk] = await cds.db.run('SELECT LENGTHM FROM GEOTRACK_TRIPS WHERE DEVICE = ? AND STARTEDAT = ?', [GP, at(83).toISOString()]);
    assert.ok(gpWalk.LENGTHM > 550 && gpWalk.LENGTHM < 650, `the walk home measures its own 600 m, not the jump: ${gpWalk.LENGTHM} m`);
    console.log('silence: incremental == batch; drive cut off at 08:12, stub dropped, walk home starts after the silence');
    // --- Accuracy by place: outside every zone a position needs maxAccuracyOutsideM, inside a zone maxAccuracyM.
    // A night of junk outside Home (46 m), then home -> shop -> home, where one position on the way is 40 m
    // accurate (skipped) and the walking position in the shop 45 m (accepted: it confirms the visit). ---
    const poor = (r, accuracy) => ({ ...r, accuracy });
    const acPoints = [
      row(0, H, HOME, false, AC, 'stationary'), row(5, H, HOME, false, AC, 'stationary'),
      ...[[5.1, 0.08], [5.15, 0.095], [5.2, 0.11]].map(([m, f]) => poor(row(m, lerp(H, W, f), null, true, AC), 46)),
      row(45, H, HOME, false, AC, 'stationary'), row(50, H, HOME, false, AC, 'stationary'),
      ...points.map((p, i) => ({ ...p, device: AC, ts: at(60 + i * 5), receivedAt: at(60 + i * 5), accuracy: i === 3 ? 40 : i === 7 ? 45 : 5 })),
    ];
    for (const p of acPoints) { await insertPosition(p); await runner.run(AC); }
    const acInc = await snapshot(AC);
    await runner.resegment(AC, acPoints[0].ts);
    const acBatch = await snapshot(AC);
    console.log('accuracy incremental:', brief(acInc));
    console.log('accuracy batch      :', brief(acBatch));
    assert.deepEqual(acInc, acBatch, 'accuracy: one position per run must give exactly what one batch run gives');
    assert.deepEqual(acBatch.trips.map((t) => [utcDate(t.STARTEDAT).toISOString(), utcDate(t.ENDEDAT).toISOString(), t.STARTZONE_ID, t.ENDZONE_ID, t.POINTCOUNT]), [
      [at(65).toISOString(), at(90).toISOString(), HOME, SHOP, 5],    // without the 40 m position on the way
      [at(95).toISOString(), at(115).toISOString(), SHOP, HOME, 5],   // the 45 m position in the shop confirmed the visit
    ], 'the junk left no trip; the day gives its two legs');
    assert.deepEqual(acBatch.tags.map((g) => g.N), [5, 5], 'neither the junk nor the 40 m position on the way is tagged to a trip');
    assert.deepEqual(acBatch.events.map((e) => [e.KIND, e.ZONE_ID, utcDate(e.AT).toISOString()]), [
      ['enter', HOME, at(0).toISOString()], ['leave', HOME, at(65).toISOString()], ['enter', SHOP, at(90).toISOString()],
      ['leave', SHOP, at(95).toISOString()], ['enter', HOME, at(115).toISOString()],
    ], 'the junk gave Home no leave and no enter');
    // a resegment whose cut follows the junk: the position before the cut must be the accepted one at Home
    await runner.resegment(AC, at(45));
    assert.deepEqual(await snapshot(AC), acBatch, 'a resegment after the junk starts from the last accepted position');
    console.log('accuracy: junk outside Home left nothing; 40 m on the way skipped, 45 m in the shop accepted');
    console.log('ALL CHECKS PASSED in', Math.round((Date.now() - started) / 1000), 's');
  } finally {
    await cleanup();
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
