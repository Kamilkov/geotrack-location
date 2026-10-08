'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchTrip, enrichMissing } = require('../srv/lib/weather');
const fixture = require('./fixtures/open-meteo-2026-09-22.json');

const TRIP = '11111111-1111-5111-8111-111111111111';
const tripRow = { ID: TRIP, STARTEDAT: '2026-09-22T15:43:46', ENDEDAT: '2026-09-22T17:06:25' }; // HANA-style offset-less strings
const posRows = [
  { TS: '2026-09-22T15:43:46', LAT: '42.500000', LON: '1.500000' },
  { TS: '2026-09-22T16:31:25', LAT: '42.510000', LON: '1.490000' },
  { TS: '2026-09-22T17:06:25', LAT: '42.500000', LON: '1.500000' },
];
const NOW = new Date('2026-09-24T10:00:00Z');

/**
 * Fake db: records every statement; answers the trip/positions/enrich SELECTs from `data`.
 * Each call is tagged with the id of the db.tx(...) it ran through (null outside any tx), so
 * tests can assert which statements share a root transaction and which run in separate ones.
 */
function fakeDb(data = {}) {
  const calls = [];
  let txSeq = 0;
  const makeRun = (txId) => async (sql, params) => {
    calls.push({ sql, params, tx: txId });
    if (/FROM GEOTRACK_TRIPS WHERE ID = \?/.test(sql)) return data.trip === undefined ? [tripRow] : (data.trip ? [data.trip] : []);
    if (/FROM GEOTRACK_POSITIONS WHERE TRIP_ID = \?/.test(sql)) return data.positions ?? posRows;
    if (/WEATHERFETCHEDAT IS NULL/.test(sql)) return data.missing ?? [];
    if (/UPDATE GEOTRACK_TRIPS SET WEATHERCODE/.test(sql)) return { changes: data.summaryChanges ?? 1 };
    return { changes: 1 };
  };
  const run = makeRun(null);
  const tx = (fn) => fn({ run: makeRun(++txSeq) });
  return { run, tx, calls, sqls: () => calls.map((c) => c.sql.replace(/\s+/g, ' ').trim()) };
}
const okFetch = (body = fixture) => async (url, opts) => {
  okFetch.last = { url, opts };
  return { ok: true, status: 200, json: async () => body };
};

test('fetchTrip: success writes rows and summary in one tx and resets the bookkeeping', async () => {
  const db = fakeDb();
  const r = await fetchTrip(TRIP, { fetch: okFetch(), db, now: () => NOW });
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 3);
  assert.equal(okFetch.last.opts.headers['User-Agent'], 'geotrack');
  assert.ok(okFetch.last.opts.signal, 'a timeout signal is passed');
  assert.match(okFetch.last.url, /latitude=42\.5,42\.51&longitude=1\.5,1\.49&/);
  const s = db.sqls();
  assert.ok(s.some((q) => q.startsWith('DELETE FROM GEOTRACK_TRIPWEATHER WHERE TRIP_ID = ?')));
  assert.equal(s.filter((q) => q.startsWith('INSERT INTO GEOTRACK_TRIPWEATHER')).length, 3);
  const upd = db.calls.find((c) => /UPDATE GEOTRACK_TRIPS SET WEATHERCODE/.test(c.sql));
  assert.ok(upd, 'summary update');
  assert.match(upd.sql, /WEATHERFETCHEDAT = \?/);
  assert.match(upd.sql, /WEATHERATTEMPTS = 0/);
  assert.match(upd.sql, /WEATHERERROR = NULL/);
  assert.match(upd.sql, /WHERE ID = \? AND ENDEDAT = \?/);
  assert.equal(upd.params[upd.params.length - 2], TRIP);
  assert.equal(upd.params[upd.params.length - 1], '2026-09-22T17:06:25.000Z');
  assert.match(r.text, /°C, .*, .* mm, wind .* km\/h \(3 h\)$/);
  const ins = db.calls.filter((c) => /INSERT INTO GEOTRACK_TRIPWEATHER/.test(c.sql));
  assert.equal(ins[0].params.length, 16);
  assert.equal(ins[0].params[0], TRIP);
  assert.equal(ins[0].params[1], '2026-09-22T15:00:00.000Z');
  const del = db.calls.find((c) => c.sql.startsWith('DELETE FROM GEOTRACK_TRIPWEATHER WHERE TRIP_ID = ?'));
  assert.ok(upd.tx, 'the summary update runs inside a tx');
  assert.equal(del.tx, upd.tx, 'the delete runs in the same tx as the summary update');
  for (const i of ins) assert.equal(i.tx, upd.tx, 'each insert runs in the same tx as the summary update');
});

