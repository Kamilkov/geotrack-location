'use strict';
// Sends iPhone photos the owner drops into ~/Pictures/GeoTrack/inbox (AirDropped to ~/Downloads first) to POST /photos: metadata plus a metadata-free thumbnail.
// Originals move to ~/Pictures/GeoTrack/{sent,dropped,failed}; after a 401, a 5xx or a network error they stay for the next run.
// Run: npm run photos [-- <inbox>]   (launchd: deploy/com.geotrack.photos.plist)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fromExif } = require('../srv/lib/photo-meta');

const exec = promisify(execFile);
const DEFAULT_URL = 'https://geotrack.example.com/photos';
const IMAGE = /\.(heic|jpe?g|dng)$/i; // dng: Apple ProRAW
const TAGS = ['-Make', '-Model', '-SubSecDateTimeOriginal', '-DateTimeOriginal', '-OffsetTimeOriginal', '-GPSLatitude', '-GPSLongitude',
  '-EXIF:GPSAltitude', '-GPSAltitudeRef', '-GPSHPositioningError', '-GPSImgDirection', '-Orientation', '-Error', '-Warning'];
const isIphone = (x) => x.Make === 'Apple' && /^iPhone/.test(String(x.Model ?? ''));
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** fs.statSync, but a broken symlink or a permission error yields null instead of throwing. */
function safeStat(f) {
  try { return fs.statSync(f); } catch { return null; }
}

/** exiftool -j -n over many files at once; exiftool missing → throws (nothing gets moved). */
async function readExif(files) {
  const { stdout } = await exec('exiftool', ['-j', '-n', ...TAGS, ...files], { maxBuffer: 64 * 1024 * 1024 }).catch((e) => {
    if (e.stdout) return e; // exiftool exits 1 when one file is unreadable but still prints the others
    throw e;
  });
  return JSON.parse(stdout || '[]');
}

const ROTATE_DEG = { 6: 90, 3: 180, 8: 270 }; // EXIF Orientation → clockwise degrees to make it upright
const SRGB_PROFILE = '/System/Library/ColorSync/Profiles/sRGB Profile.icc'; // stock on every Mac

/**
 * 800 px sRGB JPEG via sips, then exiftool strips all metadata: sips copies the GPS into the thumbnail.
 * sips keeps the stored pixel orientation, so a portrait (6/8) or upside-down (3) photo is rotated
 * upright first — the EXIF Orientation tag itself is stripped right after, by us and again by the server.
 * Converted to sRGB before that strip, since the color profile (e.g. Display P3 on iPhone) goes with it.
 */
async function thumbnail(file, tmpDir, orientation) {
  const out = path.join(tmpDir, `${path.basename(file)}.thumb.jpg`);
  const deg = ROTATE_DEG[orientation];
  try {
    await exec('sips', [...(deg ? ['-r', String(deg)] : []), '-Z', '800', '-m', SRGB_PROFILE, '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', file, '--out', out]);
    await exec('exiftool', ['-q', '-overwrite_original', '-all=', out]);
    return fs.readFileSync(out);
  } finally { fs.rmSync(out, { force: true }); }
}

/**
 * Move without overwriting: a name clash gets -1, -2, … Picks the free name by creating it as a hard
 * link (atomic — no existsSync-then-write race), then unlinks the original; a link can't cross
 * volumes (EXDEV), so that case copies instead, excluding an existing target the same way.
 */
function moveTo(file, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const { name, ext } = path.parse(file);
  for (let n = 0; ; n++) {
    const target = path.join(dir, n === 0 ? name + ext : `${name}-${n}${ext}`);
    try {
      fs.linkSync(file, target);
    } catch (e) {
      if (e.code === 'EEXIST') continue; // name taken: try the next suffix
      if (e.code !== 'EXDEV') throw e;
      try {
        fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL); // another volume
      } catch (e2) {
        if (e2.code === 'EEXIST') continue;
        throw e2;
      }
    }
    fs.unlinkSync(file);
    return;
  }
}

/** moveTo, but a failed move (e.g. a read-only target) never aborts the run: it logs and returns false. */
function safeMoveTo(file, dir, name, log) {
  try { moveTo(file, dir); return true; } catch (e) { log(`${name} retry: move failed (${e.code ?? e.message})`); return false; }
}

