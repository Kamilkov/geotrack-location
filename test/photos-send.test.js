'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
const { sendAll } = require('../scripts/photos-send');

// Needs macOS sips and exiftool (Homebrew); skipped elsewhere.
const skip = ['sips', 'exiftool'].every((t) => spawnSync('which', [t]).status === 0) ? false : 'needs sips and exiftool (macOS)';
const FIXTURE = path.join(__dirname, 'fixtures/photo-synthetic.jpg'); // Apple / iPhone 16 Pro, 2026-09-22 17:50:12.345+02:00, GPS 42.5003/1.5002
const exiftool = (file, ...args) => execFileSync('exiftool', ['-q', '-overwrite_original', ...args, file]);

function setup(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photos-send-test-'));
  const inbox = path.join(dir, 'inbox'), outDir = path.join(dir, 'out');
  fs.mkdirSync(inbox);
  for (const [name, tags] of Object.entries(files)) {
    const f = path.join(inbox, name);
    if (tags === 'text') { fs.writeFileSync(f, 'not an image'); continue; }
    fs.copyFileSync(FIXTURE, f);
    if (tags.length) exiftool(f, ...tags);
    fs.utimesSync(f, new Date(Date.now() - 60000), new Date(Date.now() - 60000)); // settled
  }
  return { dir, inbox, outDir };
}
/** Fake /photos: answers per file name from `answers` ({ status, body }); records every request. */
async function fakeServer(answers) {
  const got = [];
  const server = http.createServer((req, res) => {
    let s = '';
    req.on('data', (d) => { s += d; }).on('end', () => {
      const body = JSON.parse(s);
      got.push({ auth: req.headers.authorization, body });
      const a = answers[body.fileName] ?? { status: 200, body: { status: 'stored', positionSource: 'photo' } };
      res.writeHead(a.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(a.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/photos`, got, close: () => server.close() };
}
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);

test('stored → sent/, dropped → dropped/, 400 and unreadable time → failed/, 503 stays; other files untouched', { skip }, async () => {
  const { dir, inbox, outDir } = setup({
    'IMG_0001.JPG': [], 'IMG_0002.JPG': ['-SubSecTimeOriginal=346'], 'IMG_0003.JPG': ['-SubSecTimeOriginal=347'],
    'IMG_0004.JPG': ['-SubSecTimeOriginal=348'], 'IMG_0005.JPG': ['-OffsetTimeOriginal=', '-OffsetTime='],
    'CANON.JPG': ['-Make=Canon', '-Model=EOS R6'], 'notes.txt': 'text',
  });
  fs.mkdirSync(path.join(outDir, 'sent'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'sent', 'IMG_0001.JPG'), 'an earlier file with the same name');
  const srv = await fakeServer({
    'IMG_0001.JPG': { status: 200, body: { id: '3f9a12c4-0000-5000-8000-000000000001', status: 'stored', reason: null, positionSource: 'photo' } },
    'IMG_0002.JPG': { status: 200, body: { id: '3f9a12c4-0000-5000-8000-000000000002', status: 'dropped', reason: 'private zone', positionSource: null } },
    'IMG_0003.JPG': { status: 503, body: { error: 'database unavailable' } },
    'IMG_0004.JPG': { status: 400, body: { error: 'thumbnail: not a JPEG' } },
  });
  const lines = [];
  try {
    const counts = await sendAll({ inbox, outDir, url: srv.url, token: 'tok', settleMs: 0, log: (m) => lines.push(m) });
    assert.deepEqual(counts, { stored: 1, dropped: 1, failed: 2, retry: 1 });
    assert.deepEqual(ls(inbox), ['CANON.JPG', 'IMG_0003.JPG', 'notes.txt']);
    assert.deepEqual(ls(path.join(outDir, 'sent')), ['IMG_0001-1.JPG', 'IMG_0001.JPG']); // no overwrite
    assert.equal(fs.readFileSync(path.join(outDir, 'sent', 'IMG_0001.JPG'), 'utf8'), 'an earlier file with the same name');
    assert.deepEqual(ls(path.join(outDir, 'dropped')), ['IMG_0002.JPG']);
    assert.deepEqual(ls(path.join(outDir, 'failed')), ['IMG_0004.JPG', 'IMG_0005.JPG']);
    assert.deepEqual(srv.got.map((g) => g.body.fileName).sort(), ['IMG_0001.JPG', 'IMG_0002.JPG', 'IMG_0003.JPG', 'IMG_0004.JPG']); // not CANON, not IMG_0005
    const one = srv.got.find((g) => g.body.fileName === 'IMG_0001.JPG');
    assert.equal(one.auth, 'Bearer tok');
    const { thumbnail, ...meta } = one.body;
    assert.deepEqual(meta, { fileName: 'IMG_0001.JPG', cameraModel: 'iPhone 16 Pro', takenAt: '2026-09-22T17:50:12.345+02:00', lat: 42.5003, lon: 1.5002, altitudeM: 1001.5, accuracyM: 4.5, directionDeg: 123 });
    const jpeg = Buffer.from(thumbnail, 'base64');
    assert.deepEqual([jpeg[0], jpeg[1]], [0xff, 0xd8]);
    assert.ok(!jpeg.includes(Buffer.from('Exif')) && !jpeg.includes(Buffer.from('iPhone 16 Pro')), 'the thumbnail sent carries no metadata');
    // The ID the server returned: the owner's app shows the same one for the same photo.
    assert.ok(lines.includes('IMG_0001.JPG stored via photo id 3f9a12c4-0000-5000-8000-000000000001'), lines.join('\n'));
    assert.ok(lines.includes('IMG_0002.JPG dropped (private zone) id 3f9a12c4-0000-5000-8000-000000000002'), lines.join('\n'));
    assert.ok(lines.some((l) => /^IMG_0005\.JPG failed: no time with UTC offset$/.test(l)), lines.join('\n'));
    assert.ok(!lines.join('\n').includes('42.5003'), 'no coordinates in the log');
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file still being written is waited for; one that never settles is left for the next run', { skip }, async () => {
  const { dir, inbox, outDir } = setup({});
  const srv = await fakeServer({});
  try {
    const fresh = path.join(inbox, 'IMG_0010.JPG');
    fs.copyFileSync(FIXTURE, fresh); // mtime now
    const lines = [];
    let counts = await sendAll({ inbox, outDir, url: srv.url, token: 'tok', settleMs: 300, pollMs: 50, waitMs: 5000, log: (m) => lines.push(m) });
    assert.deepEqual(counts, { stored: 1, dropped: 0, failed: 0, retry: 0 });
    assert.deepEqual(ls(path.join(outDir, 'sent')), ['IMG_0010.JPG']);

    fs.copyFileSync(FIXTURE, path.join(inbox, 'IMG_0011.JPG'));
    counts = await sendAll({ inbox, outDir, url: srv.url, token: 'tok', settleMs: 60000, pollMs: 50, waitMs: 200, log: (m) => lines.push(m) });
    assert.deepEqual(counts, { stored: 0, dropped: 0, failed: 0, retry: 0 });
    assert.deepEqual(ls(inbox), ['IMG_0011.JPG']);
    assert.ok(lines.includes('1 file(s) still being written, left for the next run'), lines.join('\n'));
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file with a backdated mtime but a fresh change time is waited for', { skip }, async () => {
  const { dir, inbox, outDir } = setup({});
  const srv = await fakeServer({});
  try {
    const f = path.join(inbox, 'IMG_0012.JPG');
    fs.copyFileSync(FIXTURE, f); // mtime now
    const old = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    fs.utimesSync(f, old, old); // mtime backdated a year, like AirDrop; ctime stays "now" — utimes can't backdate it
    const sleepCalls = [];
    const sleep = async (ms) => { sleepCalls.push(ms); await new Promise((r) => setTimeout(r, ms)); };
    const counts = await sendAll({ inbox, outDir, url: srv.url, token: 'tok', settleMs: 300, pollMs: 50, waitMs: 5000, sleep, log: () => {} });
    assert.deepEqual(counts, { stored: 1, dropped: 0, failed: 0, retry: 0 });
    assert.deepEqual(ls(path.join(outDir, 'sent')), ['IMG_0012.JPG']);
    assert.ok(sleepCalls.length >= 1, 'settled by ctime only after actually waiting');
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a truncated iPhone photo waits for the next run', { skip }, async (t) => {
  const { dir, inbox, outDir } = setup({});
  const srv = await fakeServer({});
  try {
    const heic = path.join(inbox, 'IMG_0013.HEIC');
    try {
      execFileSync('sips', ['-s', 'format', 'heic', FIXTURE, '--out', heic]);
    } catch {
      t.skip('sips cannot produce HEIC on this machine');
      return;
    }
    const size = fs.statSync(heic).size;
    fs.truncateSync(heic, Math.floor(size * 0.95)); // cuts into the HEIC 'mdat' box on this fixture
    const lines = [];
    const counts = await sendAll({ inbox, outDir, url: srv.url, token: 'tok', settleMs: 0, log: (m) => lines.push(m) });
    assert.deepEqual(counts, { stored: 0, dropped: 0, failed: 0, retry: 1 });
    assert.deepEqual(ls(inbox), ['IMG_0013.HEIC']);
    assert.equal(srv.got.length, 0, 'nothing posted');
    assert.ok(lines.some((l) => /waiting: .*truncat/i.test(l)), lines.join('\n'));
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a portrait EXIF orientation produces an upright thumbnail; orientation 1 stays landscape', { skip }, async () => {
  const { dir, inbox, outDir } = setup({ 'IMG_0040.JPG': ['-Orientation#=6'], 'IMG_0041.JPG': ['-Orientation#=1'] });
  const srv = await fakeServer({});
  const dims = (jpegBuf) => {
    const f = path.join(dir, `dim-${Math.random().toString(36).slice(2)}.jpg`);
    fs.writeFileSync(f, jpegBuf);
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', f]).toString();
    fs.rmSync(f);
    return { w: Number(/pixelWidth: (\d+)/.exec(out)[1]), h: Number(/pixelHeight: (\d+)/.exec(out)[1]) };
  };
  try {
    await sendAll({ inbox, outDir, url: srv.url, token: 'tok', settleMs: 0, log: () => {} });
    const portrait = dims(Buffer.from(srv.got.find((g) => g.body.fileName === 'IMG_0040.JPG').body.thumbnail, 'base64'));
    const landscape = dims(Buffer.from(srv.got.find((g) => g.body.fileName === 'IMG_0041.JPG').body.thumbnail, 'base64'));
    assert.ok(portrait.h > portrait.w, `orientation 6 thumbnail should be portrait, got ${portrait.w}x${portrait.h}`);
    assert.ok(landscape.w > landscape.h, `orientation 1 thumbnail should stay landscape, got ${landscape.w}x${landscape.h}`);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a ProRAW .DNG is picked up like a HEIC/JPEG; a .PNG is not', { skip }, async () => {
  // exiftool and sips detect the format from the content, so the JPEG fixture under a .DNG name exercises the name filter
  const { dir, inbox, outDir } = setup({ 'IMG_0070.DNG': [], 'IMG_0071.PNG': [] });
  const srv = await fakeServer({});
  try {
    const counts = await sendAll({ inbox, outDir, url: srv.url, token: 'tok', settleMs: 0, log: () => {} });
    assert.deepEqual(counts, { stored: 1, dropped: 0, failed: 0, retry: 0 });
    assert.deepEqual(srv.got.map((g) => g.body.fileName), ['IMG_0070.DNG']);
    assert.deepEqual(ls(path.join(outDir, 'sent')), ['IMG_0070.DNG']);
    assert.deepEqual(ls(inbox), ['IMG_0071.PNG']);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a below-sea-level altitude is posted negative, not double-negated', { skip }, async () => {
  const { dir, inbox, outDir } = setup({ 'IMG_0050.JPG': ['-GPSAltitude=12.5', '-GPSAltitudeRef#=1'] });
  const srv = await fakeServer({});
  try {
    await sendAll({ inbox, outDir, url: srv.url, token: 'tok', settleMs: 0, log: () => {} });
    assert.equal(srv.got.find((g) => g.body.fileName === 'IMG_0050.JPG').body.altitudeM, -12.5);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server unreachable → retry, the file stays', { skip }, async () => {
  const { dir, inbox, outDir } = setup({ 'IMG_0020.JPG': [] });
  try {
    const counts = await sendAll({ inbox, outDir, url: 'http://127.0.0.1:9/photos', token: 'tok', settleMs: 0, log: () => {} });
    assert.deepEqual(counts, { stored: 0, dropped: 0, failed: 0, retry: 1 });
    assert.deepEqual(ls(inbox), ['IMG_0020.JPG']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an entry that cannot be stat\'ed or read does not stop the run', { skip }, async () => {
  const { dir, inbox, outDir } = setup({ 'IMG_0030.JPG': [] });
  fs.writeFileSync(path.join(inbox, 'ZERO.JPG'), '');
  fs.utimesSync(path.join(inbox, 'ZERO.JPG'), new Date(Date.now() - 60000), new Date(Date.now() - 60000)); // settled
  fs.symlinkSync('/nonexistent', path.join(inbox, 'BROKEN.JPG'));
  const srv = await fakeServer({});
  const lines = [];
  try {
    const counts = await sendAll({ inbox, outDir, url: srv.url, token: 'tok', settleMs: 0, log: (m) => lines.push(m) });
    assert.deepEqual(counts, { stored: 1, dropped: 0, failed: 0, retry: 0 });
    assert.deepEqual(ls(path.join(outDir, 'sent')), ['IMG_0030.JPG']);
    assert.deepEqual(ls(inbox), ['BROKEN.JPG', 'ZERO.JPG']);
    assert.ok(fs.lstatSync(path.join(inbox, 'BROKEN.JPG')).isSymbolicLink(), 'BROKEN.JPG is still a symlink');
    assert.ok(lines.some((l) => /^ZERO\.JPG skipped: /.test(l)), lines.join('\n'));
    assert.ok(lines.includes('IMG_0030.JPG stored via photo'), 'an answer without an ID leaves the line as it was'); // a server from before
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a move that fails (e.g. a read-only target) counts as retry without aborting the run', { skip }, async () => {
  const { dir, inbox, outDir } = setup({ 'IMG_0060.JPG': [], 'IMG_0061.JPG': [] });
  const sentDir = path.join(outDir, 'sent');
  fs.mkdirSync(sentDir, { recursive: true });
  fs.chmodSync(sentDir, 0o555); // no write: any move into sent/ fails
  const srv = await fakeServer({ 'IMG_0061.JPG': { status: 200, body: { status: 'dropped', reason: 'private zone' } } });
  const lines = [];
  try {
    const counts = await sendAll({ inbox, outDir, url: srv.url, token: 'tok', settleMs: 0, log: (m) => lines.push(m) });
    assert.deepEqual(counts, { stored: 0, dropped: 1, failed: 0, retry: 1 });
    assert.deepEqual(ls(inbox), ['IMG_0060.JPG']); // stored server-side but the move failed: stays for the next run
    assert.deepEqual(ls(path.join(outDir, 'dropped')), ['IMG_0061.JPG']); // unaffected: the run kept going
    assert.ok(lines.some((l) => /^IMG_0060\.JPG retry: move failed/.test(l)), lines.join('\n'));
  } finally {
    fs.chmodSync(sentDir, 0o755);
    srv.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
