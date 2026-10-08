const { test } = require('node:test');
const assert = require('node:assert/strict');
const { uuidv5, eventKey } = require('../srv/lib/ids');

test('uuidv5 is deterministic, dashed, version 5', () => {
  const a = uuidv5('iphone|zone|enter|2026-09-22T12:00:00.000Z');
  const b = uuidv5('iphone|zone|enter|2026-09-22T12:00:00.000Z');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, uuidv5('other'));
});

test('eventKey joins device, zone, kind and ISO time', () => {
  const k = eventKey({ device: 'iphone', zone_ID: 'z1', kind: 'enter', at: new Date('2026-09-22T12:00:00Z') });
  assert.equal(k, 'iphone|z1|enter|2026-09-22T12:00:00.000Z');
});
