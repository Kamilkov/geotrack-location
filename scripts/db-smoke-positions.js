'use strict';
// HANA smoke for POST /positions. Device `smoke6`; a private test zone `smoke6-home` at 42.50/1.50
// (synthetic, far from any real zone). Cleans up in `finally`.
// Run: npx cds bind --exec -- node scripts/db-smoke-positions.js
const cds = require('@sap/cds');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { mount } = require('../srv/lib/positions-ingest');
const { circleToWkt } = require('../srv/lib/geo');

const device = 'smoke6', TOKEN = randomUUID(), ZONE = randomUUID();
const q = (sql, p = []) => cds.db.run(sql, p);
const bool = (v) => v === true || v === 1;
// Synthetic times: 3 days ago from 08:00 UTC, clear of real data.
const day = new Date(Date.now() - 3 * 86400000);
day.setUTCHours(8, 0, 0, 0);
const tst = (min) => Math.floor(day.getTime() / 1000) + min * 60;
const iso = (min) => new Date(tst(min) * 1000).toISOString();
const pos = (min, lat, lon, extra = {}) => ({ _type: 'location', tst: tst(min), lat, lon, acc: 5, ...extra });
const cleanup = async () => {
  await q('DELETE FROM GEOTRACK_POSITIONS WHERE DEVICE = ?', [device]);
  await q("DELETE FROM GEOTRACK_ZONES WHERE NAME = 'smoke6-home'");
};

(async () => {
  await cds.connect.to('db');
  await cleanup();
  const wkt = circleToWkt(42.5, 1.5, 100);
  await q(`INSERT INTO GEOTRACK_ZONES (ID, NAME, KIND, CENTRELAT, CENTRELON, RADIUSM, WKT, GEOM, ISBASE, ISPRIVATE, CREATESVISIT)
    VALUES (?, 'smoke6-home', 'circle', 42.5, 1.5, 100, ?, ST_GeomFromText(?, 4326), FALSE, TRUE, FALSE)`, [ZONE, wkt, wkt]);

  const scheduled = [];
  const app = express();
  mount(app, { token: TOKEN, schedule: (d, ts) => scheduled.push([d, ts.toISOString()]) }); // smoke devices are never segmented
  const server = app.listen(0, '127.0.0.1'); // not on every address: see test/test-servers.test.js
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/positions`;
  const post = (body, token = TOKEN) => fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } })
    .then(async (r) => ({ status: r.status, json: await r.json() }));

  try {
    // 1. the token
    assert.equal((await post({ device, positions: [pos(0, 42.52, 1.52)] }, 'wrong')).status, 401);
    assert.equal((await q('SELECT COUNT(*) N FROM GEOTRACK_POSITIONS WHERE DEVICE = ?', [device]))[0].N, 0);
    console.log('1 ok: a wrong token stores nothing');

    // 2. one batch, out of time order: outside zones, inside the private zone, unusable,
    //    and a float accuracy with a connection value that does not fit its column
    const batch = [
      pos(10, 42.52, 1.52, { conn: 'w', motionactivities: ['walking'], p: 89.874 }),
      pos(0, 42.5003, 1.5002, { SSID: 'HomeNet' }),
      pos(5, 91, 1.5),
      pos(15, 42.521, 1.52, { acc: 6.6, conn: 'wwwwwwwwwwww' }),
    ];
    let r = await post({ device, positions: batch });
    assert.deepEqual(r, { status: 200, json: { stored: 3, duplicates: 0, skipped: [2] } });
    const rows = await q(`SELECT LAT, LON, ACCURACY, CONNECTION, SSID, PRESSURE, ACTIVITIES, ZONE_ID, ISCOARSENED, POINT.ST_AsText() WKT, RAW
      FROM GEOTRACK_POSITIONS WHERE DEVICE = ? ORDER BY TS`, [device]);
    assert.equal(rows.length, 3);
    const [home, out, odd] = rows;
    assert.deepEqual([Number(home.LAT), Number(home.LON), home.ZONE_ID, bool(home.ISCOARSENED), home.SSID], [42.5, 1.5, ZONE, true, null]);
    assert.ok(!/"lat"|"lon"|HomeNet/.test(String(home.RAW)), 'no location or Wi-Fi name left in raw');
    assert.deepEqual([Number(out.LAT), Number(out.LON), out.ZONE_ID, bool(out.ISCOARSENED), out.CONNECTION, out.ACTIVITIES, Number(out.PRESSURE)],
      [42.52, 1.52, null, false, 'w', 'walking', 89.874]);
    assert.match(String(out.WKT), /^POINT\s*\(1\.52\d* 42\.52\d*\)$/);
    assert.deepEqual([odd.ACCURACY, odd.CONNECTION], [7, null]);
    assert.deepEqual(scheduled, [[device, iso(0)]]);
    console.log('2 ok: stored 3, skipped 1, coarsened 1, a float accuracy rounded, scheduled from the earliest');

    // 3. the same batch again
    r = await post({ device, positions: batch });
    assert.deepEqual(r.json, { stored: 0, duplicates: 3, skipped: [2] });
    assert.equal((await q('SELECT COUNT(*) N FROM GEOTRACK_POSITIONS WHERE DEVICE = ?', [device]))[0].N, 3);
    assert.deepEqual(scheduled, [[device, iso(0)], [device, iso(0)]]);
    console.log('3 ok: a resend stores nothing new and schedules again');

    // 4. a full-size batch, as the app sends after a long stretch offline: 50 positions, then the same again.
    //    The app sends at most 50 per request and waits 60 s for an answer; half of that is the limit here.
    //    (200 took 44 s on 2026-10-01, about 0.2 s per insert.)
    const big = Array.from({ length: 50 }, (_, i) => pos(100 + i, 42.53 + i * 0.0001, 1.52));
    let t0 = Date.now();
    r = await post({ device, positions: big });
    const storedMs = Date.now() - t0;
    assert.deepEqual(r, { status: 200, json: { stored: 50, duplicates: 0, skipped: [] } });
    t0 = Date.now();
    r = await post({ device, positions: big });
    const duplicateMs = Date.now() - t0;
    assert.deepEqual(r.json, { stored: 0, duplicates: 50, skipped: [] });
    assert.ok(storedMs < 30000 && duplicateMs < 30000, `50 positions took ${storedMs} ms new and ${duplicateMs} ms as duplicates`);
    console.log(`4 ok: 50 positions stored in ${storedMs} ms, recognised as duplicates in ${duplicateMs} ms`);
  } finally {
    server.close();
    await cleanup();
  }
  console.log('positions smoke passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
