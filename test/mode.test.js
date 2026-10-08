'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ingestEnabled, isLoopback, isLocalHost } = require('../srv/lib/mode');

test('ingestEnabled: only production or an explicit GEOTRACK_INGEST=1', () => {
  assert.equal(ingestEnabled({ NODE_ENV: 'production' }), true);
  assert.equal(ingestEnabled({ GEOTRACK_INGEST: '1' }), true);
  assert.equal(ingestEnabled({}), false);
  assert.equal(ingestEnabled({ NODE_ENV: 'development', MQTT_URL: 'wss://broker' }), false);
  assert.equal(ingestEnabled({ GEOTRACK_INGEST: 'true' }), false);
  assert.equal(ingestEnabled({ GEOTRACK_INGEST: '0' }), false);
});

test('isLoopback: IPv4, IPv6 and IPv4-mapped loopback only', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(a), true, a);
  for (const a of ['192.168.1.20', '::ffff:192.168.1.20', 'fe80::1', '10.0.0.1', '', undefined]) assert.equal(isLoopback(a), false, String(a));
});

test('isLocalHost: localhost/127.0.0.1/[::1] Host headers only, case-insensitive, optional port', () => {
  for (const h of ['localhost:4008', 'localhost', 'LOCALHOST:4008', '127.0.0.1:4008', '[::1]:4008']) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ['evil.example:4008', 'localhost.evil.example', '127.0.0.1.nip.io:4008', '192.168.1.20:4008', '', undefined]) {
    assert.equal(isLocalHost(h), false, String(h));
  }
});
