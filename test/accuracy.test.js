'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { accuracyLimits, accepted, ACCEPTED_SQL, acceptedParams } = require('../srv/lib/accuracy');

const A = { maxAccuracyM: 50, maxAccuracyOutsideM: 35 };

test('accuracyLimits: the limit inside a zone and the stricter one outside', () => {
  assert.deepEqual(accuracyLimits(A), { inside: 50, outside: 35, vertical: 0 });
});

test('accuracyLimits: maxAccuracyOutsideM 0 or absent means one limit everywhere', () => {
  assert.deepEqual(accuracyLimits({ maxAccuracyM: 50, maxAccuracyOutsideM: 0 }), { inside: 50, outside: 50, vertical: 0 });
  assert.deepEqual(accuracyLimits({ maxAccuracyM: 50 }), { inside: 50, outside: 50, vertical: 0 });
});

test('accuracyLimits: a limit outside larger than the one inside is taken as it is', () => {
  assert.deepEqual(accuracyLimits({ maxAccuracyM: 50, maxAccuracyOutsideM: 60 }), { inside: 50, outside: 60, vertical: 0 });
});

test('accepted: exactly the limit counts, one metre worse does not, by where the position lies', () => {
  const l = accuracyLimits(A);
  assert.equal(accepted({ accuracy: 35, zone_ID: null }, l), true);
  assert.equal(accepted({ accuracy: 36, zone_ID: null }, l), false);
  assert.equal(accepted({ accuracy: 36 }, l), false, 'zone_ID missing is outside every zone');
  assert.equal(accepted({ accuracy: 50, zone_ID: 'shop' }, l), true);
  assert.equal(accepted({ accuracy: 51, zone_ID: 'shop' }, l), false);
});

test('accepted: a position without an accuracy value counts everywhere', () => {
  const l = accuracyLimits(A);
  assert.equal(accepted({ accuracy: null, zone_ID: null }, l), true);
  assert.equal(accepted({ zone_ID: 'shop' }, l), true);
});

test('the SQL condition takes the limit outside first, then the limit inside', () => {
  assert.match(ACCEPTED_SQL, /^\(\(ACCURACY IS NULL OR \(ZONE_ID IS NULL AND ACCURACY <= \?\) OR \(ZONE_ID IS NOT NULL AND ACCURACY <= \?\)\) AND /);
  assert.deepEqual(acceptedParams(A).slice(0, 2), [35, 50]);
  assert.deepEqual(acceptedParams({ maxAccuracyM: 50 }).slice(0, 2), [50, 50]);
});

// ---------------------------------------------------------------- vertical accuracy outside zones (2026-10-06)
// At night an offline phone reports junk fixes: motorway speeds on a bedside table, with a vertical accuracy of
// 100 to 300 m where a real fix has 30 m or better. Outside every zone such a fix does not count.
const V = { maxAccuracyM: 50, maxAccuracyOutsideM: 35, maxVerticalAccuracyOutsideM: 100 };

test('accuracyLimits: the vertical limit outside zones, 0 or absent switches it off', () => {
  assert.equal(accuracyLimits(V).vertical, 100);
  assert.equal(accuracyLimits(A).vertical, 0);
  assert.equal(accuracyLimits({ ...V, maxVerticalAccuracyOutsideM: 0 }).vertical, 0);
});

test('accepted: outside zones a vertical accuracy of exactly the limit counts, one metre worse does not', () => {
  const l = accuracyLimits(V);
  assert.equal(accepted({ accuracy: 34, verticalAccuracy: 100, zone_ID: null }, l), true);
  assert.equal(accepted({ accuracy: 34, verticalAccuracy: 101, zone_ID: null }, l), false);
  assert.equal(accepted({ accuracy: null, verticalAccuracy: 147, zone_ID: null }, l), false, 'no horizontal value does not excuse the vertical one');
  assert.equal(accepted({ accuracy: 34, verticalAccuracy: null, zone_ID: null }, l), true, 'a position without a vertical value counts');
});

test('accepted: inside a zone the vertical accuracy is not looked at, and with the rule off neither outside', () => {
  assert.equal(accepted({ accuracy: 34, verticalAccuracy: 300, zone_ID: 'home' }, accuracyLimits(V)), true);
  assert.equal(accepted({ accuracy: 34, verticalAccuracy: 300, zone_ID: null }, accuracyLimits(A)), true);
});

test('the SQL condition takes the vertical limit third and leaves it out of effect when the rule is off', () => {
  assert.match(ACCEPTED_SQL, /AND \(ZONE_ID IS NOT NULL OR VERTICALACCURACY IS NULL OR VERTICALACCURACY <= \?\)\)$/);
  assert.deepEqual(acceptedParams(V), [35, 50, 100]);
  assert.deepEqual(acceptedParams(A), [35, 50, 2147483647]);
});
