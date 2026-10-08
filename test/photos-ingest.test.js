'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { mount } = require('../srv/lib/photos-ingest');
const { circleToWkt } = require('../srv/lib/geo');
const { photoId } = require('../srv/lib/photo-meta');

const TOKEN = 'test-token-not-a-secret';
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/photo-synthetic.jpg'));
// Synthetic private zone around 42.50/1.50 (r 100 m) and a public one at 42.52/1.52, as the zone SELECT returns them.
const ZONE_ROWS = [
  { ID: 'home', KIND: 'circle', RADIUSM: 100, ISPRIVATE: true, CENTRELAT: '42.500000', CENTRELON: '1.500000', WKT: Buffer.from(circleToWkt(42.5, 1.5, 100)) },
  { ID: 'park', KIND: 'circle', RADIUSM: 150, ISPRIVATE: false, CENTRELAT: '42.520000', CENTRELON: '1.520000', WKT: Buffer.from(circleToWkt(42.52, 1.52, 150)) },
];
const BODY = { fileName: 'IMG_0001.HEIC', cameraModel: 'iPhone 16 Pro', takenAt: '2026-09-22T17:50:12.345+02:00', lat: 42.52, lon: 1.52, altitudeM: 1001.5, accuracyM: 4.5, directionDeg: 123, thumbnail: FIXTURE.toString('base64') };
const ID = photoId('iPhone 16 Pro', '2026-09-22T17:50:12.345+02:00');

