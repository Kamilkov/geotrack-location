'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { mount } = require('../srv/lib/positions-ingest');
const { circleToWkt } = require('../srv/lib/geo');

const TOKEN = 'test-token-not-a-secret';
// Synthetic private zone around 42.50/1.50 (r 100 m), as the zone SELECT returns it.
const ZONE_ROWS = [{ ID: 'home', KIND: 'circle', RADIUSM: 100, ISPRIVATE: true, CENTRELAT: '42.500000', CENTRELON: '1.500000', WKT: Buffer.from(circleToWkt(42.5, 1.5, 100)) }];
const T0 = 1790000000;
/** A position `dt` seconds after T0, outside every zone unless told otherwise. */
const pos = (dt, lat = 42.52, lon = 1.52, extra = {}) => ({ _type: 'location', tst: T0 + dt, lat, lon, acc: 5, ...extra });
const iso = (dt) => new Date((T0 + dt) * 1000).toISOString();
// The INSERT's parameters, by position (srv/lib/store.js).
const P = { device: 0, ts: 1, lat: 4, lon: 5, accuracy: 8, connection: 14, ssid: 15, raw: 18, zone: 19, coarsened: 20, activities: 21, verticalAccuracy: 22 };

/**
 * Keeps what was inserted and answers a repeated (device, time) like HANA: error code 301.
 * `fail(what, nth)` returning a message makes the nth statement of that kind throw.
 */
function fakeDb({ zones = ZONE_ROWS, fail = () => null } = {}) {
  const calls = [], stored = new Map();
  const run = async (sql, params) => {
    const what = `${sql.trim().split(/\s+/)[0]} ${(/GEOTRACK_\w+|DUMMY/.exec(sql) ?? [''])[0]}`;
    calls.push({ what, params });
    const message = fail(what, calls.filter((c) => c.what === what).length);
    if (message) throw Object.assign(new Error(message), { code: 999 });
    if (what === 'SELECT GEOTRACK_ZONES') return zones;
    if (what === 'INSERT GEOTRACK_POSITIONS') {
      const key = `${params[P.device]}|${params[P.ts]}`;
      if (stored.has(key)) throw Object.assign(new Error('unique constraint violated'), { code: 301 });
      stored.set(key, params);
      return { changes: 1 };
    }
    return [{ 1: 1 }];
  };
  return { run, calls, stored, what: () => calls.map((c) => c.what) };
}

