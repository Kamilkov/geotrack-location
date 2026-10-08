'use strict';
// HANA smoke for slice 3. Fixture device `smoke3`; cleans up in `finally`.
// Run: npx cds bind --exec -- node scripts/db-smoke-weather.js
const cds = require('@sap/cds');
const assert = require('node:assert/strict');
const { insertPosition } = require('../srv/lib/store');
const runner = require('../srv/lib/segment-runner');
const weather = require('../srv/lib/weather');
const { utcDate } = runner;
const fixture = require('../test/fixtures/open-meteo-2026-09-22.json');

runner.init({ emit: async () => {} });
const device = 'smoke3';
// Same day and cells as the recorded fixture: 15:43–17:06 UTC on 2026-09-22 at 42.50/1.50 → 42.51/1.49 → 42.50/1.50.
const T = (s) => new Date(s);
const A = { lat: 42.5, lon: 1.5 }, B = { lat: 42.51, lon: 1.49 };
const row = (ts, loc, moving) => ({
  device, ts: T(ts), receivedAt: T(ts), lat: loc.lat, lon: loc.lon, accuracy: 5, altitude: 0, velocity: moving ? 4 : 0, course: 0,
  battery: 90, batteryState: 2, connection: 'w', ssid: null, pressure: null, trigger: 't', zone_ID: null, isCoarsened: false,
  raw: JSON.stringify({ _type: 'location', lat: loc.lat, lon: loc.lon, tst: Math.floor(T(ts).getTime() / 1000) }),
});
// still at A (anchor), move to B and back, then 35 min still at A → the stillness rule closes the trip at 17:06:25.
const points = [
  row('2026-09-22T15:35:00Z', A, false), row('2026-09-22T15:43:46Z', A, false),
  row('2026-09-22T15:50:00Z', { lat: 42.503, lon: 1.497 }, true), row('2026-09-22T16:00:00Z', { lat: 42.506, lon: 1.494 }, true),
  row('2026-09-22T16:31:25Z', B, true), row('2026-09-22T16:50:00Z', { lat: 42.504, lon: 1.496 }, true),
  row('2026-09-22T17:06:25Z', A, true), row('2026-09-22T17:20:00Z', A, false), row('2026-09-22T17:45:00Z', A, false),
];
const fakeFetch = (body = fixture) => async () => ({ ok: true, status: 200, json: async () => body });
const refused = (url, opts) => globalThis.fetch(url.replace(/^https:\/\/[^/]+/, 'http://127.0.0.1:59998'), opts);
const q = (sql, p = []) => cds.db.run(sql, p);

