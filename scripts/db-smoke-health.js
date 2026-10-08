'use strict';
// HANA smoke for slice 4. Device `smoke4`; private test zones `smoke4-*` near 42.50/1.50 and 42.52/1.52
// (synthetic, far from any real zone). Cleans up in `finally`. Needs the slice 4 deploy.
// Run: npx cds bind --exec -- node scripts/db-smoke-health.js
const cds = require('@sap/cds');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { mount } = require('../srv/lib/health-ingest');
const { circleToWkt, haversineM } = require('../srv/lib/geo');
const { refreshTripRoute } = require('../srv/lib/trip-route');
const { utcDate } = require('../srv/lib/time');
const { coarsenRoutes, refreshTripRoutes, recentre } = require('./coarsen-backfill');

const device = 'smoke4', TOKEN = randomUUID(), TRIP = randomUUID(), Z1 = randomUUID(), Z2 = randomUUID();
const q = (sql, p = []) => cds.db.run(sql, p);
const bool = (v) => v === true || v === 1;
const pad = (n) => String(n).padStart(2, '0');
/** Minutes after 2026-09-22 10:10 UTC, written as the app writes it (+0200). */
const at = (min) => {
  const d = new Date(Date.UTC(2026, 8, 22, 10, 10) + Math.round(min * 60000));
  return `2026-09-22 ${pad(d.getUTCHours() + 2)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0200`;
};
/** A 30-minute walk north from (lat0, lon0): a route point per minute, heart rate every 30 s, 3 recovery samples. */
const walk = (id, lat0, lon0, minutes = 30) => ({
  id, name: 'Outdoor Walk', start: at(0), end: at(30), duration: 1800, isIndoor: false,
  distance: { qty: 1.4, units: 'km' }, heartRate: { min: { qty: 90, units: 'bpm' }, avg: { qty: 112, units: 'bpm' }, max: { qty: 131, units: 'bpm' } },
  heartRateData: Array.from({ length: 61 }, (_, k) => ({ date: at(k / 2), Min: 100 + (k % 7), Avg: 105 + (k % 7), Max: 110 + (k % 7), units: 'bpm', source: 'Apple Watch' })),
  heartRateRecovery: [31, 32, 33].map((m) => ({ date: at(m), Min: 95, Avg: 98, Max: 101, units: 'bpm', source: 'Apple Watch' })),
  // 0.0004° lat per minute: points 0 and 1 lie within 100 m of (lat0 - 0.0003, lon0 - 0.0002), point 2 does not.
  route: Array.from({ length: minutes + 1 }, (_, i) => ({ latitude: lat0 + 0.0004 * i, longitude: lon0, altitude: 1000 + i, timestamp: at(i), speed: 1.3, course: 0, horizontalAccuracy: 4, verticalAccuracy: 3 })),
});
const mkZone = (id, name, lat, lon, r) => q(`INSERT INTO GEOTRACK_ZONES (ID, NAME, KIND, CENTRELAT, CENTRELON, RADIUSM, WKT, GEOM, ISBASE, ISPRIVATE, CREATESVISIT)
  VALUES (?, ?, 'circle', ?, ?, ?, ?, ST_GeomFromText(?, 4326), FALSE, TRUE, FALSE)`, [id, name, lat, lon, r, circleToWkt(lat, lon, r), circleToWkt(lat, lon, r)]);
// Phone positions of the fixture trip: minute after 10:00 UTC, lat, lon. All outside the private zone.
// The one at minute 20 coincides with a Watch point and drops out of the stitched line.
const PHONE = [[0, 42.498, 1.5002], [5, 42.4985, 1.5002], [20, 42.505, 1.501], [45, 42.513, 1.5002], [50, 42.5135, 1.5002]];
const phoneAt = (min) => new Date(Date.UTC(2026, 8, 22, 10, min)).toISOString();
const ph = (k) => ({ lat: PHONE[k][1], lon: PHONE[k][2] });
const mkPosition = ([min, lat, lon]) => q(`INSERT INTO GEOTRACK_POSITIONS (DEVICE, TS, RECEIVEDAT, STOREDAT, LAT, LON, POINT, ACCURACY, ISCOARSENED, TRIP_ID)
  VALUES (?, ?, ?, ?, ?, ?, NEW ST_POINT(?, ?, 4326), 5, FALSE, ?)`, [device, phoneAt(min), phoneAt(min), phoneAt(min), lat, lon, lon, lat, TRIP]);
