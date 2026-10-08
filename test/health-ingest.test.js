'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cds = require('@sap/cds');
const { mount } = require('../srv/lib/health-ingest');
const { circleToWkt } = require('../srv/lib/geo');
const fixture = require('./fixtures/health-workouts.json');

const TOKEN = 'test-token-not-a-secret';
// Synthetic private zone around 42.50/1.50 (r 100 m), as the zone SELECT returns it.
const ZONE_ROWS = [{ ID: 'home', KIND: 'circle', RADIUSM: 100, ISPRIVATE: true, CENTRELAT: '42.500000', CENTRELON: '1.500000', WKT: Buffer.from(circleToWkt(42.5, 1.5, 100)) }];

/**
 * Records every statement as "<tx> <verb> <target>"; tx 0 = outside any transaction.
 * `fail(what, q)` returning a message makes that statement throw.
 */
function fakeDb({ zones = ZONE_ROWS, fail = () => null } = {}) {
  const calls = [], rows = {};
  let txSeq = 0;
  const run = (tx) => async (q, params) => {
    const [verb] = typeof q === 'string' ? [q.trim().split(/\s+/)[0]] : Object.keys(q);
    const target = typeof q === 'string' ? (/GEOTRACK_\w+|DUMMY/.exec(q) ?? [''])[0] : (q[verb].into ?? q[verb].from).ref[0];
    calls.push({ tx, what: `${verb} ${target}`, q, params });
    const message = fail(`${verb} ${target}`, q);
    if (message) throw Object.assign(new Error(message), { code: 999 });
    if (verb === 'SELECT' && target === 'GEOTRACK_ZONES') return zones;
    if (verb === 'INSERT' || verb === 'UPSERT') (rows[target] ??= []).push(...q[verb].entries);
    return verb === 'SELECT' ? [{ 1: 1 }] : { changes: 1 };
  };
  return { run: run(0), tx: (fn) => fn({ run: run(++txSeq) }), calls, rows, what: () => calls.map((c) => `${c.tx} ${c.what}`) };
}