/** Runs fn against a server with the route mounted; `scheduled` collects what the route asked the runner for. */
async function withServer(opts, fn) {
  const scheduled = [];
  const app = express();
  mount(app, { token: TOKEN, schedule: (device, ts) => scheduled.push([device, ts.toISOString()]), ...opts });
  const server = app.listen(0, '127.0.0.1'); // not on every address: see test/test-servers.test.js
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}/positions`, scheduled); } finally { server.close(); }
}
const post = (url, body, { token = TOKEN, raw } = {}) => fetch(url, {
  method: 'POST', body: raw ?? JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
}).then(async (r) => ({ status: r.status, json: await r.json() }));

test('401 without or with a wrong token; 503 without a configured token; nothing touched', async () => {
  const db = fakeDb();
  const body = { device: 'smoke', positions: [pos(0)] };
  await withServer({ db }, async (url, scheduled) => {
    assert.equal((await post(url, body, { token: null })).status, 401);
    assert.equal((await post(url, body, { token: 'wrong' })).status, 401);
    assert.deepEqual(scheduled, []);
  });
  await withServer({ db, token: '' }, async (url) => {
    assert.deepEqual(await post(url, body), { status: 503, json: { error: 'endpoint disabled: HEALTH_TOKEN not set' } });
  });
  assert.deepEqual(db.calls, []);
});

test('400 for a bad device or a bad list, and for bad JSON; 413 over 1 MB; nothing touched', async () => {
  const db = fakeDb();
  await withServer({ db }, async (url, scheduled) => {
    for (const body of [
      { positions: [pos(0)] }, { device: 'Trial_iPhone', positions: [pos(0)] }, { device: 'a'.repeat(41), positions: [pos(0)] },
      { device: 'smoke' }, { device: 'smoke', positions: {} }, { device: 'smoke', positions: [] },
      { device: 'smoke', positions: Array.from({ length: 501 }, (_, i) => pos(i)) },
    ]) assert.equal((await post(url, body)).status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal((await post(url, null, { raw: '{"device": ' })).status, 400);
    assert.equal((await post(url, null, { raw: `{"x":"${'a'.repeat(1100 * 1024)}"}` })).status, 413);
    assert.deepEqual(scheduled, []);
  });
  assert.deepEqual(db.calls, []);
});

test('stores a batch in the order sent and schedules the segmenter once, from the earliest position', async () => {
  const db = fakeDb();
  await withServer({ db }, async (url, scheduled) => {
    const r = await post(url, { device: 'smoke', positions: [pos(600), pos(0), pos(300)] });
    assert.deepEqual(r, { status: 200, json: { stored: 3, duplicates: 0, skipped: [] } });
    assert.deepEqual(scheduled, [['smoke', iso(0)]]);
  });
  assert.deepEqual(db.what(), ['SELECT GEOTRACK_ZONES', 'INSERT GEOTRACK_POSITIONS', 'INSERT GEOTRACK_POSITIONS', 'INSERT GEOTRACK_POSITIONS']);
  const first = db.calls[1].params;
  assert.deepEqual([first[P.device], first[P.ts], first[P.lat], first[P.lon], first[P.accuracy], first[P.zone], first[P.coarsened]], ['smoke', iso(600), 42.52, 1.52, 5, null, 0]);
});

test('the same batch again: nothing new, counted as duplicates, and scheduled again from the earliest', async () => {
  const db = fakeDb();
  await withServer({ db }, async (url, scheduled) => {
    const body = { device: 'smoke', positions: [pos(0), pos(300)] };
    await post(url, body);
    assert.deepEqual((await post(url, body)).json, { stored: 0, duplicates: 2, skipped: [] });
    assert.deepEqual(scheduled, [['smoke', iso(0)], ['smoke', iso(0)]]);
  });
  assert.equal(db.stored.size, 2);
});

test('a position the parser cannot use is listed by its place and never blocks the batch', async () => {
  const db = fakeDb();
  await withServer({ db }, async (url, scheduled) => {
    const r = await post(url, { device: 'smoke', positions: [pos(0), pos(300, 91, 1.5), 'nonsense', null, pos(600)] });
    assert.deepEqual(r.json, { stored: 2, duplicates: 0, skipped: [1, 2, 3] });
    assert.deepEqual(scheduled, [['smoke', iso(0)]]);
  });
  assert.equal(db.stored.size, 2);
});

test('inside a private zone: stored at the centre, tagged, without its location or Wi-Fi name', async () => {
  const db = fakeDb();
  await withServer({ db }, (url) => post(url, { device: 'smoke', positions: [pos(0, 42.5003, 1.5002, { SSID: 'HomeNet' })] }));
  const p = db.calls[1].params;
  assert.deepEqual([p[P.lat], p[P.lon], p[P.zone], p[P.coarsened], p[P.ssid]], [42.5, 1.5, 'home', 1, null]);
  assert.deepEqual(JSON.parse(p[P.raw]), { _type: 'location', tst: T0, acc: 5 });
});

test('an old position stored, then the database fails: 503, nothing scheduled; the resend schedules from the old position', async () => {
  let down = true;
  const db = fakeDb({ fail: (what, nth) => (down && ((what === 'INSERT GEOTRACK_POSITIONS' && nth === 2) || what === 'SELECT DUMMY') ? 'connection lost' : null) });
  await withServer({ db }, async (url, scheduled) => {
    const body = { device: 'smoke', positions: [pos(0), pos(300)] };
    assert.deepEqual(await post(url, body), { status: 503, json: { error: 'database unavailable' } });
    assert.equal(db.stored.size, 1);
    assert.deepEqual(scheduled, []);
    down = false;
    assert.deepEqual((await post(url, body)).json, { stored: 1, duplicates: 1, skipped: [] });
    assert.deepEqual(scheduled, [['smoke', iso(0)]]);
  });
});

test('an insert that fails while the database answers, and again when it is down: 503 on the second attempt, nothing scheduled', async () => {
  // The first failure is the position's (HANA answers), so it is tried once more; the retry finds HANA gone.
  const db = fakeDb({ fail: (what, nth) => ((what === 'INSERT GEOTRACK_POSITIONS' && nth <= 2) || (what === 'SELECT DUMMY' && nth === 2) ? 'connection lost' : null) });
  await withServer({ db }, async (url, scheduled) => {
    assert.deepEqual(await post(url, { device: 'smoke', positions: [pos(0), pos(300)] }), { status: 503, json: { error: 'database unavailable' } });
    assert.deepEqual(scheduled, []);
  });
  assert.deepEqual(db.what(), ['SELECT GEOTRACK_ZONES', 'INSERT GEOTRACK_POSITIONS', 'SELECT DUMMY', 'INSERT GEOTRACK_POSITIONS', 'SELECT DUMMY']);
  assert.equal(db.stored.size, 0);
});

test('an insert that fails once while the database answers is tried again and stored', async () => {
  const db = fakeDb({ fail: (what, nth) => (what === 'INSERT GEOTRACK_POSITIONS' && nth === 1 ? 'lock wait timeout' : null) });
  await withServer({ db }, async (url, scheduled) => {
    const r = await post(url, { device: 'smoke', positions: [pos(0), pos(300)] });
    assert.deepEqual(r, { status: 200, json: { stored: 2, duplicates: 0, skipped: [] } });
    assert.deepEqual(scheduled, [['smoke', iso(0)]]);
  });
  assert.equal(db.stored.size, 2);
});

test('an insert that fails twice while the database answers is the position\'s fault: skipped, the rest stored', async () => {
  const db = fakeDb({ fail: (what, nth) => (what === 'INSERT GEOTRACK_POSITIONS' && nth <= 2 ? 'value too large' : null) });
  await withServer({ db }, async (url, scheduled) => {
    const r = await post(url, { device: 'smoke', positions: [pos(0), pos(300)] });
    assert.deepEqual(r, { status: 200, json: { stored: 1, duplicates: 0, skipped: [0] } });
    assert.deepEqual(scheduled, [['smoke', iso(300)]]);
  });
});

test('zones unavailable: 503 and nothing stored', async () => {
  const db = fakeDb({ fail: (what) => (what === 'SELECT GEOTRACK_ZONES' ? 'connection lost' : null) });
  await withServer({ db }, async (url, scheduled) => {
    assert.deepEqual(await post(url, { device: 'smoke', positions: [pos(0)] }), { status: 503, json: { error: 'database unavailable' } });
    assert.deepEqual(scheduled, []);
  });
  assert.equal(db.stored.size, 0);
});

test('a private zone without a centre: 500, nothing stored and nothing scheduled, never a position stored uncoarsened', async () => {
  const db = fakeDb({ zones: [{ ...ZONE_ROWS[0], CENTRELAT: null }] });
  await withServer({ db }, async (url, scheduled) => {
    assert.equal((await post(url, { device: 'smoke', positions: [pos(0, 42.5003, 1.5002)] })).status, 500);
    assert.deepEqual(scheduled, []);
  });
  assert.equal(db.stored.size, 0);
});

test("the iOS app's sample position is stored with its motion activity and connection", async () => {
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/ios-position.json')));
  const db = fakeDb();
  await withServer({ db }, async (url, scheduled) => {
    assert.deepEqual((await post(url, { device: 'trial-iphone', positions: [sample] })).json, { stored: 1, duplicates: 0, skipped: [] });
    // The route always asks; the runner refuses a trial device (test/segment-runner-utils.test.js).
    assert.deepEqual(scheduled, [['trial-iphone', iso(0)]]);
  });
  const p = db.calls[1].params;
  assert.deepEqual([p[P.device], p[P.accuracy], p[P.connection], p[P.activities]], ['trial-iphone', 6, 'w', 'walking']);
  assert.equal(JSON.parse(p[P.raw]).mconf, 'high');
});

test('the vertical accuracy (vac) is stored in its own column, after the activities', async () => {
  const db = fakeDb();
  await withServer({ db }, async (url) => {
    assert.equal((await post(url, { device: 'smoke', positions: [pos(0, 42.52, 1.52, { vac: 147 }), pos(60)] })).status, 200);
  });
  const rows = [...db.stored.values()];
  assert.equal(rows[0][P.verticalAccuracy], 147);
  assert.equal(rows[1][P.verticalAccuracy], null, 'absent stays empty');
});

test('the answer names the base zone as a circle, so the phone can sleep inside it; a base polygon or no base zone names none', async () => {
  const db = fakeDb({ zones: [{ ...ZONE_ROWS[0], ISBASE: true }] });
  await withServer({ db }, async (url) => {
    assert.deepEqual((await post(url, { device: 'smoke', positions: [pos(0)] })).json,
      { stored: 1, duplicates: 0, skipped: [], home: { lat: 42.5, lon: 1.5, radiusM: 100 } });
  });
  const polygon = fakeDb({ zones: [{ ...ZONE_ROWS[0], ISBASE: true, KIND: 'polygon', RADIUSM: null }] });
  await withServer({ db: polygon }, async (url) => {
    assert.equal('home' in (await post(url, { device: 'smoke', positions: [pos(0)] })).json, false, 'a polygon has no circle to watch');
  });
  await withServer({ db: fakeDb() }, async (url) => {
    assert.equal('home' in (await post(url, { device: 'smoke', positions: [pos(0)] })).json, false, 'no base zone');
  });
});
