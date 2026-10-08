'use strict';
// HANA smoke for the iOS app's workouts (slice 2 of the app). Device `trial-smoke`: a trial device, so the
// workout is stored apart under `trial-smoke:<id>` and rebuilds no trip. The same workout is also stored under
// `smoke7` (sent without a device, as Health Auto Export does) and compared with its trial twin. One private
// test zone `smoke-trial-private` at 42.50/1.50 (synthetic, far from any real zone). Cleans up in `finally`.
// Run: npx cds bind --exec -- node scripts/db-smoke-health-trial.js
const cds = require('@sap/cds');
const assert = require('node:assert/strict');
const express = require('express');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { mount } = require('../srv/lib/health-ingest');
const { circleToWkt } = require('../srv/lib/geo');

const device = 'trial-smoke', base = 'smoke7', TOKEN = randomUUID(), ZONE = randomUUID(), ID = randomUUID().toUpperCase();
const stored = `${device}:${ID}`;
const APP_TIMEOUT_S = 120; // the app's request timeout for one workout
const q = (sql, p = []) => cds.db.run(sql, p);
const t0 = Date.UTC(2026, 8, 22, 10, 0, 0);
const iso = (s) => new Date(t0 + s * 1000).toISOString().replace('.000Z', 'Z'); // whole seconds, as the app sends them

/** Two hours as the app sends them: a route point every second, heart rate every 5 s, three minutes of recovery. */
const hike = () => {
  const rate = (s) => ({ date: iso(s), Min: 100 + (s % 40), Avg: 100 + (s % 40), Max: 100 + (s % 40), units: 'bpm', source: 'Apple Watch' });
  return {
    id: ID, name: 'Hiking', start: iso(0), end: iso(7200), duration: 7200, isIndoor: false,
    distance: { qty: 6967.2, units: 'm' }, activeEnergyBurned: { qty: 512.3, units: 'kcal' }, elevationUp: { qty: 310.4, units: 'm' },
    heartRate: { min: { qty: 100, units: 'bpm' }, avg: { qty: 119.5, units: 'bpm' }, max: { qty: 139, units: 'bpm' } },
    heartRateData: Array.from({ length: 1440 }, (_, k) => rate(k * 5)),
    heartRateRecovery: Array.from({ length: 36 }, (_, k) => rate(7205 + k * 5)),
    stepCount: [{ date: iso(0), qty: 9800, units: 'count' }],
    // 0.00001° north a second, from 55 m south of the zone's centre: the first 145 points lie inside its 100 m.
    route: Array.from({ length: 7201 }, (_, s) => ({ latitude: 42.4995 + s * 0.00001, longitude: 1.5, altitude: 1000 + s / 20, timestamp: iso(s),
      speed: 1.1, course: 0, horizontalAccuracy: 4, verticalAccuracy: 3, speedAccuracy: 0.3, courseAccuracy: 9 })),
  };
};
const cleanup = async () => {
  for (const d of [device, base]) {
    await q('DELETE FROM GEOTRACK_WORKOUTHEARTRATE WHERE WORKOUT_ID IN (SELECT ID FROM GEOTRACK_WORKOUTS WHERE DEVICE = ?)', [d]);
    await q('DELETE FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID IN (SELECT ID FROM GEOTRACK_WORKOUTS WHERE DEVICE = ?)', [d]);
    await q('DELETE FROM GEOTRACK_WORKOUTS WHERE DEVICE = ?', [d]);
  }
  await q("DELETE FROM GEOTRACK_ZONES WHERE NAME = 'smoke-trial-private'");
};

