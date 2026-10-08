'use strict';
const cds = require('@sap/cds');
// The same JS strip the live insert uses (lat/lon, SSID/BSSID). Not a regex: a regex strip of
// `"lat":...,`/`,"lat":...` corrupts the JSON whenever lat/lon is the object's last property
// (leaves a dangling comma before `}`), e.g. `{"acc":12,"lat":48.2,"lon":16.3}` -> `{"acc":12,}`.
const { stripRaw } = require('../srv/lib/coarsen');
const { computeTripRoute, refreshTripRoute } = require('../srv/lib/trip-route');
const DRY_RUN = process.argv.includes('--dry-run');
const SELF_TEST = process.argv.includes('--self-test');
const ROUTES = process.argv.includes('--routes');
const RECENTRE = process.argv.includes('--recentre');

function selfTest() {
  const assert = require('node:assert');
  const cases = [
    ['{"acc":12,"lat":48.2,"lon":16.3}', { acc: 12 }],
    ['{"lat":1,"lon":2,"tst":3}', { tst: 3 }],
    ['{"acc":5,"SSID":"HomeNet","BSSID":"aa:bb:cc:dd:ee:ff"}', { acc: 5 }],
  ];
  for (const [input, expected] of cases) {
    const out = stripRaw(input);
    assert.ok(out !== null, `expected valid JSON back for ${input}`);
    assert.deepStrictEqual(JSON.parse(out), expected); // throws if the JSON itself is invalid
  }
  assert.strictEqual(stripRaw('not json'), null, 'unparseable raw must yield null, not throw');
  console.log('self-test ok:', cases.length + 1, 'cases');
}

// Smallest first, the order findZone uses: a point inside two private zones is claimed
// (and flagged ISCOARSENED) by the one the live insert would have picked.
const PRIVATE_ZONES = `SELECT ID, NAME, CENTRELAT, CENTRELON FROM GEOTRACK_ZONES WHERE ISPRIVATE = TRUE AND GEOM IS NOT NULL
  ORDER BY CASE WHEN KIND = 'polygon' THEN 0 ELSE RADIUSM END`;

// Workout route points coarsened after the fact: the Workouts row's count and start/end flags follow.
// Uncorrelated scalar subqueries (parameters, no TOP/ORDER BY), so HANA's SQL 309 rule does not bite.
const REFRESH_FLAGS = `UPDATE GEOTRACK_WORKOUTS SET
  ROUTEPOINTSCOARSENED = (SELECT COUNT(*) FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ? AND ISCOARSENED = TRUE),
  STARTSINPRIVATEZONE = (SELECT ISCOARSENED FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ? AND TS = (SELECT MIN(TS) FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ?)),
  ENDSINPRIVATEZONE = (SELECT ISCOARSENED FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ? AND TS = (SELECT MAX(TS) FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ?))
  WHERE ID = ?`;

// Closed trips a workout with a route overlaps, and trips whose stored line came from a route that may be gone.
const ROUTE_TRIPS = (scope) => `SELECT T.ID, T.STARTEDAT, T.LENGTHM, T.LENGTHSOURCE FROM GEOTRACK_TRIPS T
  WHERE T.ENDEDAT IS NOT NULL${scope} AND (COALESCE(T.LENGTHSOURCE, 'phone') <> 'phone' OR EXISTS (SELECT 1 FROM GEOTRACK_WORKOUTS W
    WHERE W.DEVICE = T.DEVICE AND W.ROUTEPOINTS > 0 AND W.STARTEDAT <= T.ENDEDAT AND W.ENDEDAT >= T.STARTEDAT))
  ORDER BY T.STARTEDAT`;

/**
 * Rebuild length and line of closed trips from the Watch route (srv/lib/trip-route.js). `dryRun` prints
 * what would be written and writes nothing; `device` limits it to one device (the smoke uses it).
 * Idempotent. Returns the number of trips refreshed, or that would be.
 */