test('fetchTrip: a resegment mid-fetch (ENDEDAT changed) rejects the write and records an attempt, not stale hours', async () => {
  const db = fakeDb({ summaryChanges: 0 });
  const r = await fetchTrip(TRIP, { fetch: okFetch(), db, now: () => NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /changed/);
  assert.ok(!db.sqls().some((q) => q.startsWith('INSERT INTO GEOTRACK_TRIPWEATHER')), 'no INSERT after the guarded UPDATE saw 0 changes');
  assert.ok(!db.sqls().some((q) => q.startsWith('DELETE FROM GEOTRACK_TRIPWEATHER')), 'no DELETE either — the tx rolled back before it');
  const upd = db.calls.find((c) => /UPDATE GEOTRACK_TRIPS SET WEATHERATTEMPTS/.test(c.sql));
  assert.ok(upd, 'the failure path still recorded an attempt');
  assert.match(upd.sql, /COALESCE\(WEATHERATTEMPTS, 0\) \+ 1/);
  assert.deepEqual(upd.params, [NOW.toISOString(), 'trip changed during the fetch', TRIP]);
  const writeUpd = db.calls.find((c) => /UPDATE GEOTRACK_TRIPS SET WEATHERCODE/.test(c.sql));
  assert.ok(writeUpd.tx, 'the rejected write ran inside a tx');
  assert.ok(upd.tx, 'the failure record runs inside its own root tx (I1)');
  assert.notEqual(upd.tx, writeUpd.tx, 'the failure record is a separate root transaction from the rejected write');
});

test('fetchTrip: HTTP error counts an attempt with COALESCE and writes nothing else', async () => {
  const db = fakeDb();
  const r = await fetchTrip(TRIP, { fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }), db, now: () => NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 500/);
  const s = db.sqls();
  assert.ok(!s.some((q) => /GEOTRACK_TRIPWEATHER/.test(q)));
  const upd = db.calls.find((c) => /UPDATE GEOTRACK_TRIPS SET WEATHERATTEMPTS/.test(c.sql));
  assert.match(upd.sql, /COALESCE\(WEATHERATTEMPTS, 0\) \+ 1/);
  assert.match(upd.sql, /WEATHERATTEMPTEDAT = \?/);
  assert.match(upd.sql, /WEATHERERROR = \?/);
  assert.deepEqual(upd.params, [NOW.toISOString(), 'open-meteo HTTP 500', TRIP]);
  assert.ok(upd.tx, 'the failure record runs inside its own root tx (I1) — a sweep-started pass must not hold this row lock across Open-Meteo I/O');
});

test('fetchTrip: a timeout (AbortError/TimeoutError) is recorded with its message', async () => {
  const db = fakeDb();
  const err = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const r = await fetchTrip(TRIP, { fetch: async () => { throw err; }, db, now: () => NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /timeout/i);
});

test('fetchTrip: incomplete hours writes only the attempt', async () => {
  const db = fakeDb();
  const nulled = JSON.parse(JSON.stringify(fixture));
  nulled[1].hourly.temperature_2m[16] = null;
  const r = await fetchTrip(TRIP, { fetch: okFetch(nulled), db, now: () => NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /incomplete hours/);
  assert.ok(!db.sqls().some((q) => /INSERT INTO GEOTRACK_TRIPWEATHER/.test(q)));
});

test('fetchTrip: unknown or open trip → ok:false without a fetch', async () => {
  let fetched = 0;
  const f = async () => { fetched++; return { ok: true, json: async () => fixture }; };
  assert.equal((await fetchTrip(TRIP, { fetch: f, db: fakeDb({ trip: null }), now: () => NOW })).error, 'trip not found');
  assert.match((await fetchTrip(TRIP, { fetch: f, db: fakeDb({ trip: { ...tripRow, ENDEDAT: null } }), now: () => NOW })).error, /open/);
  assert.equal(fetched, 0);
});

test('enrichMissing: only due trips are fetched, in start order, up to the limit; smoke devices excluded by SQL', async () => {
  const missing = [
    { ID: TRIP, WEATHERATTEMPTS: 0, WEATHERATTEMPTEDAT: null },
    { ID: '22222222-2222-5222-8222-222222222222', WEATHERATTEMPTS: 2, WEATHERATTEMPTEDAT: '2026-09-24T09:55:00' }, // due in 10 min → not yet
    // offset-less WEATHERATTEMPTEDAT (HANA style) 15 min before NOW, backoff wait for attempts=2 is
    // 10 min → due. Without utcDate's offset-less → UTC conversion, `Date - string` is NaN and
    // `NaN >= wait` is always false, so a failed trip would never be retried again, silently.
    { ID: '33333333-3333-5333-8333-333333333333', WEATHERATTEMPTS: 2, WEATHERATTEMPTEDAT: '2026-09-24T09:45:00' },
  ];
  const db = fakeDb({ missing });
  const r = await enrichMissing({ fetch: okFetch(), db, now: () => NOW });
  assert.deepEqual(r, { attempted: 2, ok: 2 });
  const sel = db.calls.find((c) => /WEATHERFETCHEDAT IS NULL/.test(c.sql));
  assert.match(sel.sql, /ENDEDAT IS NOT NULL/);
  assert.match(sel.sql, /DEVICE NOT LIKE 'smoke%'/);
  assert.match(sel.sql, /ORDER BY STARTEDAT/);
});

test('enrichMissing: concurrent calls share one pass', async () => {
  let resolveFetch;
  const slow = () => new Promise((res) => { resolveFetch = () => res({ ok: true, json: async () => fixture }); });
  const db = fakeDb({ missing: [{ ID: TRIP, WEATHERATTEMPTS: 0, WEATHERATTEMPTEDAT: null }] });
  const p1 = enrichMissing({ fetch: slow, db, now: () => NOW });
  const p2 = enrichMissing({ fetch: slow, db, now: () => NOW });
  assert.equal(p1, p2, 'second caller gets the in-flight promise');
  await new Promise((r) => setImmediate(r)); // let the chained SELECT awaits (missing → trip → positions) resolve before the fetch() call is reached
  resolveFetch();
  assert.deepEqual(await p1, { attempted: 1, ok: 1 });
  assert.equal(db.calls.filter((c) => /WEATHERFETCHEDAT IS NULL/.test(c.sql)).length, 1);
});