(async () => {
  cds.model = cds.compile.for.nodejs(await cds.load('*')); // CQL INSERT/UPSERT need the model
  await cds.connect.to('db');
  const refreshed = [];
  const app = express();
  mount(app, { token: TOKEN, device: base, db: cds.db, refresh: async (d) => { refreshed.push(d); } });
  const server = app.listen(0, '127.0.0.1'); // not on every address: see test/test-servers.test.js
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/health/workouts`;
  const post = (body) => fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` } })
    .then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    await cleanup(); // a killed earlier run may have left rows behind
    await q(`INSERT INTO GEOTRACK_ZONES (ID, NAME, KIND, CENTRELAT, CENTRELON, RADIUSM, WKT, GEOM, ISBASE, ISPRIVATE, CREATESVISIT)
      VALUES (?, 'smoke-trial-private', 'circle', 42.5, 1.5, 100, ?, ST_GeomFromText(?, 4326), FALSE, TRUE, FALSE)`, [ZONE, circleToWkt(42.5, 1.5, 100), circleToWkt(42.5, 1.5, 100)]);

    // 1. A two-hour workout from a trial device: stored apart, within the app's timeout.
    const body = { device, data: { workouts: [hike()] } };
    console.log(`1. a two-hour workout, ${(Buffer.byteLength(JSON.stringify(body)) / 1048576).toFixed(1)} MB`);
    const started = Date.now();
    const r = await post(body);
    const seconds = (Date.now() - started) / 1000;
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.skipped, []);
    assert.deepEqual([r.json.workouts[0].id, r.json.workouts[0].hrSamples, r.json.workouts[0].routePoints], [ID, 1476, 7201]);
    console.log(`   stored in ${seconds.toFixed(1)} s (the app waits ${APP_TIMEOUT_S} s)`);
    assert.ok(seconds < APP_TIMEOUT_S / 2, `storing took ${seconds.toFixed(1)} s: more than half the app's timeout`);

    // 2. The rows: under the prefixed ID and the trial device, coarsened inside the private zone, no trip rebuilt.
    const [w] = await q('SELECT ID, DEVICE, HRSAMPLES, ROUTEPOINTS, ROUTEPOINTSCOARSENED, STARTSINPRIVATEZONE, STEPS FROM GEOTRACK_WORKOUTS WHERE DEVICE = ?', [device]);
    assert.deepEqual([w.ID, w.DEVICE, w.HRSAMPLES, w.ROUTEPOINTS, w.STEPS], [stored, device, 1476, 7201, 9800]);
    assert.ok(w.ROUTEPOINTSCOARSENED > 100 && w.ROUTEPOINTSCOARSENED < 200, `coarsened ${w.ROUTEPOINTSCOARSENED}`);
    const [c] = await q(`SELECT (SELECT COUNT(*) FROM GEOTRACK_WORKOUTHEARTRATE WHERE WORKOUT_ID = ?) H, (SELECT COUNT(*) FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ?) R,
      (SELECT COUNT(*) FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ? AND ISCOARSENED = FALSE AND LAT < 42.5008) INSIDE,
      (SELECT COUNT(*) FROM GEOTRACK_WORKOUTS WHERE ID = ?) BARE FROM DUMMY`, [stored, stored, stored, ID]);
    assert.deepEqual([Number(c.H), Number(c.R), Number(c.INSIDE), Number(c.BARE)], [1476, 7201, 0, 0]);
    assert.deepEqual(refreshed, [], 'a trial workout must not rebuild a trip');
    console.log(`2. stored as ${device}:<id>, ${w.ROUTEPOINTSCOARSENED} points at the zone's centre, no trip rebuilt`);

    // 3. A resend replaces: one copy, the same counts.
    assert.equal((await post(body)).status, 200);
    const [again] = await q('SELECT (SELECT COUNT(*) FROM GEOTRACK_WORKOUTS WHERE DEVICE = ?) W, (SELECT COUNT(*) FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ?) R FROM DUMMY', [device, stored]);
    assert.deepEqual([Number(again.W), Number(again.R)], [1, 7201]);
    console.log('3. a resend replaces: still one copy');

    // 4. The comparison script reads both copies from HANA: the same workout under a smoke device, sent without
    //    a device as Health Auto Export does, and its trial twin. Synthetic times only.
    assert.equal((await post({ data: { workouts: [hike()] } })).status, 200);
    const out = execFileSync(process.execPath, [path.join(__dirname, 'compare-workouts.js'), '--a', base, '--b', device, '--from', iso(-60)], { encoding: 'utf8' });
    console.log(out.trim().split('\n').map((l) => `   ${l}`).join('\n'));
    assert.match(out, /Hiking: PASS; heart rate 1476 of 1476 the same; route 7201 of 7201 the same/);
    assert.match(out, /criterion 1 .*: met, 1 of 1 pass/);
    console.log('4. the comparison script paired the two copies and found them the same');
    console.log('OK');
  } finally {
    await cleanup().catch((e) => console.error('cleanup failed:', e.code ?? e.name));
    server.close();
  }
})().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
