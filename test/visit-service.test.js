'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeHandlers } = require('../srv/visit-service');
const { uuidv5 } = require('../srv/lib/ids');

// Shape of an HTTP error from CAP's remote client (verified live against A4H):
// a plain Error with statusCode 502; the real HTTP status sits in reason.response.status.
const httpError = (status, message) =>
  Object.assign(new Error(`Error during request to remote service: ${message}`), { statusCode: 502, reason: { message, response: { status } } });

// db fake: SELECTs (the handler's status read) answer `status` rows; everything else is an UPDATE.
function fakes(status = [{ VISITSTATUS: 'pending' }]) {
  const calls = [], updates = [], selects = [];
  const a4h = { send: async (req) => { calls.push(req); if (req.path?.includes('/SAP__self.close')) return {}; return { VisitUUID: 'x' }; } };
  const db = { run: async (sql, params) => { if (/^\s*SELECT/i.test(sql)) { selects.push([sql, params]); return status; } updates.push([sql, params]); return 1; } };
  return { a4h, db, calls, updates, selects };
}
const enter = { eventKey: 'iphone|z1|enter|2026-09-22T12:00:00.000Z', device: 'iphone', zone_ID: 'z1', zoneName: 'Shop', at: new Date('2026-09-22T12:00:00Z') };
const leave = { eventKey: 'iphone|z1|leave|2026-09-22T12:30:00.000Z', enterEventKey: enter.eventKey, device: 'iphone', zone_ID: 'z1', zoneName: 'Shop', at: new Date('2026-09-22T12:30:00Z') };

test('createVisit posts with a deterministic VisitUUID and marks the event created', async () => {
  const f = fakes(); const h = makeHandlers(f);
  await h.createVisit({ data: enter });
  assert.equal(f.calls[0].method, 'POST'); assert.equal(f.calls[0].path, '/SiteVisit');
  assert.equal(f.calls[0].data.VisitUUID, uuidv5(enter.eventKey));
  assert.equal(f.calls[0].data.ArrivedAt, '2026-09-22T12:00:00.000Z');
  assert.equal(f.calls[0].data.ExtEventKey, enter.eventKey);
  assert.ok(f.updates.some(([sql, p]) => /VISITSTATUS = 'created'/.test(sql) && p.includes(uuidv5(enter.eventKey))));
});

test('createVisit treats "already exists" as success (409, and A4H\'s real 400 "key value is already in use")', async () => {
  for (const err of [httpError(409, 'exists'), httpError(400, 'The key value is already in use. Please enter a different one.')]) {
    const f = fakes(); f.a4h.send = async () => { throw err; };
    const h = makeHandlers(f);
    await h.createVisit({ data: enter });
    assert.ok(f.updates.some(([sql]) => /VISITSTATUS = 'created'/.test(sql)));
  }
});

test('createVisit accepts the queue\'s JSON round trip (at as an ISO string)', async () => {
  const f = fakes(); const h = makeHandlers(f);
  await h.createVisit({ data: JSON.parse(JSON.stringify(enter)) });
  assert.equal(f.calls[0].data.ArrivedAt, '2026-09-22T12:00:00.000Z');
});

test('closeVisit calls the bound action on the enter event visit and marks closed', async () => {
  const f = fakes(); const h = makeHandlers(f);
  await h.closeVisit({ data: leave });
  const close = f.calls.find((c) => /SAP__self\.close/.test(c.path));
  assert.ok(close); assert.match(close.path, new RegExp(uuidv5(enter.eventKey)));
  assert.equal(close.data.DepartedAt, '2026-09-22T12:30:00.000Z');
  assert.ok(f.updates.some(([sql]) => /VISITSTATUS = 'closed'/.test(sql)));
});

test('closeVisit treats 422 "Operation is not enabled" (visit already closed) as closed', async () => {
  const f = fakes(); f.a4h.send = async () => { throw httpError(422, 'Operation is not enabled'); };
  const h = makeHandlers(f);
  await h.closeVisit({ data: leave });
  assert.ok(f.updates.some(([sql]) => /VISITSTATUS = 'closed'/.test(sql)));
  assert.ok(!f.updates.some(([sql]) => /ATTEMPTS = ATTEMPTS \+ 1/.test(sql)));
});

test('closeVisit creates the visit first when it does not exist (404)', async () => {
  const f = fakes(); let n = 0;
  f.a4h.send = async (req) => { n++; if (n === 1) throw httpError(404, 'Unspecified provider error occurred.'); f.calls.push(req); return {}; };
  const h = makeHandlers(f);
  await h.closeVisit({ data: leave });
  assert.deepEqual(f.calls.map((c) => c.method + ' ' + c.path.replace(/\(.*\)/, '(id)')), ['POST /SiteVisit', 'POST /SiteVisit(id)/SAP__self.close']);
  const create = f.calls[0].data;
  assert.equal(create.VisitUUID, uuidv5(enter.eventKey));
  assert.equal(create.ArrivedAt, '2026-09-22T12:00:00.000Z', 'arrival comes from the enter event key');
  assert.equal(create.ZoneName, 'Shop');
  assert.equal(create.ExtEventKey, enter.eventKey);
  assert.ok(f.updates.some(([sql]) => /VISITSTATUS = 'closed'/.test(sql)));
});

