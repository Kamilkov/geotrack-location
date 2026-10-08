'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { parseRange, parseGroupBy, parseKind, parseNear } = require('../agent/lib/args');
const { localDate, localIso, isoWeek, sqlBounds, bucketTotals } = require('../agent/lib/periods');
const { pairStays, summarizeStays } = require('../agent/lib/stays');
const { sql } = require('../agent/lib/sql');

const TZ = 'Europe/Vienna'; // any CET/CEST zone; synthetic data only

test('cds.mcp: autowire off (never writes to ~/.claude.json), cqn format, per-action tools', () => {
  assert.equal(cds.env.mcp.autowire, false);
  assert.equal(cds.env.mcp.format, 'cqn');
  assert.equal(cds.env.mcp.per_action_tool, true);
});

test('parseRange: both or neither, real dates, from <= to', () => {
  assert.deepEqual(parseRange({}), { from: null, to: null });
  assert.deepEqual(parseRange({ from: '', to: null }), { from: null, to: null });
  assert.deepEqual(parseRange({ from: '2026-09-01', to: '2026-09-30' }), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(parseRange({ from: '2026-09-01' }), { error: 'from and to go together' });
  assert.deepEqual(parseRange({ to: '2026-09-01' }), { error: 'from and to go together' });
  assert.deepEqual(parseRange({ from: 'x', to: '2026-09-30' }), { error: 'from must be YYYY-MM-DD' });
  assert.deepEqual(parseRange({ from: '2026-02-30', to: '2026-03-01' }), { error: 'from must be YYYY-MM-DD' });
  assert.deepEqual(parseRange({ from: '2026-09-01', to: '2026-9-3' }), { error: 'to must be YYYY-MM-DD' });
  assert.deepEqual(parseRange({ from: '2026-09-02', to: '2026-09-01' }), { error: 'from must not be after to' });
});

test('parseGroupBy, parseKind: defaults and fixed messages', () => {
  assert.equal(parseGroupBy(undefined), 'month');
  assert.equal(parseGroupBy('week'), 'week');
  assert.deepEqual(parseGroupBy('quarter'), { error: 'groupBy must be day, week, month, year or all' });
  assert.equal(parseKind(null), 'all');
  assert.equal(parseKind('walk'), 'walk');
  assert.deepEqual(parseKind('unknown'), { error: 'kind must be walk, drive or all' });
});

test('parseNear: ranges, default radius', () => {
  assert.deepEqual(parseNear({ lat: 42.5, lon: 1.5 }), { lat: 42.5, lon: 1.5, radiusM: 500 });
  assert.deepEqual(parseNear({ lat: '42.5', lon: '1.5', radiusM: 1000 }), { lat: 42.5, lon: 1.5, radiusM: 1000 });
  assert.deepEqual(parseNear({ lat: 91, lon: 0 }), { error: 'lat must be between -90 and 90' });
  assert.deepEqual(parseNear({ lon: 0 }), { error: 'lat must be between -90 and 90' });
  assert.deepEqual(parseNear({ lat: 0, lon: -181 }), { error: 'lon must be between -180 and 180' });
  assert.deepEqual(parseNear({ lat: 0, lon: 0, radiusM: 0 }), { error: 'radiusM must be 1..50000' });
  assert.deepEqual(parseNear({ lat: 0, lon: 0, radiusM: 50001 }), { error: 'radiusM must be 1..50000' });
  assert.deepEqual(parseNear({ lat: 0, lon: 0, radiusM: 2.5 }), { error: 'radiusM must be 1..50000' });
});

test('localDate and localIso: offset-less HANA strings are UTC; DST end keeps each trip on its own date', () => {
  // 2026-10-25: clocks go back 03:00 CEST → 02:00 CET
  assert.equal(localDate('2026-10-24T22:30:00', TZ), '2026-10-25'); // 00:30 CEST
  assert.equal(localDate('2026-10-25T22:30:00Z', TZ), '2026-10-25'); // 23:30 CET
  assert.equal(localDate('2026-10-25T23:30:00Z', TZ), '2026-10-26'); // 00:30 CET next day
  assert.equal(localIso('2026-09-25T16:17:49.000Z', TZ), '2026-09-25T18:17:49+02:00');
  assert.equal(localIso('2026-12-01T10:00:00', TZ), '2026-12-01T11:00:00+01:00');
  assert.equal(localIso('2026-06-01T10:00:00Z', 'UTC'), '2026-06-01T10:00:00+00:00');
  assert.equal(localIso(null, TZ), null);
});

test('isoWeek: Monday start, the year of the week\'s Thursday', () => {
  assert.equal(isoWeek('2025-12-28'), '2025-W52'); // Sunday
  assert.equal(isoWeek('2025-12-29'), '2026-W01'); // Monday
  assert.equal(isoWeek('2026-09-21'), '2026-W39');
  assert.equal(isoWeek('2026-09-27'), '2026-W39');
  assert.equal(isoWeek('2026-12-31'), '2026-W53');
  assert.equal(isoWeek('2027-01-03'), '2026-W53');
  assert.equal(isoWeek('2027-01-04'), '2027-W01');
});

test('sqlBounds: widened UTC window, or everything', () => {
  assert.deepEqual(sqlBounds({ from: null, to: null }), ['1970-01-01T00:00:00Z', '2100-01-01T00:00:00Z']);
  assert.deepEqual(sqlBounds({ from: '2026-09-01', to: '2026-09-30' }), ['2026-08-31T00:00:00.000Z', '2026-10-02T00:00:00.000Z']);
});

const trips = [
  { startedAt: '2026-09-08T15:00:00', kind: 'walk', lengthM: 3000, durationMin: 60 },
  { startedAt: '2026-09-09T07:00:00', kind: 'drive', lengthM: 12000, durationMin: 20 },
  { startedAt: '2026-09-09T16:00:00', kind: 'drive', lengthM: 8000, durationMin: 15 },
  { startedAt: '2026-09-11T16:00:00', kind: 'walk', lengthM: 4000, durationMin: 50 },
  { startedAt: '2026-09-30T22:30:00', kind: 'unknown', lengthM: 100, durationMin: 5 }, // 00:30 local on 1 October
];

test('bucketTotals: per kind plus an all row per period, sorted', () => {
  const rows = bucketTotals(trips, { range: { from: null, to: null }, groupBy: 'month', kind: 'all', tz: TZ });
  assert.deepEqual(rows, [
    { period: '2026-09', kind: 'walk', trips: 2, distanceM: 7000, durationMin: 110 },
    { period: '2026-09', kind: 'drive', trips: 2, distanceM: 20000, durationMin: 35 },
    { period: '2026-09', kind: 'all', trips: 4, distanceM: 27000, durationMin: 145 },
    { period: '2026-10', kind: 'unknown', trips: 1, distanceM: 100, durationMin: 5 },
    { period: '2026-10', kind: 'all', trips: 1, distanceM: 100, durationMin: 5 },
  ]);
});

test('bucketTotals: kind filter, inclusive local range, day and week grouping, empty', () => {
  const walkDays = bucketTotals(trips, { range: { from: '2026-09-08', to: '2026-09-11' }, groupBy: 'day', kind: 'walk', tz: TZ });
  assert.deepEqual(walkDays.map((r) => [r.period, r.kind, r.trips]), [['2026-09-08', 'walk', 1], ['2026-09-11', 'walk', 1]]);
  const oct = bucketTotals(trips, { range: { from: '2026-10-01', to: '2026-10-01' }, groupBy: 'all', kind: 'all', tz: TZ });
  assert.deepEqual(oct.map((r) => [r.period, r.kind, r.trips]), [['all', 'unknown', 1], ['all', 'all', 1]]);
  const weeks = bucketTotals(trips, { range: { from: null, to: null }, groupBy: 'week', kind: 'drive', tz: TZ });
  assert.deepEqual(weeks.map((r) => [r.period, r.trips, r.distanceM]), [['2026-W37', 2, 20000]]);
  assert.deepEqual(bucketTotals(trips, { range: { from: '2027-01-01', to: '2027-01-31' }, groupBy: 'month', kind: 'all', tz: TZ }), []);
});

test('pairStays: pairs, passthrough, open stay, superseded, stray leave, lost leave', () => {
  const now = new Date('2026-09-25T18:00:00Z');
  const stays = pairStays([
    { kind: 'leave', at: '2026-09-15T07:00:00', visitStatus: null }, // stray: ignored
    { kind: 'enter', at: '2026-09-15T08:10:00', visitStatus: 'passthrough' },
    { kind: 'leave', at: '2026-09-15T08:10:20', visitStatus: 'passthrough' },
    { kind: 'enter', at: '2026-09-15T08:30:00', visitStatus: 'superseded' }, // skipped
    { kind: 'leave', at: '2026-09-15T09:12:00', visitStatus: 'closed' }, // listed before its enter: order comes from `at`
    { kind: 'enter', at: '2026-09-15T09:00:00', visitStatus: 'created' },
    { kind: 'enter', at: '2026-09-16T09:00:00', visitStatus: null }, // lost leave: replaced by the next enter
    { kind: 'enter', at: '2026-09-25T17:00:00', visitStatus: null }, // still inside
  ], now);
  assert.deepEqual(stays.map((s) => [s.arrivedAt.toISOString(), s.leftAt && s.leftAt.toISOString(), s.status, s.durationMin]), [
    ['2026-09-15T08:10:00.000Z', '2026-09-15T08:10:20.000Z', 'passthrough', 0],
    ['2026-09-15T09:00:00.000Z', '2026-09-15T09:12:00.000Z', 'visit', 12],
    ['2026-09-25T17:00:00.000Z', null, 'stay', 60],
  ]);
  assert.deepEqual(pairStays([]), []);
});

test('summarizeStays: counts, totals without passthroughs, local times, range, empty', () => {
  const now = new Date('2026-09-25T18:00:00Z');
  const stays = pairStays([
    { kind: 'enter', at: '2026-09-15T08:10:00', visitStatus: 'passthrough' },
    { kind: 'leave', at: '2026-09-15T08:10:20', visitStatus: 'passthrough' },
    { kind: 'enter', at: '2026-09-15T09:00:00', visitStatus: 'created' },
    { kind: 'leave', at: '2026-09-15T09:12:00', visitStatus: 'closed' },
    { kind: 'enter', at: '2026-09-25T17:00:00', visitStatus: null },
  ], now);
  assert.deepEqual(summarizeStays(stays, { range: { from: null, to: null }, tz: TZ }), {
    visits: 1, passthroughs: 1, stays: 1, totalMin: 72,
    firstArrival: '2026-09-15T11:00:00+02:00', lastArrival: '2026-09-25T19:00:00+02:00', lastDeparture: '2026-09-15T11:12:00+02:00',
    latest: [
      { arrivedAt: '2026-09-25T19:00:00+02:00', leftAt: null, durationMin: 60, status: 'stay' },
      { arrivedAt: '2026-09-15T11:00:00+02:00', leftAt: '2026-09-15T11:12:00+02:00', durationMin: 12, status: 'visit' },
      { arrivedAt: '2026-09-15T10:10:00+02:00', leftAt: '2026-09-15T10:10:20+02:00', durationMin: 0, status: 'passthrough' },
    ],
  });
  const late = summarizeStays(stays, { range: { from: '2026-09-16', to: '2026-09-30' }, tz: TZ });
  assert.deepEqual([late.visits, late.passthroughs, late.stays, late.totalMin, late.latest.length], [0, 0, 1, 60, 1]);
  assert.deepEqual(summarizeStays([], { range: { from: null, to: null }, tz: TZ }), {
    visits: 0, passthroughs: 0, stays: 0, totalMin: 0, firstArrival: null, lastArrival: null, lastDeparture: null, latest: [],
  });
});

test('sql: a database failure becomes the fixed 503, rows pass through', async () => {
  const req = { reject: (code, message) => { throw Object.assign(new Error(message), { code }); } };
  const broken = { run: async () => { throw new Error('connect ECONNREFUSED SELECT * FROM GEOTRACK_TRIPS'); } };
  await assert.rejects(sql(req, 'SELECT 1 FROM DUMMY', [], broken), { code: 503, message: 'Database unavailable (HANA may be stopped)' });
  const ok = { run: async (s, p) => [{ s, p }] };
  assert.deepEqual(await sql(req, 'SELECT ? FROM DUMMY', [1], ok), [{ s: 'SELECT ? FROM DUMMY', p: [1] }]);
});

test('the MCP model carries lengthSource on Trips and on tripDetail', async () => {
  const model = await cds.load(['agent']);
  assert.equal(model.definitions['GeoAgentService.Trips'].elements.lengthSource?.length, 8);
  assert.equal(model.definitions['GeoAgentService.TripDetail'].elements.lengthSource?.length, 8);
});

test('the workouts the MCP tools list leave out smoke and trial devices', async () => {
  const csn = await cds.load(['agent/geo-agent-service.cds']);
  const notLike = (prefix) => [{ ref: ['device'] }, 'not', 'like', { val: `${prefix}%` }];
  assert.deepEqual(csn.definitions['GeoAgentService.Workouts'].query.SELECT.where, [...notLike('smoke'), 'and', ...notLike('trial')]);
});
