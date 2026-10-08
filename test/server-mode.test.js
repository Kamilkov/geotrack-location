'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cds = require('@sap/cds');
const { csrfGuard } = require('../srv/lib/mode');

// Load server.js with its writer modules stubbed, run its bootstrap and served hooks against a
// fake app, and report what it started. The hooks are removed again, so each call starts clean.
function boot(env) {
  const calls = [];
  const stub = (rel, exports) => {
    const file = require.resolve(path.join('..', rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };
  stub('srv/lib/health-ingest', { mount: () => calls.push('health-ingest') });
  stub('srv/lib/photos-ingest', { mount: () => calls.push('photos-ingest') });
  stub('srv/lib/positions-ingest', { mount: () => calls.push('positions-ingest') });
  stub('srv/lib/segment-runner', { startTimer: () => calls.push('runner') });
  stub('srv/lib/mqtt-ingest', { start: () => calls.push('mqtt') });
  const serverFile = require.resolve('../server.js');
  delete require.cache[serverFile];

  const saved = { ...process.env };
  Object.assign(process.env, { MQTT_URL: 'wss://broker.invalid' }, env);
  for (const k of ['NODE_ENV', 'GEOTRACK_INGEST']) if (!(k in env)) delete process.env[k];
  const hooks = { bootstrap: cds.listeners('bootstrap').length, served: cds.listeners('served').length };
  try {
    require(serverFile);
    const middleware = [], mounted = [];
    const app = { use: (a, b) => (b ? mounted.push([a, b]) : middleware.push(a)), get: () => {} };
    const added = (ev) => cds.listeners(ev).slice(hooks[ev]);
    for (const fn of added('bootstrap')) fn(app);
    for (const fn of added('served')) fn();
    for (const ev of ['bootstrap', 'served']) for (const fn of added(ev)) cds.off(ev, fn);
    return { calls, middleware, mounted };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

function status(mw, remoteAddress, host = 'localhost:4008') {
  let code = null, passed = false;
  mw({ socket: { remoteAddress }, headers: { host } }, { sendStatus: (c) => { code = c; } }, () => { passed = true; });
  return passed ? 'next' : code;
}

test('read-only by default: no ingest routes, runner or MQTT, even with MQTT_URL set', () => {
  const { calls, middleware, mounted } = boot({});
  assert.deepEqual(calls, []);
  assert.equal(middleware.length, 1);
  assert.deepEqual(mounted, [['/trips', csrfGuard]]);
  assert.equal(status(middleware[0], '127.0.0.1'), 'next');
  assert.equal(status(middleware[0], '::1'), 'next');
  assert.equal(status(middleware[0], '192.168.1.20'), 403);
  assert.equal(status(middleware[0], '::ffff:192.168.1.20'), 403);
  assert.equal(status(middleware[0], '127.0.0.1', 'evil.example:4008'), 403);
  assert.equal(status(middleware[0], '127.0.0.1', '127.0.0.1:4008'), 'next');
});

test('NODE_ENV=production (the Docker image) starts every writer and adds no guard', () => {
  const { calls, middleware, mounted } = boot({ NODE_ENV: 'production' });
  assert.deepEqual(calls, ['health-ingest', 'photos-ingest', 'positions-ingest', 'runner', 'mqtt']);
  assert.equal(middleware.length, 0);
  assert.deepEqual(mounted, [['/trips', csrfGuard]], 'the CSRF guard runs on the VPS too');
});

test('GEOTRACK_INGEST=1 (npm run watch) starts every writer', () => {
  const { calls } = boot({ GEOTRACK_INGEST: '1' });
  assert.deepEqual(calls, ['health-ingest', 'photos-ingest', 'positions-ingest', 'runner', 'mqtt']);
});