test('other errors increment attempts, store lastError and rethrow so the queue retries', async () => {
  const f = fakes(); f.a4h.send = async () => { throw new Error('ECONNREFUSED'); };
  const h = makeHandlers(f);
  await assert.rejects(() => h.createVisit({ data: enter }), /ECONNREFUSED/);
  const [sql, p] = f.updates.find(([s]) => /ATTEMPTS = ATTEMPTS \+ 1/.test(s)) ?? [];
  assert.ok(sql && /LASTERROR/.test(sql));
  assert.match(p[0], /ECONNREFUSED/);
  assert.deepEqual(p.slice(-4), ['iphone', 'z1', 'enter', '2026-09-22T12:00:00.000Z'], 'the enter event row is the one updated');
});

test('lastError keeps the root cause CAP puts in reason (fetch failed → ECONNREFUSED)', async () => {
  const f = fakes();
  f.a4h.send = async () => { throw Object.assign(new Error('Error during request to remote service: fetch failed'), { statusCode: 502, reason: { message: 'Error during request to remote service: fetch failed Caused by: connect ECONNREFUSED 127.0.0.1:59999' } }); };
  const h = makeHandlers(f);
  await assert.rejects(() => h.closeVisit({ data: leave }));
  const [, p] = f.updates.find(([s]) => /ATTEMPTS = ATTEMPTS \+ 1/.test(s));
  assert.match(p[0], /ECONNREFUSED/);
  assert.equal(p.at(-2), 'leave', 'the leave event row is the one updated');
});

test('status updates never overwrite a superseded event', async () => {
  const f = fakes(); const h = makeHandlers(f);
  await h.createVisit({ data: enter });
  const g = fakes(); g.a4h.send = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => makeHandlers(g).createVisit({ data: enter }));
  for (const [sql] of [...f.updates, ...g.updates]) assert.match(sql, /AND COALESCE\(VISITSTATUS, ''\) NOT IN \('superseded', 'passthrough'\)/);
});

test('the failed threshold is the configured queue maxAttempts', async () => {
  const cds = require('@sap/cds');
  const f = fakes(); f.a4h.send = async () => { throw new Error('boom'); };
  await assert.rejects(() => makeHandlers(f).createVisit({ data: enter }));
  const [, p] = f.updates.find(([s]) => /ATTEMPTS = ATTEMPTS \+ 1/.test(s));
  assert.equal(p[1], cds.env.requires.queue.maxAttempts);
  assert.equal(p[1], 50);
});

test('a 400 that is not a duplicate (validation error) is rethrown and counted', async () => {
  const f = fakes(); f.a4h.send = async () => { throw httpError(400, 'Field ZoneName is mandatory'); };
  await assert.rejects(() => makeHandlers(f).createVisit({ data: enter }), /mandatory/);
  assert.ok(f.updates.some(([sql]) => /ATTEMPTS = ATTEMPTS \+ 1/.test(sql)));
  assert.ok(!f.updates.some(([sql]) => /VISITSTATUS = 'created'/.test(sql)));
});

test('close → 404 → create answers 400 "already in use" (raced by createVisit) → close still succeeds', async () => {
  const f = fakes(); const seen = [];
  let closes = 0;
  f.a4h.send = async (req) => {
    seen.push(req.method + ' ' + req.path.replace(/\(.*\)/, '(id)'));
    if (req.path.includes('SAP__self.close') && closes++ === 0) throw httpError(404, 'Unspecified provider error occurred.');
    if (req.path === '/SiteVisit') throw httpError(400, 'The key value is already in use. Please enter a different one.');
    return {};
  };
  await makeHandlers(f).closeVisit({ data: leave });
  assert.deepEqual(seen, ['POST /SiteVisit(id)/SAP__self.close', 'POST /SiteVisit', 'POST /SiteVisit(id)/SAP__self.close']);
  assert.ok(f.updates.some(([sql]) => /VISITSTATUS = 'closed'/.test(sql)));
});

test('a superseded, passed-through or deleted event is skipped: no A4H call, no status write', async () => {
  for (const rows of [[{ VISITSTATUS: 'superseded' }], [{ VISITSTATUS: 'passthrough' }], []]) {
    const f = fakes(rows); const h = makeHandlers(f);
    await h.createVisit({ data: enter });
    await h.closeVisit({ data: leave });
    assert.equal(f.calls.length, 0, 'no A4H call');
    assert.equal(f.updates.length, 0, 'no status write');
    assert.deepEqual(f.selects.map(([, p]) => p), [
      ['iphone', 'z1', 'enter', '2026-09-22T12:00:00.000Z'],
      ['iphone', 'z1', 'leave', '2026-09-22T12:30:00.000Z'],
    ], 'each handler reads its own event row');
  }
});
