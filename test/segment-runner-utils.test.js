'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { utcDate, resegment, schedule, isTrial, startTimer, LIVE_DEVICES } = require('../srv/lib/segment-runner');

test('utcDate: null/undefined pass through as null', () => {
  assert.equal(utcDate(null), null);
  assert.equal(utcDate(undefined), null);
});

test('utcDate: an existing Date instance is returned unchanged', () => {
  const d = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(utcDate(d), d);
});

test('utcDate: a Z-suffixed ISO string parses as UTC', () => {
  assert.equal(utcDate('2026-09-20T08:25:00.000Z').toISOString(), '2026-09-20T08:25:00.000Z');
});

test('utcDate: a string with an explicit numeric offset is parsed as-is', () => {
  assert.equal(utcDate('2026-09-20T10:25:00+02:00').toISOString(), '2026-09-20T08:25:00.000Z');
});

test('utcDate: a bare HANA timestamp string (no offset) is treated as UTC, not local time', () => {
  // This is the regression case: HANA's native-SQL driver returns TIMESTAMP columns as
  // offset-less strings, and `new Date(...)` on those would otherwise parse as local time.
  assert.equal(utcDate('2026-09-20T08:25:00').toISOString(), '2026-09-20T08:25:00.000Z');
  assert.equal(utcDate('2026-09-20T08:25:00.123').toISOString(), '2026-09-20T08:25:00.123Z');
});

test('resegment rejects a missing or invalid fromTS (or device) with status 400, before touching the DB', async () => {
  for (const [device, fromTS] of [['iphone', null], ['iphone', undefined], ['iphone', 'yesterday'], [null, '2026-09-20T08:25:00Z']]) {
    await assert.rejects(resegment(device, fromTS), (e) => e.status === 400, `${device} ${fromTS}`);
  }
});

test('a trial device is never segmented: not scheduled, not swept, not resegmented', async () => {
  assert.equal(isTrial('trial-iphone'), true);
  assert.equal(isTrial('iphone'), false);
  assert.equal(isTrial(null), false);
  assert.equal(schedule('trial-iphone', new Date()), false);
  assert.match(LIVE_DEVICES, /DEVICE NOT LIKE 'smoke%'/);
  assert.match(LIVE_DEVICES, /DEVICE NOT LIKE 'trial%'/);
  await assert.rejects(resegment('trial-iphone', '2026-09-20T08:25:00Z'), (e) => e.status === 400 && /trial/.test(e.message));
});

test('a smoke fixture that arrives is not scheduled: its own script segments it, never the server', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // were it scheduled, no real timer is left behind
  assert.equal(schedule('smoke6', new Date()), false);
  assert.equal(schedule('smoke', null), false);
});

test('the 5-minute sweep asks for live devices only: the SQL the start timer runs leaves out smoke and trial devices', async () => {
  const sqls = [], { spawn, db } = cds;
  let sweep;
  cds.spawn = (opts, fn) => { sweep = fn; };
  cds.db = { run: async (sql) => { sqls.push(sql); return []; } };
  try { startTimer(); await sweep(); } finally { cds.spawn = spawn; cds.db = db; }
  assert.match(sqls[0], /DEVICE NOT LIKE 'smoke%'/);
  assert.match(sqls[0], /DEVICE NOT LIKE 'trial%'/);
});

test('a live device is scheduled: true, and its segmentation starts when the 10 s debounce is over', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // no real timer is left to hold the process
  const calls = [], { db } = cds;
  cds.db = { run: async (sql, params) => { calls.push([sql, params]); return /FROM GEOTRACK_SETTINGS/.test(sql) ? [{}] : []; } };
  const settle = () => new Promise((r) => setImmediate(r)); // the fake answers at once: a run is over after one turn
  try {
    assert.equal(schedule('iphone', new Date()), true);
    t.mock.timers.tick(9999);
    await settle();
    assert.deepEqual(calls, []);
    t.mock.timers.tick(1);
    await settle();
  } finally { cds.db = db; }
  assert.ok(calls.some(([sql, params]) => /FROM GEOTRACK_POSITIONS WHERE DEVICE = \?/.test(sql) && params[0] === 'iphone'), JSON.stringify(calls));
});