/** The Watch line of walk() as it is stored: the first two points coarsened to the zone centre. */
const watchLine = () => Array.from({ length: 31 }, (_, i) => (i < 2 ? { lat: 42.5, lon: 1.5 } : { lat: +(42.5003 + 0.0004 * i).toFixed(6), lon: 1.5002 }));
const lineM = (points) => Math.round(points.reduce((s, p, i) => (i ? s + haversineM(points[i - 1], p) : 0), 0));
const tripLine = async () => {
  const [t] = await q('SELECT LENGTHM, LENGTHSOURCE, ROUTEWKT, CASE WHEN ROUTE IS NULL THEN 0 ELSE 1 END HASROUTE FROM GEOTRACK_TRIPS WHERE ID = ?', [TRIP]);
  return { lengthM: t.LENGTHM, source: t.LENGTHSOURCE, points: String(t.ROUTEWKT ?? '').split(',').length, hasRoute: t.HASROUTE };
};
const cleanup = async () => {
  await q('DELETE FROM GEOTRACK_WORKOUTHEARTRATE WHERE WORKOUT_ID IN (SELECT ID FROM GEOTRACK_WORKOUTS WHERE DEVICE = ?)', [device]);
  await q('DELETE FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID IN (SELECT ID FROM GEOTRACK_WORKOUTS WHERE DEVICE = ?)', [device]);
  await q('DELETE FROM GEOTRACK_WORKOUTS WHERE DEVICE = ?', [device]);
  await q('DELETE FROM GEOTRACK_POSITIONS WHERE DEVICE = ?', [device]);
  await q('DELETE FROM GEOTRACK_TRIPS WHERE DEVICE = ?', [device]);
  await q("DELETE FROM GEOTRACK_ZONES WHERE NAME LIKE 'smoke4-%'");
};
const counts = async (id) => (await q(`SELECT
  (SELECT COUNT(*) FROM GEOTRACK_WORKOUTS WHERE ID = ?) W, (SELECT COUNT(*) FROM GEOTRACK_WORKOUTHEARTRATE WHERE WORKOUT_ID = ?) H,
  (SELECT COUNT(*) FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ?) R FROM DUMMY`, [id, id, id]))[0];