/** Records every statement; `nearest` answers the OwnTracks lookup; `fail(sqlStart)` returning a message makes it throw. */
function fakeDb({ zones = ZONE_ROWS, nearest = [], fail = () => null } = {}) {
  const calls = [];
  const run = async (sql, params) => {
    const what = sql.trim().split(/\s+/).slice(0, 2).join(' ') + (/GEOTRACK_\w+|DUMMY/.exec(sql) ? ` ${/GEOTRACK_\w+|DUMMY/.exec(sql)[0]}` : '');
    calls.push({ what, sql, params });
    const message = fail(what);
    if (message) throw Object.assign(new Error(message), { code: 999 });
    if (/FROM GEOTRACK_ZONES/.test(sql)) return zones;
    if (/FROM GEOTRACK_POSITIONS/.test(sql)) return nearest;
    return /^\s*SELECT/.test(sql) ? [{ 1: 1 }] : { changes: 1 };
  };
  return { run, calls, what: () => calls.map((c) => c.what) };
}
async function withServer(opts, fn) {
  const app = express();
  mount(app, { token: TOKEN, device: 'iphone', ...opts });
  const server = app.listen(0, '127.0.0.1'); // not on every address: see test/test-servers.test.js
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}/photos`); } finally { server.close(); }
}
const post = (url, body, { token = TOKEN, raw } = {}) => fetch(url, {
  method: 'POST', body: raw ?? JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
}).then(async (r) => ({ status: r.status, json: await r.json() }));

test('401 without or with a wrong token; 503 without a configured token — nothing touched', async () => {
  const db = fakeDb();
  await withServer({ db }, async (url) => {
    assert.equal((await post(url, BODY, { token: null })).status, 401);
    assert.equal((await post(url, BODY, { token: 'wrong' })).status, 401);
  });
  await withServer({ db, token: '' }, async (url) => assert.equal((await post(url, BODY)).status, 503));
  assert.deepEqual(db.calls, []);
});

test('400 for a bad body (reason given), bad JSON; 413 over 1 MB — nothing touched', async () => {
  const db = fakeDb();
  await withServer({ db }, async (url) => {
    const r = await post(url, { ...BODY, takenAt: '2026-09-22T17:50:12' });
    assert.deepEqual(r, { status: 400, json: { error: 'takenAt missing or without UTC offset' } });
    assert.equal((await post(url, null, { raw: '{"fileName": ' })).status, 400);
    assert.equal((await post(url, null, { raw: `{"x":"${'a'.repeat(1100 * 1024)}"}` })).status, 413);
  });
  assert.deepEqual(db.calls, []);
});

test('stored: GPS outside the private zone → one UPSERT with the point, the public zone and a metadata-free thumbnail', async () => {
  const db = fakeDb();
  const r = await withServer({ db }, (url) => post(url, BODY));
  assert.deepEqual(r, { status: 200, json: { id: ID, status: 'stored', reason: null, positionSource: 'photo' } });
  assert.deepEqual(db.what(), ['SELECT ID, GEOTRACK_ZONES', 'UPSERT GEOTRACK_PHOTOS GEOTRACK_PHOTOS']);
  const p = db.calls[1].params;
  assert.deepEqual(p.slice(0, 13), [ID, 'iphone', '2026-09-22T15:50:12.345Z', 'IMG_0001.HEIC', 'iPhone 16 Pro', 42.52, 1.52, 1.52, 42.52, 1001.5, 4.5, 123, 'photo']);
  assert.equal(p[13], 'park');
  assert.ok(Buffer.isBuffer(p[14]) && !p[14].includes(Buffer.from('Exif')) && !p[14].includes(Buffer.from('iPhone 16 Pro')));
  assert.equal(p[15], p[14].length);
});

test('dropped: GPS inside the private zone → no UPSERT, an earlier copy deleted, reason given', async () => {
  const db = fakeDb();
  const r = await withServer({ db }, (url) => post(url, { ...BODY, lat: 42.5003, lon: 1.5002 }));
  assert.deepEqual(r.json, { id: ID, status: 'dropped', reason: 'private zone', positionSource: null });
  assert.deepEqual(db.what(), ['SELECT ID, GEOTRACK_ZONES', 'DELETE FROM GEOTRACK_PHOTOS']);
  assert.deepEqual(db.calls[1].params, [ID]);
});

test('no GPS: the OwnTracks lookup spans ±10 min; a position outside private zones is borrowed without altitude, accuracy, direction', async () => {
  const noGps = { ...BODY, lat: undefined, lon: undefined };
  let db = fakeDb({ nearest: [{ TS: '2026-09-22T15:53:00', LAT: '42.600000', LON: '1.600000', ISCOARSENED: false }] });
  let r = await withServer({ db }, (url) => post(url, noGps));
  assert.deepEqual(r.json, { id: ID, status: 'stored', reason: null, positionSource: 'owntracks' });
  assert.deepEqual(db.calls[1].params, ['iphone', '2026-09-22T15:40:12.345Z', '2026-09-22T16:00:12.345Z', '2026-09-22T15:50:12.345Z']);
  assert.deepEqual(db.calls[2].params.slice(5, 14), [42.6, 1.6, 1.6, 42.6, null, null, null, 'owntracks', null]);

  db = fakeDb({ nearest: [{ TS: '2026-09-22T15:53:00', LAT: '42.500000', LON: '1.500000', ISCOARSENED: true }] });
  r = await withServer({ db }, (url) => post(url, noGps));
  assert.deepEqual([r.json.status, r.json.reason], ['dropped', 'private zone']);
  db = fakeDb({ nearest: [] });
  r = await withServer({ db }, (url) => post(url, noGps));
  assert.deepEqual([r.json.status, r.json.reason], ['dropped', 'no position']);
  assert.equal(db.what().at(-1), 'DELETE FROM GEOTRACK_PHOTOS');
});

test('503 when the zones or the fallback cannot be read, or the store fails with HANA down; 500 when HANA rejects the row', async () => {
  let db = fakeDb({ fail: (w) => w === 'SELECT ID, GEOTRACK_ZONES' && 'down' });
  assert.equal((await withServer({ db }, (url) => post(url, BODY))).status, 503);
  db = fakeDb({ fail: (w) => (w.startsWith('UPSERT') || w === 'SELECT 1 DUMMY') && 'down' });
  assert.deepEqual(await withServer({ db }, (url) => post(url, BODY)), { status: 503, json: { error: 'database unavailable' } });
  db = fakeDb({ fail: (w) => w.startsWith('UPSERT') && 'value too large' });
  assert.deepEqual(await withServer({ db }, (url) => post(url, BODY)), { status: 500, json: { error: 'not stored' } });
});

test('a private zone without a centre → 500, nothing stored', async () => {
  const db = fakeDb({ zones: [{ ...ZONE_ROWS[0], CENTRELAT: null }] });
  assert.equal((await withServer({ db }, (url) => post(url, BODY))).status, 500);
  assert.deepEqual(db.what(), ['SELECT ID, GEOTRACK_ZONES']);
});
