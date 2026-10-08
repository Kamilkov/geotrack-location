'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A server that listens on every address can share its port number with another program on the same machine
// that listens on 127.0.0.1 alone. A request to 127.0.0.1 then reaches that program, not the server: seen as an
// answer "Invalid CSRF token" from a stranger, as "other side closed", and as EPIPE on a large upload.
// A server bound to 127.0.0.1 gets a port no one else has on that address.
test('a server started on a port of the system\'s choice is bound to 127.0.0.1, where its client connects', () => {
  const root = path.join(__dirname, '..');
  const open = ['test', 'scripts'].flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((f) => /\.m?js$/.test(f)).flatMap((f) =>
    fs.readFileSync(path.join(root, dir, f), 'utf8').split('\n')
      .map((line, i) => (/\.listen\(\s*0\s*[,)]/.test(line) && !/\.listen\(\s*0\s*,\s*'127\.0\.0\.1'/.test(line) ? `${dir}/${f}:${i + 1}` : null))
      .filter(Boolean)));
  assert.deepEqual(open, []);
});
