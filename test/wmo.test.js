'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wmoText } = require('../srv/lib/wmo');

test('wmoText maps the WMO interpretation codes', () => {
  assert.equal(wmoText(0), 'clear sky');
  assert.equal(wmoText(3), 'overcast');
  assert.equal(wmoText(61), 'slight rain');
  assert.equal(wmoText(82), 'violent rain showers');
  assert.equal(wmoText(99), 'thunderstorm with heavy hail');
});

test('wmoText falls back to "code <n>" for unknown codes', () => {
  assert.equal(wmoText(42), 'code 42');
  assert.equal(wmoText(null), 'code null');
});