(async () => {
  await cds.connect.to('db');
  try {
    // Mirror the finally block: a run killed before cleanup can leave a stale smoke3 watermark
    // (e.g. anchored at 17:45) that would make the next run's segmentation fail misleadingly.
    await q('DELETE FROM GEOTRACK_TRIPWEATHER WHERE TRIP_ID IN (SELECT ID FROM GEOTRACK_TRIPS WHERE DEVICE = ?)', [device]);
    await q('DELETE FROM GEOTRACK_TRIPS WHERE DEVICE = ?', [device]);
    await q('DELETE FROM GEOTRACK_ZONEEVENTS WHERE DEVICE = ?', [device]);
    await q('DELETE FROM GEOTRACK_WATERMARKS WHERE DEVICE = ?', [device]);
    await q('DELETE FROM GEOTRACK_POSITIONS WHERE DEVICE = ?', [device]);
    for (const p of points) assert.equal(await insertPosition(p), 'inserted');
    await runner.run(device);
    const [trip] = await q('SELECT ID, STARTEDAT, ENDEDAT, WEATHERATTEMPTS FROM GEOTRACK_TRIPS WHERE DEVICE = ? AND ENDEDAT IS NOT NULL', [device]);
    assert.ok(trip, 'the runner closed one trip');
    console.log('trip', trip.ID, utcDate(trip.STARTEDAT).toISOString(), '→', utcDate(trip.ENDEDAT).toISOString(), 'attempts', trip.WEATHERATTEMPTS);
    assert.equal(trip.WEATHERATTEMPTS, 0, 'a fresh closed trip has WEATHERATTEMPTS 0 (default)');

    // 1. failure path against a refused port: attempt recorded, nothing stored
    const fail = await weather.fetchTrip(trip.ID, { fetch: refused });
    assert.equal(fail.ok, false);
    let [t] = await q('SELECT WEATHERATTEMPTS, WEATHERATTEMPTEDAT, WEATHERERROR, WEATHERFETCHEDAT FROM GEOTRACK_TRIPS WHERE ID = ?', [trip.ID]);
    console.log('after refused fetch:', t);
    assert.equal(t.WEATHERATTEMPTS, 1); assert.ok(t.WEATHERATTEMPTEDAT); assert.match(t.WEATHERERROR, /ECONNREFUSED|fetch failed/); assert.equal(t.WEATHERFETCHEDAT, null);
    assert.equal((await q('SELECT COUNT(*) N FROM GEOTRACK_TRIPWEATHER WHERE TRIP_ID = ?', [trip.ID]))[0].N, 0);

    // 2. success with the recorded fixture: 3 rows, summary, bookkeeping reset
    const ok = await weather.fetchTrip(trip.ID, { fetch: fakeFetch() });
    assert.equal(ok.ok, true, ok.error);
    console.log('summary:', ok.text);
    const rows = await q('SELECT HOUR, LAT, LON, ELEVATIONM, SOURCE, TEMPERATUREC, WEATHERCODE FROM GEOTRACK_TRIPWEATHER WHERE TRIP_ID = ? ORDER BY HOUR', [trip.ID]);
    console.table(rows);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => utcDate(r.HOUR).toISOString()), ['2026-09-22T15:00:00.000Z', '2026-09-22T16:00:00.000Z', '2026-09-22T17:00:00.000Z']);
    assert.deepEqual(rows.map((r) => [Number(r.LAT), Number(r.LON)]), [[42.5, 1.5], [42.51, 1.49], [42.5, 1.5]]);
    [t] = await q('SELECT WEATHERATTEMPTS, WEATHERERROR, WEATHERFETCHEDAT, WEATHERTEXT, TEMPERATUREC, PRECIPITATIONMM, WINDKMH FROM GEOTRACK_TRIPS WHERE ID = ?', [trip.ID]);
    console.log('trip summary row:', t);
    assert.equal(t.WEATHERATTEMPTS, 0); assert.equal(t.WEATHERERROR, null); assert.ok(t.WEATHERFETCHEDAT); assert.ok(t.WEATHERTEXT);

    // 3. idempotent: a second fetch leaves exactly 3 rows
    assert.equal((await weather.fetchTrip(trip.ID, { fetch: fakeFetch() })).ok, true);
    assert.equal((await q('SELECT COUNT(*) N FROM GEOTRACK_TRIPWEATHER WHERE TRIP_ID = ?', [trip.ID]))[0].N, 3);

    // 4. resegment re-closes the same trip (same deterministic ID) → weather cleared, not stale
    const msg = await runner.resegment(device, '2026-09-22T15:00:00Z');
    console.log(msg);
    const [again] = await q('SELECT ID, WEATHERFETCHEDAT, WEATHERTEXT, WEATHERATTEMPTS FROM GEOTRACK_TRIPS WHERE DEVICE = ? AND ENDEDAT IS NOT NULL', [device]);
    assert.equal(again.ID, trip.ID, 'same trip ID after resegment');
    assert.equal(again.WEATHERFETCHEDAT, null); assert.equal(again.WEATHERTEXT, null); assert.equal(again.WEATHERATTEMPTS, 0);
    assert.equal((await q('SELECT COUNT(*) N FROM GEOTRACK_TRIPWEATHER WHERE TRIP_ID = ?', [trip.ID]))[0].N, 0, 'resegment deleted the weather rows');

    // 5. one real call (forecast now, archive automatically once the date is > 90 days old)
    const live = await weather.fetchTrip(trip.ID);
    assert.equal(live.ok, true, live.error);
    console.log('live:', live.text, live.rows[0].source, 'elevation', live.rows[0].elevationM);
    assert.equal(live.rows.length, 3);
    assert.ok(live.rows.every((r) => r.temperatureC > -30 && r.temperatureC < 45));

    // 6. enrichMissing never touches smoke devices
    // enrichMissing() returns any in-flight pass and ignores the options passed to it, and the
    // fire-and-forget passes triggered by runner.run/resegment above may still be running —
    // await one full pass first so it can't race the fetched-count check below.
    await weather.enrichMissing();
    await q('UPDATE GEOTRACK_TRIPS SET WEATHERFETCHEDAT = NULL WHERE ID = ?', [trip.ID]);
    let fetched = 0;
    await weather.enrichMissing({ fetch: async (u, o) => { fetched++; return globalThis.fetch(u, o); } });
    const [still] = await q('SELECT WEATHERFETCHEDAT FROM GEOTRACK_TRIPS WHERE ID = ?', [trip.ID]);
    assert.equal(still.WEATHERFETCHEDAT, null, 'smoke trip skipped by enrichMissing');
    console.log('enrichMissing fetched', fetched, 'non-smoke trips (real iphone trips missing weather, if any)');

    console.log('ALL CHECKS PASSED');
  } finally {
    await q('DELETE FROM GEOTRACK_TRIPWEATHER WHERE TRIP_ID IN (SELECT ID FROM GEOTRACK_TRIPS WHERE DEVICE = ?)', [device]);
    await q('DELETE FROM GEOTRACK_TRIPS WHERE DEVICE = ?', [device]);
    await q('DELETE FROM GEOTRACK_ZONEEVENTS WHERE DEVICE = ?', [device]);
    await q('DELETE FROM GEOTRACK_WATERMARKS WHERE DEVICE = ?', [device]);
    await q('DELETE FROM GEOTRACK_POSITIONS WHERE DEVICE = ?', [device]);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
