'use strict';
// Live checks for the read-only trip app (slice 5a) against a running `npm run ui`.
// Reads only; prints counts and statuses, never coordinates, names or values.
// Run: npm run ui   (other terminal), then: node scripts/ui-smoke.js   (UI_URL overrides http://localhost:4008)
const assert = require('node:assert/strict');
const os = require('node:os');

const BASE = process.env.UI_URL ?? 'http://localhost:4008';
const get = (path, init) => fetch(BASE + path, init);
const json = async (path) => { const r = await get(path); assert.equal(r.status, 200, `${path} → ${r.status}`); return r.json(); };

const checks = [
  ['$metadata and the app load', async () => {
    assert.equal((await get('/trips/$metadata')).status, 200);
    assert.equal((await get('/tripsui/webapp/index.html')).status, 200);
  }],
  ['Trips returns rows with units', async () => {
    const { value } = await json('/trips/Trips?$select=ID,kindText,lengthM,unitM&$top=5');
    assert.ok(value.length > 0, 'no trips');
    assert.equal(value[0].unitM, 'm');
    return `${value.length} trips`;
  }],
  ['a trip with a photo expands weather, workouts, minutes and photos', async () => {
    const { value } = await json('/trips/Trips?$select=ID&$expand=photos($select=ID)');
    const trip = value.find((t) => t.photos.length);
    assert.ok(trip, 'no trip with a photo');
    const t = await json(`/trips/Trips(${trip.ID})?$select=ID&$expand=weather($select=hour,weatherCode,weatherText),workouts($select=workout_ID),minutes($select=minuteTS,hrAvg),photos($select=ID)`);
    for (const k of ['weather', 'workouts', 'minutes', 'photos']) assert.ok(Array.isArray(t[k]), k);
    assert.ok(t.weather.every((w) => w.weatherCode == null || typeof w.weatherText === 'string'), 'weatherText not filled');
    return `weather ${t.weather.length}, workouts ${t.workouts.length}, minutes ${t.minutes.length}, photos ${t.photos.length}`;
  }],
  ['a thumbnail streams as JPEG', async () => {
    const { value: [p] } = await json('/trips/TripPhotos?$select=ID&$top=1');
    const r = await get(`/trips/TripPhotos(${p.ID})/thumbnail`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^image\/jpeg/);
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(b.subarray(0, 2).toString('hex'), 'ffd8');
    return `${b.length} B`;
  }],
  ['TripPhotos IDs are unique (no duplicate rows from an overlapping join)', async () => {
    const { value } = await json('/trips/TripPhotos?$select=ID');
    assert.equal(new Set(value.map((p) => p.ID)).size, value.length, 'duplicate TripPhotos ID');
    return `${value.length} photos`;
  }],
  ['writes are refused with the read-only message', async () => {
    const r = await get('/trips/Trips', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 405);
    assert.match((await r.json()).error.message, /read-only/);
  }],
  ['ingest routes and IngestService are not served', async () => {
    assert.equal((await get('/ingest/$metadata')).status, 404);
    assert.equal((await get('/photos', { method: 'POST' })).status, 404);
    assert.equal((await get('/health/workouts', { method: 'POST' })).status, 404);
  }],
  ['a request through the LAN address gets 403', async () => {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!lan) return 'skipped: no LAN address';
    const r = await fetch(BASE.replace(/\/\/[^:/]+/, `//${lan.address}`) + '/trips/$metadata');
    assert.equal(r.status, 403);
  }],
  ['cross-origin reads are not allowed', async () => {
    const r = await get('/trips/$metadata', { headers: { Origin: 'https://example.com' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  }],
  ['a foreign Host name gets 403', async () => {
    const { hostname, port } = new URL(BASE);
    const http = require('node:http');
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ hostname, port, path: '/trips/$metadata', headers: { Host: 'evil.example:4008' } }, (res) => resolve(res.statusCode));
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  }],
];

(async () => {
  let failed = 0;
  for (const [name, fn] of checks) {
    try { const note = await fn(); console.log(`ok   ${name}${note ? ` (${note})` : ''}`); }
    catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
  }
  console.log(failed ? `${failed} of ${checks.length} failed` : `all ${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();