async function refreshTripRoutes({ dryRun = false, device = null } = {}) {
  const [s] = await cds.db.run('SELECT MAXACCURACYM FROM GEOTRACK_SETTINGS WHERE ID = 1');
  const settings = { maxAccuracyM: s.MAXACCURACYM };
  const trips = await cds.db.run(ROUTE_TRIPS(device ? ' AND T.DEVICE = ?' : ''), device ? [device] : []);
  let refreshed = 0;
  for (const t of trips) {
    const r = await cds.tx((tx) => (dryRun ? computeTripRoute : refreshTripRoute)(tx, t.ID, settings));
    if (!r) continue;
    refreshed++;
    console.log(t.ID.slice(0, 8), String(t.STARTEDAT).slice(0, 16), dryRun ? 'would become' : 'is now',
      `${r.lengthM ?? '-'} m (${r.lengthSource}), was ${t.LENGTHM ?? '-'} m (${t.LENGTHSOURCE ?? 'phone'})`);
  }
  console.log(dryRun ? 'trips that would be refreshed:' : 'trips refreshed:', refreshed, 'of', trips.length, 'candidates');
  return refreshed;
}

/**
 * Coarsen workout route points that lie in a private zone but were stored before the zone existed
 * or grew: zone centre, altitude/speed/course cleared, as the live endpoint does. Idempotent
 * (ISCOARSENED = FALSE filter). `device` limits it to one device's workouts (the smoke uses it).
 */
async function coarsenRoutes({ dryRun = false, device = null } = {}) {
  const scope = device ? ' AND WORKOUT_ID IN (SELECT ID FROM GEOTRACK_WORKOUTS WHERE DEVICE = ?)' : '';
  const params = (...p) => (device ? [...p, device] : p);
  const zones = await cds.db.run(PRIVATE_ZONES);
  const touched = new Set();
  for (const z of zones) {
    const inside = `ISCOARSENED = FALSE AND POINT.ST_Intersects((SELECT GEOM FROM GEOTRACK_ZONES WHERE ID = ?)) = 1${scope}`;
    const hits = await cds.db.run(`SELECT WORKOUT_ID, COUNT(*) N FROM GEOTRACK_WORKOUTROUTE WHERE ${inside} GROUP BY WORKOUT_ID`, params(z.ID));
    const points = hits.reduce((s, h) => s + Number(h.N), 0);
    if (dryRun) { console.log(z.NAME, 'would coarsen route points:', points, 'in workouts:', hits.length); continue; }
    if (!hits.length) continue;
    const n = await cds.db.run(`UPDATE GEOTRACK_WORKOUTROUTE SET LAT = ?, LON = ?, POINT = NEW ST_POINT(?, ?, 4326),
      ALTITUDEM = NULL, SPEEDMS = NULL, COURSEDEG = NULL, ISCOARSENED = TRUE, ZONE_ID = ? WHERE ${inside}`,
      params(z.CENTRELAT, z.CENTRELON, z.CENTRELON, z.CENTRELAT, z.ID, z.ID));
    console.log(z.NAME, 'coarsened route points:', n?.changes ?? n, 'in workouts:', hits.length);
    for (const h of hits) touched.add(h.WORKOUT_ID);
  }
  for (const id of touched) await cds.db.run(REFRESH_FLAGS, [id, id, id, id, id, id]);
  if (touched.size) console.log('workouts with refreshed coarsening flags:', touched.size);
  // The stored line of a trip may hold points this run just coarsened.
  if (touched.size) await refreshTripRoutes({ device });
  return touched.size;
}

/**
 * Delete stored photos that now lie in a private zone (the zone was added or enlarged after they were
 * stored): photos inside private zones are never kept. Idempotent. `device` limits it (the smoke uses it).
 */
async function dropPrivatePhotos({ dryRun = false, device = null } = {}) {
  const scope = device ? ' AND DEVICE = ?' : '';
  const params = (...p) => (device ? [...p, device] : p);
  let deleted = 0;
  for (const z of await cds.db.run(PRIVATE_ZONES)) {
    const inside = `POINT.ST_Intersects((SELECT GEOM FROM GEOTRACK_ZONES WHERE ID = ?)) = 1${scope}`;
    const n = Number((await cds.db.run(`SELECT COUNT(*) N FROM GEOTRACK_PHOTOS WHERE ${inside}`, params(z.ID)))[0].N);
    if (dryRun) { console.log(z.NAME, 'would delete photos:', n); continue; }
    if (!n) continue;
    const r = await cds.db.run(`DELETE FROM GEOTRACK_PHOTOS WHERE ${inside}`, params(z.ID));
    console.log(z.NAME, 'deleted photos:', r?.changes ?? r);
    deleted += n;
  }
  return deleted;
}

