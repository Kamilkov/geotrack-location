// Live checks for the GeoAgentService MCP tools (slice 5b) against a running `npm run ui`.
// Real data: prints only check labels and counts, never values, names or coordinates.
// Run: npm run ui   (other terminal), then: npm run mcp-smoke   (MCP_URL overrides the endpoint)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import cds from '@sap/cds';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.MCP_URL ?? 'http://localhost:4008/mcp/geotrack';
const client = new Client({ name: 'geotrack-smoke', version: '0.1.0' });
const call = async (name, args = {}) => client.callTool({ name, arguments: args });
const result = (r) => r.structuredContent.result;
const text = (r) => r.content[0]?.text ?? '';
const LEAK = /SELECT|GEOTRACK_|hana|\.js:/i;
// Keys that would carry a coordinate or geometry; `latest` and other words merely containing "lat" are fine.
const COORD_KEY = /^(lat|lon|latitude|longitude)$|wkt|route|point|centre|center|geom/i;
// Values that would carry a geometry literal or coordinate-precision decimal (5+ fractional digits).
const COORD_VALUE = /POINT\s*\(|LINESTRING|-?\d{1,3}\.\d{5,}/;
const seen = []; // every result, for the privacy scan at the end
const keep = (r) => { seen.push(r.structuredContent ?? text(r)); return r; };
function scan(v, path = '$') {
  if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    assert.doesNotMatch(k, COORD_KEY, `coordinate-like key at ${path}.${k}`);
    scan(x, `${path}.${k}`);
  }
  else if (typeof v === 'string' || typeof v === 'number') {
    assert.doesNotMatch(String(v), COORD_VALUE, `coordinate-like value at ${path}`);
  }
}
const rejected = (r, msg) => { assert.equal(r.isError, true); assert.match(text(r), msg); assert.doesNotMatch(text(r), LEAK); };
let checks = 0;
const check = async (label, fn) => { const note = await fn(); checks++; console.log('ok  ', label, note ?? ''); };

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));

  await check('1 tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['describe', 'query', 'totals', 'tripDetail', 'tripsNear', 'zoneStats']);
  });

  await check('query on Trips', async () => {
    const q = keep(await call('query', { entity: 'Trips', select: [{ ref: ['ID'] }, { ref: ['workoutCount'] }] })).structuredContent;
    assert.ok(q.data.length > 0, 'no trips');
    return `${q.data.length} rows`;
  });

  // --- function checks: Task 3 and Task 4 insert their blocks here ---

  await check('2 totals: the kinds sum to the all row', async () => {
    const rows = result(keep(await call('totals', { groupBy: 'all' })));
    const all = rows.find((r) => r.kind === 'all');
    const parts = rows.filter((r) => r.kind !== 'all');
    for (const f of ['trips', 'distanceM', 'durationMin']) assert.equal(parts.reduce((n, r) => n + r[f], 0), all[f], f);
    return `${parts.length} kinds`;
  });

  await check('3 totals over all trips match SQL (omitted arguments take the defaults)', async () => {
    const db = await cds.connect.to('db');
    const [s] = await db.run(`SELECT COUNT(*) AS N, COALESCE(SUM(LENGTHM), 0) AS M, COALESCE(SUM(DURATIONMIN), 0) AS D
      FROM GEOTRACK_TRIPS WHERE ENDEDAT IS NOT NULL AND DEVICE NOT LIKE 'smoke%'`);
    const rows = result(keep(await call('totals', { groupBy: 'all' })));
    const all = rows.find((r) => r.kind === 'all');
    assert.deepEqual([all?.trips ?? 0, all?.distanceM ?? 0, all?.durationMin ?? 0], [Number(s.N), Number(s.M), Number(s.D)]);
  });

  await check('3b totals: an explicit full range matches the default (omitted) range', async () => {
    const wide = result(keep(await call('totals', { from: '2000-01-01', to: '2099-12-31', groupBy: 'all' })));
    const dflt = result(keep(await call('totals', { groupBy: 'all' })));
    assert.deepEqual(wide, dflt);
  });

  await check('4 zoneStats: case-insensitive name, unknown zone lists the known ones', async () => {
    const home = result(keep(await call('zoneStats', { zone: ' HOME ' })));
    assert.equal(home.zone.toLowerCase(), 'home');
    for (const f of ['visits', 'passthroughs', 'stays', 'totalMin']) assert.equal(typeof home[f], 'number', f);
    assert.ok(Array.isArray(home.latest) && home.latest.length <= 20);
    rejected(keep(await call('zoneStats', { zone: 'nope' })), /Zone not found\. Known zones: /);
  });

  await check('6a totals: fixed messages for bad input', async () => {
    rejected(keep(await call('totals', { from: 'x', to: 'y' })), /from must be YYYY-MM-DD/);
    rejected(keep(await call('totals', { from: '2026-09-01' })), /from and to go together/);
    rejected(keep(await call('totals', { groupBy: 'quarter' })), /groupBy must be day, week, month, year or all/);
    rejected(keep(await call('totals', { kind: 'bike' })), /kind must be walk, drive or all/);
  });

  await check('5 tripDetail: arrays present, a trip without workouts has none, unknown ID rejected', async () => {
    const zero = keep(await call('query', {
      entity: 'Trips', select: [{ ref: ['ID'] }, { ref: ['workoutCount'] }],
      where: [{ ref: ['workoutCount'] }, '=', { val: 0 }], limit: 1,
    })).structuredContent;
    const trip = zero.data[0] ?? keep(await call('query', {
      entity: 'Trips', select: [{ ref: ['ID'] }, { ref: ['workoutCount'] }], limit: 1,
    })).structuredContent.data[0];
    const d = result(keep(await call('tripDetail', { ID: trip.ID })));
    assert.equal(d.ID, trip.ID);
    for (const k of ['weather', 'workouts', 'zoneStays']) assert.ok(Array.isArray(d[k]), k);
    if (trip.workoutCount === 0) assert.deepEqual(d.workouts, []);
    assert.match(d.startedAt, /[+-]\d\d:\d\d$/);
    rejected(keep(await call('tripDetail', { ID: randomUUID() })), /Trip not found/);
  });

  await check('6b tripsNear: fixed messages, nothing at 0,0', async () => {
    rejected(keep(await call('tripsNear', { lat: 91, lon: 0 })), /lat must be between -90 and 90/);
    rejected(keep(await call('tripsNear', { lat: 0, lon: 181 })), /lon must be between -180 and 180/);
    rejected(keep(await call('tripsNear', { lat: 0, lon: 0, radiusM: 0 })), /radiusM must be 1\.\.50000/);
    assert.deepEqual(result(keep(await call('tripsNear', { lat: 0, lon: 0 }))), []);
  });

  await check('6c tripsNear finds trips at a public zone with stays, closest first', async () => {
    // The point is read at runtime and never printed; only counts leave this script.
    const db = await cds.connect.to('db');
    const [z] = await db.run(`SELECT CENTRELAT AS A, CENTRELON AS O FROM GEOTRACK_ZONES Z
      WHERE ISPRIVATE = FALSE AND CENTRELAT IS NOT NULL
        AND EXISTS (SELECT 1 FROM GEOTRACK_ZONEEVENTS E WHERE E.ZONE_ID = Z.ID AND E.DEVICE NOT LIKE 'smoke%')`);
    if (!z) return 'skipped: no public zone with stays';
    const rows = result(keep(await call('tripsNear', { lat: Number(z.A), lon: Number(z.O), radiusM: 300 })));
    assert.ok(rows.length > 0, 'no trip near a zone that has stays');
    rows.forEach((r, i) => { assert.ok(r.closestM <= 300); if (i) assert.ok(rows[i - 1].closestM <= r.closestM); });
    return `${rows.length} trips`;
  });

  await check('7 full entity rows and describe: no coordinate-like keys or values sneak past a narrow select', async () => {
    for (const entity of ['Trips', 'Workouts', 'Zones']) keep(await call('query', { entity }));
    keep(await call('describe', { entities: ['Trips', 'Workouts', 'Zones'] })); // entities only: describing tripsNear's lat/lon params would false-positive
  });

  seen.forEach((r) => scan(r));
  await check('privacy scan', async () => `${seen.length} results`);
  console.log(`mcp-smoke: ${checks} checks passed against ${url}`);
} catch (e) {
  console.error('mcp-smoke FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await client.close();
  process.exit(); // the HANA pool (Tasks 3-4) would keep the process alive; exits with process.exitCode
}