(async () => {
  cds.model = cds.compile.for.nodejs(await cds.load('*')); // CQL INSERT/UPSERT need the model
  await cds.connect.to('db');
  const app = express();
  mount(app, { token: TOKEN, device, db: cds.db });
  const server = app.listen(0, '127.0.0.1'); // not on every address: see test/test-servers.test.js
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/health/workouts`;
  const post = (workouts, token = TOKEN) => fetch(url, { method: 'POST', body: JSON.stringify({ data: { workouts } }),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }).then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    await cleanup(); // a killed earlier run may have left rows behind
    await mkZone(Z1, 'smoke4-private', 42.5, 1.5, 100);
    // Closed at its last position and weather-marked, so the live weather sweep leaves it alone during the run.
    await q(`INSERT INTO GEOTRACK_TRIPS (ID, DEVICE, STARTEDAT, ENDEDAT, KIND, POINTCOUNT, WEATHERFETCHEDAT) VALUES (?, ?, ?, ?, 'walk', ?, ?)`,
      [TRIP, device, phoneAt(0), phoneAt(50), PHONE.length, new Date().toISOString()]);
    for (const p of PHONE) await mkPosition(p);
    const [s] = await q('SELECT MAXACCURACYM FROM GEOTRACK_SETTINGS WHERE ID = 1');
    const settings = { maxAccuracyM: s.MAXACCURACYM };

    // 0. phone only: the close computes length and line from the trip's positions
    await cds.tx((tx) => refreshTripRoute(tx, TRIP, settings, { atClose: true }));
    const phoneOnly = await tripLine();
    console.log('phone only:', phoneOnly);
    assert.deepEqual([phoneOnly.source, phoneOnly.points, phoneOnly.hasRoute], ['phone', 5, 1]);
    const phoneM = lineM(PHONE.map((_, k) => ph(k)));
    assert.ok(Math.abs(phoneOnly.lengthM - phoneM) <= Math.ceil(phoneM * 0.005), `ST_Distance ${phoneOnly.lengthM} m vs great circle ${phoneM} m`);
    // The next trip starts at this trip's last position and takes its tag: the line still ends there.
    await q('UPDATE GEOTRACK_POSITIONS SET TRIP_ID = ? WHERE DEVICE = ? AND TS = ?', [randomUUID(), device, phoneAt(50)]);
    await cds.tx((tx) => refreshTripRoute(tx, TRIP, settings, { atClose: true }));
    assert.deepEqual(await tripLine(), phoneOnly);

    // 1. auth
    assert.equal((await post([walk('smoke4-walk', 42.5003, 1.5002)], null)).status, 401);
    assert.deepEqual(await counts('smoke4-walk'), { W: 0, H: 0, R: 0 });

    // 2. store: counts, coarsening, flags
    const r = await post([walk('smoke4-walk', 42.5003, 1.5002)]);
    console.log('POST:', r.status, JSON.stringify(r.json));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.workouts, [{ id: 'smoke4-walk', name: 'Outdoor Walk', hrSamples: 64, routePoints: 31, coarsened: 2, startsInPrivateZone: true, endsInPrivateZone: false }]);
    assert.deepEqual(await counts('smoke4-walk'), { W: 1, H: 64, R: 31 });
    const [w] = await q('SELECT DEVICE, STARTEDAT, ENDEDAT, ROUTEPOINTSCOARSENED, STARTSINPRIVATEZONE, ENDSINPRIVATEZONE, RAW FROM GEOTRACK_WORKOUTS WHERE ID = ?', ['smoke4-walk']);
    assert.equal(w.DEVICE, device);
    assert.equal(utcDate(w.STARTEDAT).toISOString(), '2026-09-22T10:10:00.000Z');
    assert.deepEqual([w.ROUTEPOINTSCOARSENED, bool(w.STARTSINPRIVATEZONE), bool(w.ENDSINPRIVATEZONE)], [2, true, false]);
    assert.ok(!String(w.RAW).includes('"route"') && !String(w.RAW).includes('heartRateData'), 'RAW must not carry the series');
    const coarse = await q('SELECT LAT, LON, ALTITUDEM, SPEEDMS, COURSEDEG, ZONE_ID FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ? AND ISCOARSENED = TRUE', ['smoke4-walk']);
    console.table(coarse);
    assert.equal(coarse.length, 2);
    for (const c of coarse) assert.deepEqual([Number(c.LAT), Number(c.LON), c.ALTITUDEM, c.SPEEDMS, c.COURSEDEG, c.ZONE_ID], [42.5, 1.5, null, null, null, Z1]);
    // zoneOf (JS, planar) must agree with HANA's own ST_Intersects: no uncoarsened point inside the zone, every point has a POINT.
    const [x] = await q(`SELECT
      (SELECT COUNT(*) FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ? AND ISCOARSENED = FALSE AND POINT.ST_Intersects((SELECT GEOM FROM GEOTRACK_ZONES WHERE ID = ?)) = 1) LEAKED,
      (SELECT COUNT(*) FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ? AND POINT IS NULL) NOPOINT FROM DUMMY`, ['smoke4-walk', Z1, 'smoke4-walk']);
    assert.deepEqual(x, { LEAKED: 0, NOPOINT: 0 });

    // 2b. the stored workout rebuilt the trip: Watch points where the Watch recorded, phone points around them
    const mixed = await tripLine();
    console.log('stitched:', mixed);
    const mixedM = lineM([ph(0), ph(1), ...watchLine(), ph(3), ph(4)]);
    assert.deepEqual([mixed.source, mixed.points, mixed.hasRoute], ['mixed', 34, 1]); // 2 phone, 1 centre, 29 Watch, 2 phone
    assert.ok(Math.abs(mixed.lengthM - mixedM) <= 1, `${mixed.lengthM} m vs ${mixedM} m`);
    assert.ok(mixed.lengthM > phoneOnly.lengthM - 200, 'same walk, same order of length');

    // 2c. a Watch point less accurate than the segmenter accepts is left out
    await q('UPDATE GEOTRACK_WORKOUTROUTE SET HORIZONTALACCURACYM = 9999 WHERE WORKOUT_ID = ? AND TS = ?', ['smoke4-walk', '2026-09-22T10:25:00.000Z']);
    await cds.tx((tx) => refreshTripRoute(tx, TRIP, settings));
    assert.equal((await tripLine()).points, 33);

    // 3. resend: one copy; a shorter resend replaces the series
    assert.equal((await post([walk('smoke4-walk', 42.5003, 1.5002)])).status, 200);
    assert.deepEqual(await counts('smoke4-walk'), { W: 1, H: 64, R: 31 });
    assert.equal((await post([walk('smoke4-walk', 42.5003, 1.5002, 20)])).status, 200);
    assert.deepEqual(await counts('smoke4-walk'), { W: 1, H: 64, R: 21 });
    assert.equal((await post([walk('smoke4-walk', 42.5003, 1.5002)])).status, 200);
    assert.deepEqual(await tripLine(), mixed, 'resends leave the trip as the first store made it');
    // 3b. a resend that lost its route puts the trip back on the phone line; the route's return stitches again
    assert.equal((await post([{ ...walk('smoke4-walk', 42.5003, 1.5002), route: [] }])).status, 200);
    assert.deepEqual(await tripLine(), phoneOnly);
    assert.equal((await post([walk('smoke4-walk', 42.5003, 1.5002)])).status, 200);
    assert.deepEqual(await tripLine(), mixed);

    // 3c. a trip the workout overlaps only in part (it starts during the workout, ends after it) is found too:
    // the lookup compares the trip's start with the workout's end and the trip's end with the workout's start.
    const PART = randomUUID();
    await q(`INSERT INTO GEOTRACK_TRIPS (ID, DEVICE, STARTEDAT, ENDEDAT, KIND, POINTCOUNT, WEATHERFETCHEDAT) VALUES (?, ?, ?, ?, 'walk', 0, ?)`,
      [PART, device, '2026-09-22T10:38:00.000Z', '2026-09-22T11:20:00.000Z', new Date().toISOString()]);
    assert.equal((await post([walk('smoke4-walk', 42.5003, 1.5002)])).status, 200);
    const [part] = await q('SELECT LENGTHM, LENGTHSOURCE FROM GEOTRACK_TRIPS WHERE ID = ?', [PART]);
    // the Watch points of 10:38, 10:39 and 10:40 lie in its window, no phone position does
    const partM = lineM(watchLine().slice(28));
    assert.equal(part.LENGTHSOURCE, 'watch');
    assert.ok(Math.abs(part.LENGTHM - partM) <= 1, `${part.LENGTHM} m vs ${partM} m`);
    assert.deepEqual(await tripLine(), mixed, 'the first trip is as it was');
    await q('DELETE FROM GEOTRACK_TRIPS WHERE ID = ?', [PART]);

    // 4. WorkoutTrips: 10:10–10:40 inside the 10:00–10:50 trip → 1800 s; an open trip counts as ongoing
    let links = await q('SELECT TRIP_ID, TRIPKIND, OVERLAPS FROM GEOTRACK_WORKOUTTRIPS WHERE WORKOUT_ID = ?', ['smoke4-walk']);
    console.table(links);
    assert.deepEqual(links.map((l) => [l.TRIP_ID, l.TRIPKIND, Number(l.OVERLAPS)]), [[TRIP, 'walk', 1800]]);
    await q('UPDATE GEOTRACK_TRIPS SET ENDEDAT = NULL, STARTEDAT = ? WHERE ID = ?', ['2026-09-22T10:30:00.000Z', TRIP]);
    links = await q('SELECT OVERLAPS FROM GEOTRACK_WORKOUTTRIPS WHERE WORKOUT_ID = ?', ['smoke4-walk']);
    assert.deepEqual(links.map((l) => Number(l.OVERLAPS)), [600]);
    // 4b. an open trip is left alone
    assert.equal(await cds.tx((tx) => refreshTripRoute(tx, TRIP, settings, { atClose: true })), null);
    assert.deepEqual(await tripLine(), mixed);

    // 5. WorkoutMinutes: 31 minutes; the two coarsened minutes carry heart rate but no route values
    const mins = await q('SELECT MINUTETS, HRAVG, HRMAX, HRSAMPLES, ALTITUDEM, SPEEDMS, ROUTEPOINTS FROM GEOTRACK_WORKOUTMINUTES WHERE WORKOUT_ID = ? ORDER BY MINUTETS', ['smoke4-walk']);
    console.table(mins.slice(0, 4));
    assert.equal(mins.length, 31);
    assert.equal(utcDate(mins[0].MINUTETS).toISOString(), '2026-09-22T10:10:00.000Z');
    assert.deepEqual([mins[0].ROUTEPOINTS, mins[0].ALTITUDEM, mins[0].HRSAMPLES], [0, null, 2]);
    assert.ok(mins[0].HRAVG != null);
    assert.deepEqual([mins[2].ROUTEPOINTS, Number(mins[2].ALTITUDEM), Number(mins[2].SPEEDMS)], [1, 1002, 1.3]);
    assert.equal(mins[30].HRSAMPLES, 1); // 10:40:00 only

    // 5b. the backfill's --routes pass: the dry run reports and writes nothing, the real run writes.
    // The trip is closed for it and reopened afterwards, as step 6 expects it.
    await q(`UPDATE GEOTRACK_TRIPS SET STARTEDAT = ?, ENDEDAT = ?, LENGTHM = 1, LENGTHSOURCE = 'phone' WHERE ID = ?`, [phoneAt(0), phoneAt(50), TRIP]);
    assert.equal(await refreshTripRoutes({ dryRun: true, device }), 1);
    assert.deepEqual([(await tripLine()).lengthM, (await tripLine()).source], [1, 'phone'], 'a dry run writes nothing');
    assert.equal(await refreshTripRoutes({ device }), 1);
    assert.deepEqual(await tripLine(), mixed);
    assert.equal(await refreshTripRoutes({ device }), 1, 'a second run refreshes the same trip');
    assert.deepEqual(await tripLine(), mixed, 'to the same values');
    await q('UPDATE GEOTRACK_TRIPS SET ENDEDAT = NULL WHERE ID = ?', [TRIP]);

    // 6. zone added later: coarsen-backfill's route pass catches up, idempotently
    const late = await post([walk('smoke4-late-zone', 42.5203, 1.5202)]);
    assert.deepEqual([late.json.workouts[0].coarsened, late.json.workouts[0].startsInPrivateZone], [0, false]);
    await mkZone(Z2, 'smoke4-late', 42.52, 1.52, 100);
    assert.equal(await coarsenRoutes({ dryRun: true, device }), 0);
    assert.equal(await coarsenRoutes({ device }), 1);
    const [lw] = await q('SELECT ROUTEPOINTSCOARSENED, STARTSINPRIVATEZONE, ENDSINPRIVATEZONE FROM GEOTRACK_WORKOUTS WHERE ID = ?', ['smoke4-late-zone']);
    assert.deepEqual([lw.ROUTEPOINTSCOARSENED, bool(lw.STARTSINPRIVATEZONE), bool(lw.ENDSINPRIVATEZONE)], [2, true, false]);
    const lateCoarse = await q('SELECT LAT, LON, ALTITUDEM, ZONE_ID FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ? AND ISCOARSENED = TRUE', ['smoke4-late-zone']);
    assert.deepEqual(lateCoarse.map((c) => [Number(c.LAT), Number(c.LON), c.ALTITUDEM, c.ZONE_ID]), [[42.52, 1.52, null, Z2], [42.52, 1.52, null, Z2]]);
    assert.equal(await coarsenRoutes({ device }), 0, 'second run finds nothing');

    // 7. a private zone is moved: --recentre takes what is stored at its old centre to the new one, idempotently.
    // One coarsened phone position joins the route points already coarsened into the first zone.
    await q(`INSERT INTO GEOTRACK_POSITIONS (DEVICE, TS, RECEIVEDAT, STOREDAT, LAT, LON, POINT, ACCURACY, ISCOARSENED, ZONE_ID)
      VALUES (?, ?, ?, ?, 42.5, 1.5, NEW ST_POINT(1.5, 42.5, 4326), 5, TRUE, ?)`, [device, phoneAt(55), phoneAt(55), phoneAt(55), Z1]);
    const MOVED = { lat: 42.5005, lon: 1.5004 };
    const wkt = circleToWkt(MOVED.lat, MOVED.lon, 100);
    await q('UPDATE GEOTRACK_ZONES SET CENTRELAT = ?, CENTRELON = ?, WKT = ?, GEOM = ST_GeomFromText(?, 4326) WHERE ID = ?', [MOVED.lat, MOVED.lon, wkt, wkt, Z1]);
    // ordered by workout too: two of the fixture's workouts share their timestamps
    const stored = async () => (await q(`SELECT 'position' K, DEVICE W, LAT, LON, ISCOARSENED C, ZONE_ID Z, TS FROM GEOTRACK_POSITIONS WHERE DEVICE = ?
      UNION ALL SELECT 'route' K, WORKOUT_ID W, LAT, LON, ISCOARSENED C, ZONE_ID Z, TS FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID IN (SELECT ID FROM GEOTRACK_WORKOUTS WHERE DEVICE = ?)
      ORDER BY K, W, TS`, [device, device])).map((r) => ({ kind: r.K, of: r.W, lat: Number(r.LAT), lon: Number(r.LON), coarsened: bool(r.C), zone: r.Z }));
    const before = await stored();
    const inZ1 = before.filter((r) => r.coarsened && r.zone === Z1);
    assert.ok(inZ1.some((r) => r.kind === 'position') && inZ1.some((r) => r.kind === 'route'), 'a position and route points are stored at the first zone\'s centre');
    assert.ok(inZ1.every((r) => r.lat === 42.5 && r.lon === 1.5), 'at the old centre');
    assert.equal(await recentre({ dryRun: true, device }), inZ1.length);
    assert.deepEqual(await stored(), before, 'a dry run writes nothing');
    assert.equal(await recentre({ device }), inZ1.length);
    const after = await stored();
    assert.deepEqual(after, before.map((r) => (r.coarsened && r.zone === Z1 ? { ...r, ...MOVED } : r)),
      'what was at the old centre is at the new one; uncoarsened rows and the other zone\'s rows are untouched');
    assert.equal(await recentre({ device }), 0, 'second run finds nothing');
    console.log('smoke ok');
  } finally {
    server.close();
    await cleanup();
    const [left] = await q("SELECT (SELECT COUNT(*) FROM GEOTRACK_WORKOUTS WHERE DEVICE = 'smoke4') W, (SELECT COUNT(*) FROM GEOTRACK_ZONES WHERE NAME LIKE 'smoke4-%') Z FROM DUMMY");
    console.log('left after cleanup:', left);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
