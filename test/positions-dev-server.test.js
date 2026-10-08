'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

// The dev server also runs on the VPS as the App Store reviewer's demo server: there its token, its address
// and the size of its memory come from the environment, and the oldest positions make room for new ones.
const TOKEN = 'review-token-not-a-secret';
let child, base;

/** Starts the server with the environment given and resolves with its base URL once it says where it listens. */
function start(env) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'positions-dev-server.js')], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the server did not start: ${out}`)), 10000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /POST (http:\/\/[^/]+)\/positions/.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the server exited with ${code}: ${out}`)); });
  });
}

const position = (tst) => ({ _type: 'location', tst, lat: 42.53, lon: 1.54, acc: 5 });
const post = (token, positions) => fetch(`${base}/positions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ device: 'review', positions }),
});

after(() => child?.kill());

test('with DEV_SERVER_TOKEN, HOST, PORT and MAX_STORED set, the dev server answers to that token, on that port, and forgets the oldest positions', async () => {
  base = await start({ DEV_SERVER_TOKEN: TOKEN, HOST: '127.0.0.1', PORT: '0', MAX_STORED: '2' });
  assert.notEqual(new URL(base).port, '4010', 'PORT=0 takes a free port, not the default');

  const wrong = await post('dev-token', [position(1_790_000_000)]);
  assert.equal(wrong.status, 401, 'the built-in token no longer works once one is configured');

  const three = await post(TOKEN, [position(1_790_000_000), position(1_790_000_060), position(1_790_000_120)]);
  assert.equal(three.status, 200);
  assert.deepEqual(await three.json(), { stored: 3, duplicates: 0, skipped: [], home: { lat: 42.5, lon: 1.5, radiusM: 100 } }, 'the synthetic private zone is the base zone the Simulator sleeps in');

  // Two are kept: the first went when the third came, the third is still known.
  const again = await post(TOKEN, [position(1_790_000_000), position(1_790_000_120)]);
  assert.deepEqual(await again.json(), { stored: 1, duplicates: 1, skipped: [], home: { lat: 42.5, lon: 1.5, radiusM: 100 } });
});