async function withServer(opts, fn) {
  const app = express();
  // The real refresh needs HANA; tests that care pass their own.
  mount(app, { token: TOKEN, device: 'iphone', refresh: async () => {}, ...opts });
  const server = app.listen(0, '127.0.0.1'); // not on every address: see test/test-servers.test.js
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}/health/workouts`); } finally { server.close(); }
}
const post = (url, body, { token = TOKEN, raw } = {}) => fetch(url, {
  method: 'POST', body: raw ?? JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
}).then(async (r) => ({ status: r.status, json: await r.json() }));

test('401 without or with a wrong token, nothing touched', async () => {
  const db = fakeDb();
  await withServer({ db }, async (url) => {
    assert.equal((await post(url, fixture, { token: null })).status, 401);
    assert.equal((await post(url, fixture, { token: 'wrong' })).status, 401);
    assert.equal((await post(url, fixture, { token: `${TOKEN}x` })).status, 401);
  });
  assert.deepEqual(db.calls, []);
});

test('a rejected token logs a reason, never the token itself', async () => {
  const log = cds.log('health');
  const original = log.warn;
  const calls = [];
  log.warn = (...args) => calls.push(args);
  const WRONG_TOKEN = 'sent-but-wrong-token-value';
  try {
    const db = fakeDb();
    await withServer({ db }, async (url) => {
      assert.equal((await post(url, fixture, { token: WRONG_TOKEN })).status, 401);
      assert.equal((await post(url, fixture, { token: null })).status, 401);
    });
  } finally {
    log.warn = original;
  }
  const messages = calls.map((args) => args.join(' '));
  assert.equal(messages.filter((m) => m.includes('401') && m.includes('token mismatch')).length, 1);
  assert.equal(messages.filter((m) => m.includes('401') && m.includes('no Bearer header')).length, 1);
  assert.ok(!calls.flat().some((a) => String(a).includes(WRONG_TOKEN)), 'the sent token must never be logged');
  assert.ok(!calls.flat().some((a) => String(a).includes(TOKEN)), 'the configured token must never be logged');
});

test('503 when no token is configured', async () => {
  const db = fakeDb();
  await withServer({ db, token: '' }, async (url) => assert.equal((await post(url, fixture)).status, 503));
  assert.deepEqual(db.calls, []);
});

test('the body is not parsed before the token is checked: a huge body without token → 401, not 413', async () => {
  await withServer({ db: fakeDb() }, async (url) => {
    assert.equal((await post(url, null, { token: null, raw: `{"x":"${'a'.repeat(21 * 1024 * 1024)}"}` })).status, 401);
  });
});

test('400 for unparseable JSON or a body without data.workouts; a 15 MB body is read, 413 over 20 MB', async () => {
  const db = fakeDb();
  await withServer({ db }, async (url) => {
    const bad = await post(url, null, { raw: '{"data": ' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'entity.parse.failed');
    assert.equal((await post(url, { data: {} })).status, 400);
    assert.equal((await post(url, { workouts: [] })).status, 400);
    assert.equal((await post(url, null, { raw: `{"x":"${'a'.repeat(15 * 1024 * 1024)}"}` })).status, 400); // parsed: no data.workouts
    assert.equal((await post(url, null, { raw: `{"x":"${'a'.repeat(21 * 1024 * 1024)}"}` })).status, 413);
  });
  assert.deepEqual(db.calls, []);
});

test('200: the fixture walk stored in one transaction — upsert, delete both series, insert, points', async () => {
  const db = fakeDb();
  const r = await withServer({ db }, (url) => post(url, fixture));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { device: 'iphone', workouts: [{ id: '7B3E3D5C-1D2A-4F0E-9A51-2C4B8E6F0A11', name: 'Outdoor Walk', hrSamples: 7, routePoints: 6, coarsened: 2, startsInPrivateZone: true, endsInPrivateZone: false }], skipped: [] });
  assert.deepEqual(db.what(), [
    '0 SELECT GEOTRACK_ZONES',
    '1 UPSERT geotrack.Workouts', '1 DELETE geotrack.WorkoutHeartRate', '1 DELETE geotrack.WorkoutRoute',
    '1 INSERT geotrack.WorkoutHeartRate', '1 INSERT geotrack.WorkoutRoute', '1 UPDATE GEOTRACK_WORKOUTROUTE',
  ]);
  const [w] = db.rows['geotrack.Workouts'];
  assert.deepEqual([w.device, w.hrSamples, w.routePoints, w.routePointsCoarsened, w.startsInPrivateZone, w.endsInPrivateZone], ['iphone', 7, 6, 2, true, false]);
  assert.ok(!Number.isNaN(Date.parse(w.receivedAt)));
  assert.ok(db.rows['geotrack.WorkoutRoute'].every((p) => p.workout_ID === w.ID));
  assert.ok(!JSON.stringify(db.rows).includes('42.5003'), 'a real coordinate inside the private zone reached the database');
});

test('a resend replaces: the same statements again, DELETE before INSERT inside each transaction', async () => {
  const db = fakeDb();
  await withServer({ db }, async (url) => { await post(url, fixture); await post(url, fixture); });
  const second = db.what().filter((c) => c.startsWith('2 '));
  assert.deepEqual(second, ['2 UPSERT geotrack.Workouts', '2 DELETE geotrack.WorkoutHeartRate', '2 DELETE geotrack.WorkoutRoute',
    '2 INSERT geotrack.WorkoutHeartRate', '2 INSERT geotrack.WorkoutRoute', '2 UPDATE GEOTRACK_WORKOUTROUTE']);
});

test('incomplete workouts are skipped and reported, the others stored', async () => {
  const db = fakeDb();
  const good = fixture.data.workouts[0];
  const body = { data: { workouts: [{ ...good, id: undefined }, good, { ...good, id: 'B', end: 'soon' }] } };
  const r = await withServer({ db }, (url) => post(url, body));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.workouts.map((w) => w.id), [good.id]);
  assert.deepEqual(r.json.skipped, [{ index: 0, reason: 'missing id' }, { index: 2, reason: 'missing or unreadable end' }]);
});

test('an indoor workout without route or heart rate stores only the row', async () => {
  const db = fakeDb();
  const { route, heartRateData, heartRateRecovery, ...indoor } = fixture.data.workouts[0];
  const r = await withServer({ db }, (url) => post(url, { data: { workouts: [{ ...indoor, isIndoor: true }] } }));
  assert.deepEqual(r.json.workouts[0], { id: indoor.id, name: 'Outdoor Walk', hrSamples: 0, routePoints: 0, coarsened: 0, startsInPrivateZone: false, endsInPrivateZone: false });
  assert.deepEqual(db.what(), ['0 SELECT GEOTRACK_ZONES', '1 UPSERT geotrack.Workouts', '1 DELETE geotrack.WorkoutHeartRate', '1 DELETE geotrack.WorkoutRoute']);
});

test('503 when the zones cannot be read (HANA down): nothing stored', async () => {
  const db = fakeDb({ fail: (what) => what === 'SELECT GEOTRACK_ZONES' && 'connection refused' });
  const r = await withServer({ db }, (url) => post(url, fixture));
  assert.equal(r.status, 503);
  assert.equal(db.calls.filter((c) => c.tx).length, 0);
});

test('a store error with HANA down → 503; with HANA up → that workout skipped, the next one stored', async () => {
  const good = fixture.data.workouts[0];
  const two = { data: { workouts: [good, { ...good, id: 'second' }] } };
  let db = fakeDb({ fail: (what) => (what === 'UPSERT geotrack.Workouts' || what === 'SELECT DUMMY') && 'down' });
  let r = await withServer({ db }, (url) => post(url, two));
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { error: 'database unavailable', stored: 0 });

  db = fakeDb({ fail: (what, q) => what === 'INSERT geotrack.WorkoutRoute' && q.INSERT.entries[0].workout_ID === good.id && 'value too large' });
  r = await withServer({ db }, (url) => post(url, two));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.skipped, [{ index: 0, id: good.id, reason: 'not stored: value too large' }]);
  assert.deepEqual(r.json.workouts.map((w) => w.id), ['second']);
});

test('a private zone without a centre → 500, nothing stored', async () => {
  const db = fakeDb({ zones: [{ ...ZONE_ROWS[0], CENTRELAT: null }] });
  const r = await withServer({ db }, (url) => post(url, fixture));
  assert.equal(r.status, 500);
  assert.equal(db.calls.filter((c) => c.tx).length, 0);
});

test('a stored workout refreshes the trips it overlaps; a workout that was not stored does not', async () => {
  const seen = [];
  const refresh = async (device, workout) => { seen.push([device, workout.ID, typeof workout.startedAt, typeof workout.endedAt]); };
  const r = await withServer({ db: fakeDb(), refresh }, (url) => post(url, fixture));
  assert.equal(r.status, 200);
  assert.ok(r.json.workouts.length > 0);
  assert.deepEqual(seen, r.json.workouts.map((w) => ['iphone', w.id, 'string', 'string']));

  seen.length = 0;
  const failing = fakeDb({ fail: (what) => (what === 'UPSERT geotrack.Workouts' ? 'not stored' : null) });
  const skipped = await withServer({ db: failing, refresh }, (url) => post(url, fixture));
  assert.equal(skipped.json.workouts.length, 0);
  assert.deepEqual(seen, []);
});

test('a failing refresh is logged by its code and never fails the sync', async () => {
  const log = cds.log('health');
  const original = log.error;
  const lines = [];
  log.error = (...args) => lines.push(args.join(' '));
  let r;
  try {
    const refresh = async () => { throw Object.assign(new Error('value 42.123456 quoted by HANA'), { code: 259 }); };
    r = await withServer({ db: fakeDb(), refresh }, (url) => post(url, fixture));
  } finally {
    log.error = original;
  }
  assert.equal(r.status, 200);
  assert.ok(r.json.workouts.length > 0);
  assert.ok(lines.some((l) => l.includes('trip routes not refreshed') && l.includes('259')), lines.join(' | '));
  assert.ok(!lines.some((l) => l.includes('42.123456')), 'the error message must not be logged');
});

const appBody = require('./fixtures/ios-workout.json');
const APP_ID = appBody.data.workouts[0].id;

test('a request without a device is stored under the configured one, as Health Auto Export sends it', async () => {
  const db = fakeDb();
  const r = await withServer({ db, device: 'iphone' }, (url) => post(url, { data: appBody.data }));
  assert.equal(r.status, 200);
  assert.deepEqual([db.rows['geotrack.Workouts'][0].ID, db.rows['geotrack.Workouts'][0].device], [APP_ID, 'iphone']);
});

test('a trial device: stored apart under <device>:<id> with its own device, coarsened, no trip rebuilt, answered by the id that was sent', async () => {
  const db = fakeDb();
  const seen = [];
  const r = await withServer({ db, refresh: async (device) => { seen.push(device); } }, (url) => post(url, appBody));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { device: 'trial-iphone', workouts: [{ id: APP_ID, name: 'Outdoor Walk', hrSamples: 5, routePoints: 3, coarsened: 1, startsInPrivateZone: true, endsInPrivateZone: false }], skipped: [] });
  const stored = `trial-iphone:${APP_ID}`;
  const [w] = db.rows['geotrack.Workouts'];
  assert.deepEqual([w.ID, w.device], [stored, 'trial-iphone']);
  assert.ok(db.rows['geotrack.WorkoutHeartRate'].every((h) => h.workout_ID === stored));
  assert.ok(db.rows['geotrack.WorkoutRoute'].every((p) => p.workout_ID === stored));
  assert.deepEqual(db.calls.filter((c) => c.what.startsWith('DELETE')).map((c) => c.q.DELETE.where.at(-1).val), [stored, stored]);
  assert.deepEqual(db.calls.find((c) => c.what === 'UPDATE GEOTRACK_WORKOUTROUTE').params, [stored]);
  assert.ok(!JSON.stringify(db.rows).includes('42.5003'), 'a real coordinate inside the private zone reached the database');
  assert.deepEqual(seen, [], 'a trial workout must not rebuild a trip');
});

test('HEALTH_DEVICE naming a trial device: a request without a device is stored apart and rebuilds no trip', async () => {
  const db = fakeDb();
  const seen = [];
  process.env.HEALTH_DEVICE = 'trial-iphone';
  let r;
  try { r = await withServer({ db, device: undefined, refresh: async (device) => { seen.push(device); } }, (url) => post(url, { data: appBody.data })); } finally { delete process.env.HEALTH_DEVICE; }
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.device, r.json.workouts.map((w) => w.id)], ['trial-iphone', [APP_ID]]);
  assert.deepEqual([db.rows['geotrack.Workouts'][0].ID, db.rows['geotrack.Workouts'][0].device], [`trial-iphone:${APP_ID}`, 'trial-iphone']);
  assert.deepEqual(seen, []);
});

test('a device of null is no device: the configured one is used, as when the key is absent', async () => {
  const db = fakeDb();
  const seen = [];
  const r = await withServer({ db, device: 'iphone', refresh: async (device) => { seen.push(device); } }, (url) => post(url, { ...appBody, device: null }));
  assert.equal(r.status, 200);
  assert.equal(r.json.device, 'iphone');
  assert.deepEqual([db.rows['geotrack.Workouts'][0].ID, db.rows['geotrack.Workouts'][0].device], [APP_ID, 'iphone']);
  assert.deepEqual(seen, ['iphone']);
});

test('a device and an empty list: answered with the device the request would be stored under, nothing written', async () => {
  const db = fakeDb();
  const r = await withServer({ db }, (url) => post(url, { device: 'trial-iphone', data: { workouts: [] } }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { device: 'trial-iphone', workouts: [], skipped: [] });
  assert.deepEqual(db.what(), ['0 SELECT GEOTRACK_ZONES']);
});

test('a named device that is no trial device is stored under the id as sent and rebuilds trips', async () => {
  const db = fakeDb();
  const seen = [];
  const r = await withServer({ db, refresh: async (device) => { seen.push(device); } }, (url) => post(url, { ...appBody, device: 'iphone' }));
  assert.equal(r.status, 200);
  assert.deepEqual([db.rows['geotrack.Workouts'][0].ID, db.rows['geotrack.Workouts'][0].device], [APP_ID, 'iphone']);
  assert.deepEqual(seen, ['iphone']);
});

test('400 for a device that is not 1 to 40 of a-z, 0-9 and -; nothing touched', async () => {
  const db = fakeDb();
  await withServer({ db }, async (url) => {
    for (const device of ['', 'Trial_iPhone', 'trial iphone', 'a'.repeat(41), 7, {}, ['trial-iphone']]) {
      const r = await post(url, { ...appBody, device });
      assert.equal(r.status, 400, JSON.stringify(device));
      assert.equal(r.json.error, 'device must be 1 to 40 of a-z, 0-9 and -');
    }
  });
  assert.deepEqual(db.calls, []);
});

test('a trial workout whose id does not fit the column with the device prefix is skipped, the next one stored', async () => {
  const db = fakeDb();
  const good = appBody.data.workouts[0];
  const long = { ...good, id: 'x'.repeat(52) }; // "trial-iphone:" is 13 characters: 65 in all
  const r = await withServer({ db }, (url) => post(url, { device: 'trial-iphone', data: { workouts: [long, { ...good, id: 'x'.repeat(51) }] } }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.skipped, [{ index: 0, id: long.id, reason: 'id longer than 64 characters with the device prefix' }]);
  assert.deepEqual(db.rows['geotrack.Workouts'].map((w) => w.ID.length), [64]);
});

test('a trial workout that HANA rejects is reported by the id that was sent', async () => {
  const db = fakeDb({ fail: (what) => what === 'INSERT geotrack.WorkoutRoute' && 'value too large' });
  const r = await withServer({ db }, (url) => post(url, appBody));
  assert.deepEqual(r.json.skipped, [{ index: 0, id: APP_ID, reason: 'not stored: value too large' }]);
});