/** One photo → 'stored' | 'dropped' | 'failed' (moved) or 'retry' (left in the inbox). */
async function sendOne(file, exif, { outDir, url, token, fetchFn, log, tmpDir }) {
  const name = path.basename(file);
  let body;
  try { body = { fileName: name, ...fromExif(exif), thumbnail: (await thumbnail(file, tmpDir, exif.Orientation)).toString('base64') }; } catch (e) {
    if (!safeMoveTo(file, path.join(outDir, 'failed'), name, log)) return 'retry';
    log(`${name} failed: ${e.message.split('\n')[0]}`);
    return 'failed';
  }
  let res;
  try {
    res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  } catch (e) {
    log(`${name} retry: ${e.cause?.code ?? e.message}`);
    return 'retry';
  }
  const answer = await res.json().catch(() => ({}));
  if (res.ok && (answer.status === 'stored' || answer.status === 'dropped')) {
    if (!safeMoveTo(file, path.join(outDir, answer.status === 'stored' ? 'sent' : 'dropped'), name, log)) return 'retry';
    // The ID is what the owner's app shows for the same photo: the two must be the same row.
    log(`${name} ${answer.status}${answer.reason ? ` (${answer.reason})` : ''}${answer.positionSource ? ` via ${answer.positionSource}` : ''}${answer.id ? ` id ${answer.id}` : ''}`);
    return answer.status;
  }
  if (res.status === 400 || res.status === 413) {
    if (!safeMoveTo(file, path.join(outDir, 'failed'), name, log)) return 'retry';
    log(`${name} failed: HTTP ${res.status} ${answer.error ?? ''}`.trim());
    return 'failed';
  }
  log(`${name} retry: HTTP ${res.status}`);
  return 'retry';
}

/**
 * One run over the inbox. Files younger than `settleMs` may still be written by AirDrop: the run
 * rescans every `pollMs` until they have settled, for at most `waitMs`. Returns the counts.
 */
async function sendAll({ inbox, outDir, url, token, fetchFn = fetch, settleMs = 10000, waitMs = 120000, pollMs = 5000, log = console.log, sleep = sleepMs }) {
  const counts = { stored: 0, dropped: 0, failed: 0, retry: 0 };
  const seen = new Set();
  const deadline = Date.now() + waitMs;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geotrack-photos-'));
  try {
    for (;;) {
      // One stat per entry: a broken symlink or a permission error yields null here and is quietly left alone,
      // never aborting the run.
      const stats = fs.readdirSync(inbox).filter((f) => IMAGE.test(f)).map((f) => path.join(inbox, f))
        .filter((f) => !seen.has(f)).map((f) => [f, safeStat(f)]).filter(([, s]) => s && s.isFile());
      // ctime, not mtime: AirDrop backdates a received file's mtime (and birth time) to when the photo
      // was taken, so a half-written file already looks old by mtime. ctime (last metadata/content
      // change) can't be backdated the same way — utimes() itself resets it to now — so it actually
      // tracks how long ago the file's bytes stopped changing.
      const fresh = stats.filter(([, s]) => Date.now() - s.ctimeMs < settleMs).map(([f]) => f);
      const ready = stats.filter(([f]) => !fresh.includes(f)).map(([f]) => f);
      if (ready.length) {
        for (const x of await readExif(ready)) {
          const name = path.basename(x.SourceFile);
          // A truncated HEIC still passes exiftool with just a Warning (e.g. "Truncated 'mdat' data
          // at offset ..."); sips would happily produce a corrupt thumbnail from it, so wait instead.
          if (isIphone(x) && /truncat/i.test(x.Warning ?? '')) { log(`${name} waiting: ${x.Warning}`); counts.retry++; }
          else if (isIphone(x)) counts[await sendOne(x.SourceFile, x, { outDir, url, token, fetchFn, log, tmpDir })]++;
          else if (x.Error) log(`${name} skipped: ${x.Error}`); // unreadable, not identifiable as ours: left in place
        }
        ready.forEach((f) => seen.add(f)); // other images stay where they are, untouched
      }
      if (!fresh.length) break;
      if (Date.now() >= deadline) { log(`${fresh.length} file(s) still being written, left for the next run`); break; }
      await sleep(pollMs);
    }
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  return counts;
}

if (require.main === module) {
  const stamp = (m) => console.log(`${new Date().toISOString()} ${m}`);
  if (!process.env.HEALTH_TOKEN) { stamp('HEALTH_TOKEN not set (.env)'); process.exit(1); }
  sendAll({
    inbox: process.argv[2] ?? path.join(os.homedir(), 'Pictures', 'GeoTrack', 'inbox'),
    outDir: process.env.PHOTOS_OUT ?? path.join(os.homedir(), 'Pictures', 'GeoTrack'),
    url: process.env.PHOTOS_URL ?? DEFAULT_URL,
    token: process.env.HEALTH_TOKEN,
    log: stamp,
  }).then((c) => {
    if (c.stored + c.dropped + c.failed + c.retry) stamp(`done ${JSON.stringify(c)}`);
  }).catch((e) => { stamp(`run failed: ${e.message.split('\n')[0]}`); process.exit(1); });
}

module.exports = { sendAll };
