'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cds = require('@sap/cds');
const { csrfGuard } = require('../srv/lib/mode');
const { HANA_DOWN } = require('../srv/lib/trip-read');

// TripService through CAP's real OData layer, over a fake db (never HANA): the delete's wiring, the
// CSRF guard that server.js mounts on /trips, and what a HANA error shows in production.
const ID = '0b6c0d7e-1f2a-5b3c-8d9e-0a1b2c3d4e5f';
const calls = [];
const env = { NODE_ENV: process.env.NODE_ENV, GEOTRACK_INGEST: process.env.GEOTRACK_INGEST };
let base, server, failure; // failure: makes the fake db throw a fresh error from this function

before(async () => {
  cds.connect.to = async () => { throw new Error('this test never connects to a database'); };
  cds.db = { run: async (sql, params) => { calls.push({ sql, params }); if (failure) throw failure(); return { changes: 1 }; } };
  const app = express();
  app.use('/trips', csrfGuard);
  await cds.serve('TripService').from(await cds.load(['srv/trip-service.cds'])).in(app);
  server = app.listen(0, '127.0.0.1'); // not on every address: see test/test-servers.test.js
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/trips`;
});
after(() => {
  server.close();
  server.closeAllConnections(); // fetch keeps its connections alive
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

/** The status of one request, with the statements it ran; `ingest` false is the Mac's read-only mode. */
async function send(path, init, { ingest = true } = {}) {
  delete process.env.NODE_ENV;
  if (ingest) process.env.GEOTRACK_INGEST = '1'; else delete process.env.GEOTRACK_INGEST;
  calls.length = 0;
  const r = await fetch(base + path, { method: 'POST', ...init });
  await r.arrayBuffer();
  return { status: r.status, sql: calls.map((c) => `${c.sql} ${c.params}`) };
}
const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const DELETED = [`DELETE FROM GEOTRACK_PHOTOS WHERE ID = ? ${ID}`];
/** A $batch with one request, the delete; `type` is the outer Content-Type. */
const batch = (type) => ({ headers: { 'Content-Type': type }, body: ['--b1', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', '',
  'POST deletePhoto HTTP/1.1', 'Content-Type: application/json', '', JSON.stringify({ ID }), '--b1--', ''].join('\r\n') });

test('deletePhoto with a JSON body deletes the row: 204', async () => {
  assert.deepEqual(await send('/deletePhoto', json({ ID })), { status: 204, sql: DELETED });
});

test("read-only mode (the Mac's npm run ui) answers 403 and runs no SQL", async () => {
  assert.deepEqual(await send('/deletePhoto', json({ ID }), { ingest: false }), { status: 403, sql: [] });
});

test('what a cross-site page can send without a CORS preflight gets 415 and runs no SQL', async () => {
  // CAP picks its $batch parser by a substring of Content-Type: this one is text/plain to the browser.
  assert.deepEqual(await send('/$batch', batch('text/plain; boundary=b1; x=multipart/mixed')), { status: 415, sql: [] });
  assert.deepEqual(await send('/deletePhoto', { headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ID }) }), { status: 415, sql: [] });
  assert.deepEqual(await send('/deletePhoto', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `ID=${ID}` }), { status: 415, sql: [] });
  assert.deepEqual(await send('/deletePhoto', {}), { status: 415, sql: [] });
});

test("the app's own $batch (multipart/mixed) and GETs still pass the guard", async () => {
  assert.deepEqual(await send('/$batch', batch('multipart/mixed; boundary=b1')), { status: 200, sql: DELETED });
  assert.deepEqual(await send('/deletePhoto', { method: 'GET' }), { status: 405, sql: [] }, "CAP's own answer, not the guard's 415");
});

test('production (the Docker image): a HANA error answers with the fixed hint and nothing of the error, in a $batch too', async () => {
  // As @cap-js/hana throws it: the SQL text on `query`.
  failure = () => Object.assign(new Error('invalid table name: Could not find table/view GEOTRACK_PHOTOS in schema F79B'),
    { code: 259, sqlState: 'HY000', query: 'DELETE FROM GEOTRACK_PHOTOS WHERE ID = ?' });
  process.env.NODE_ENV = 'production'; // only then does CAP replace a 5xx body with "Internal Server Error"
  const hint = JSON.stringify({ error: { message: HANA_DOWN, code: '500', '@Common.numericSeverity': 4 } });
  try {
    for (const [path, init] of [['/Trips', {}], ['/deletePhoto', { method: 'POST', ...json({ ID }) }]]) {
      const r = await fetch(base + path, init);
      assert.deepEqual([r.status, await r.text()], [500, hint], path);
    }
    // Inside a $batch, as the app sends its requests: one part, its status line and headers, then the body.
    const r = await fetch(base + '/$batch', { method: 'POST', ...batch('multipart/mixed; boundary=b1') });
    const [, head, body] = (await r.text()).split('\r\n\r\n');
    assert.match(head, /^HTTP\/1\.1 500 /);
    assert.equal(body, `${hint}\r\n--b1--\r\n`);
  } finally {
    failure = undefined;
  }
});