/**
 * A private zone was moved: take what is already stored at its old centre to the current one — the positions
 * and workout route points that carry the zone's ID and are coarsened. Their real coordinates were never kept,
 * so they stay inside the zone wherever its outline is now. Idempotent; `dryRun` counts and writes nothing;
 * `device` limits it (the smoke uses it). Returns the number of rows moved, or that would be. Trips keep
 * their stored length and line: resegment the device afterwards.
 */
async function recentre({ dryRun = false, device = null } = {}) {
  const TABLES = [['positions', 'GEOTRACK_POSITIONS', ' AND DEVICE = ?'],
    ['route points', 'GEOTRACK_WORKOUTROUTE', ' AND WORKOUT_ID IN (SELECT ID FROM GEOTRACK_WORKOUTS WHERE DEVICE = ?)']];
  let moved = 0;
  for (const z of await cds.db.run(PRIVATE_ZONES)) {
    if (z.CENTRELAT == null || z.CENTRELON == null) continue;   // nothing was ever coarsened to a zone without a centre
    for (const [what, table, scope] of TABLES) {
      const where = `ZONE_ID = ? AND ISCOARSENED = TRUE AND (LAT <> ? OR LON <> ?)${device ? scope : ''}`;
      const params = [z.ID, z.CENTRELAT, z.CENTRELON, ...(device ? [device] : [])];
      const n = Number((await cds.db.run(`SELECT COUNT(*) N FROM ${table} WHERE ${where}`, params))[0].N);
      console.log(z.NAME, dryRun ? 'would move to the centre:' : 'moved to the centre:', n, what);
      if (n && !dryRun) await cds.db.run(`UPDATE ${table} SET LAT = ?, LON = ?, POINT = NEW ST_POINT(?, ?, 4326) WHERE ${where}`,
        [z.CENTRELAT, z.CENTRELON, z.CENTRELON, z.CENTRELAT, ...params]);
      moved += n;
    }
  }
  if (moved && !dryRun) console.log('trips keep their stored length and line: resegment the device to rebuild them');
  return moved;
}

async function main() {
  await cds.connect.to('db');
  if (ROUTES) return refreshTripRoutes({ dryRun: DRY_RUN });
  if (RECENTRE) return recentre({ dryRun: DRY_RUN });
  // ISPRIVATE/ISCOARSENED are native HANA BOOLEAN columns here; this HANA version rejects a
  // literal-integer comparison against them ("INT type is not comparable with BOOLEAN type"),
  // confirmed live. TRUE/FALSE literals work. ST_Intersects(...) = 1 is untouched: that
  // compares an INTEGER return value, not a boolean column, and is the same pattern store.js
  // already uses successfully.
  const zones = await cds.db.run(PRIVATE_ZONES);
  if (!zones.length) console.log('0 private zones — nothing to coarsen.');
  for (const z of zones) {
    // Same WHERE the coarsening UPDATE below uses. Selected first (and by device+ts, not
    // re-filtered by ISCOARSENED) so the RAW rewrite below always targets exactly these rows,
    // even after ISCOARSENED flips to TRUE for them.
    const affected = await cds.db.run(
      `SELECT DEVICE, TS, RAW FROM GEOTRACK_POSITIONS WHERE ISCOARSENED = FALSE AND POINT.ST_Intersects((SELECT GEOM FROM GEOTRACK_ZONES WHERE ID = ?)) = 1`,
      [z.ID]);
    if (DRY_RUN) {
      console.log(z.NAME, 'would coarsen rows:', affected.length);
      console.log(z.NAME, 'would rewrite RAW for rows:', affected.length);
      continue;
    }
    // RAW rewrite first, in JS, one row at a time, keyed by the row's own (DEVICE, TS) —
    // must happen before the coordinate/ISCOARSENED UPDATE, or the WHERE below would no
    // longer find these rows (ISCOARSENED already TRUE) and their RAW would never be touched.
    for (const row of affected) {
      await cds.db.run(`UPDATE GEOTRACK_POSITIONS SET RAW = ?, SSID = NULL WHERE DEVICE = ? AND TS = ?`, [stripRaw(row.RAW), row.DEVICE, row.TS]);
    }
    const n = await cds.db.run(`UPDATE GEOTRACK_POSITIONS SET LAT = ?, LON = ?, POINT = NEW ST_POINT(?, ?, 4326), ISCOARSENED = TRUE, ZONE_ID = ?
      WHERE ISCOARSENED = FALSE AND POINT.ST_Intersects((SELECT GEOM FROM GEOTRACK_ZONES WHERE ID = ?)) = 1`,
      [z.CENTRELAT, z.CENTRELON, z.CENTRELON, z.CENTRELAT, z.ID, z.ID]);
    console.log(z.NAME, 'coarsened rows:', n?.changes ?? n, '(RAW rewritten for', affected.length, 'rows)');
  }
  const [left] = await cds.db.run(`SELECT COUNT(*) N FROM GEOTRACK_POSITIONS P WHERE ISCOARSENED = FALSE AND EXISTS (SELECT 1 FROM GEOTRACK_ZONES Z WHERE Z.ISPRIVATE = TRUE AND P.POINT.ST_Intersects(Z.GEOM) = 1)`);
  console.log('uncoarsened rows still inside private zones:', left.N);

  // One-off for rows coarsened before the Wi-Fi strip existed: they still carry SSID/BSSID
  // (a BSSID is geolocatable). LIKE '%SSID%' matches BSSID too. Idempotent: a stripped row no longer matches.
  const wifi = await cds.db.run(`SELECT DEVICE, TS, RAW FROM GEOTRACK_POSITIONS WHERE ISCOARSENED = TRUE AND (SSID IS NOT NULL OR RAW LIKE '%SSID%')`);
  if (DRY_RUN) console.log('coarsened rows still carrying SSID/BSSID, would strip:', wifi.length);
  else {
    for (const row of wifi) await cds.db.run(`UPDATE GEOTRACK_POSITIONS SET RAW = ?, SSID = NULL WHERE DEVICE = ? AND TS = ?`, [stripRaw(row.RAW), row.DEVICE, row.TS]);
    console.log('coarsened rows stripped of SSID/BSSID:', wifi.length);
  }

  // Tag history with non-private zones too (polygon beats circle, private circle beats
  // public circle, smaller radius wins among circles) so old rows outside any private
  // zone still get a ZONE_ID for reporting/trip tagging.
  // HANA rejects TOP/ORDER BY inside a correlated subquery (SQL error 309), so the best
  // zone per untagged row is picked with ROW_NUMBER and applied through MERGE.
  const BEST_ZONE = `SELECT DEVICE, TS, ID FROM (
      SELECT P.DEVICE, P.TS, Z.ID,
        ROW_NUMBER() OVER (PARTITION BY P.DEVICE, P.TS ORDER BY Z.ISPRIVATE DESC, CASE WHEN Z.KIND = 'polygon' THEN 0 ELSE Z.RADIUSM END) AS RN
      FROM GEOTRACK_POSITIONS P JOIN GEOTRACK_ZONES Z ON Z.GEOM IS NOT NULL AND P.POINT.ST_Intersects(Z.GEOM) = 1
      WHERE P.ZONE_ID IS NULL) WHERE RN = 1`;
  if (DRY_RUN) {
    const [{ N }] = await cds.db.run(`SELECT COUNT(*) N FROM (${BEST_ZONE})`);
    console.log('would tag with a zone:', N);
  } else {
    const tagged = await cds.db.run(`MERGE INTO GEOTRACK_POSITIONS P USING (${BEST_ZONE}) S
      ON P.DEVICE = S.DEVICE AND P.TS = S.TS WHEN MATCHED THEN UPDATE SET ZONE_ID = S.ID`);
    console.log('tagged with a zone:', tagged?.changes ?? tagged);
  }

  await coarsenRoutes({ dryRun: DRY_RUN });
  await dropPrivatePhotos({ dryRun: DRY_RUN });
}

if (require.main === module) {
  if (SELF_TEST) { selfTest(); process.exit(0); }
  main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}

module.exports = { coarsenRoutes, dropPrivatePhotos, refreshTripRoutes, recentre };
