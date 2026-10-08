'use strict';
// HANA smoke for the photos slice. Device `smoke5`; private test zones `smoke5-*` near 42.50/1.50 and 42.52/1.52
// (synthetic, far from any real zone). Cleans up before and in `finally`. Needs the photos deploy.
// Run: npx cds bind --exec -- node scripts/db-smoke-photos.js
const cds = require('@sap/cds');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { mount } = require('../srv/lib/photos-ingest');
const { stripJpegMetadata } = require('../srv/lib/photos');
const { photoId } = require('../srv/lib/photo-meta');
const { circleToWkt } = require('../srv/lib/geo');
const { insertPosition } = require('../srv/lib/store');
const { utcDate } = require('../srv/lib/time');
const { dropPrivatePhotos } = require('./coarsen-backfill');
const { deletePhoto } = require('../srv/lib/photo-delete');

const device = 'smoke5', TOKEN = randomUUID(), TRIP = randomUUID(), Z1 = randomUUID(), Z2 = randomUUID();
const FIXTURE = fs.readFileSync(path.join(__dirname, '../test/fixtures/photo-synthetic.jpg'));
const q = (sql, p = []) => cds.db.run(sql, p);
const MODEL = 'iPhone 16 Pro';
/** A POST /photos body; `time` is UTC ("10:10:00.250"), sent with the +02:00 offset the phone would write. */
const photo = (fileName, time, lat, lon) => {
  const [h, rest] = [Number(time.slice(0, 2)), time.slice(2)];
  return { fileName, cameraModel: MODEL, takenAt: `2026-09-22T${String(h + 2).padStart(2, '0')}${rest}+02:00`, lat, lon, altitudeM: 1001.5, accuracyM: 4.5, directionDeg: 90, thumbnail: FIXTURE.toString('base64') };
};
const idOf = (time) => photoId(MODEL, `2026-09-22T${time}Z`);
const position = (ts, lat, lon, zone_ID = null, isCoarsened = false) => insertPosition({
  device, ts: new Date(ts), receivedAt: new Date(ts), lat, lon, accuracy: 5, altitude: 0, velocity: 4, course: 0, battery: 90, batteryState: 1,
  connection: 'm', ssid: null, pressure: null, trigger: 't', zone_ID, isCoarsened, activities: 'walking',
  raw: JSON.stringify({ _type: 'location', tst: Math.floor(new Date(ts).getTime() / 1000) }),
});
const mkZone = (id, name, lat, lon, r) => q(`INSERT INTO GEOTRACK_ZONES (ID, NAME, KIND, CENTRELAT, CENTRELON, RADIUSM, WKT, GEOM, ISBASE, ISPRIVATE, CREATESVISIT)
  VALUES (?, ?, 'circle', ?, ?, ?, ?, ST_GeomFromText(?, 4326), FALSE, TRUE, FALSE)`, [id, name, lat, lon, r, circleToWkt(lat, lon, r), circleToWkt(lat, lon, r)]);
const cleanup = async () => {
  await q('DELETE FROM GEOTRACK_PHOTOS WHERE DEVICE = ?', [device]);
  await q('DELETE FROM GEOTRACK_POSITIONS WHERE DEVICE = ?', [device]);
  await q('DELETE FROM GEOTRACK_TRIPS WHERE DEVICE = ?', [device]);
  await q('DELETE FROM GEOTRACK_WORKOUTS WHERE DEVICE = ?', [device]);
  await q("DELETE FROM GEOTRACK_ZONES WHERE NAME LIKE 'smoke5-%'");
};
const count = async (id) => Number((await q('SELECT COUNT(*) N FROM GEOTRACK_PHOTOS WHERE ID = ?', [id]))[0].N);

(async () => {
  await cds.connect.to('db');
  const app = express();
  mount(app, { token: TOKEN, device, db: cds.db });
  const server = app.listen(0, '127.0.0.1'); // not on every address: see test/test-servers.test.js
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/photos`;
  const post = (body, token = TOKEN) => fetch(url, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }).then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    await cleanup(); // a killed earlier run may have left rows behind
    await mkZone(Z1, 'smoke5-private', 42.5, 1.5, 100);

    // 1. auth
    assert.equal((await post(photo('IMG_0001.HEIC', '10:10:00.250', 42.52, 1.52), null)).status, 401);
    assert.equal(await count(idOf('10:10:00.250')), 0);

    // 2. stored: row, point, exact thumbnail bytes (metadata stripped), milliseconds kept
    let r = await post(photo('IMG_0001.HEIC', '10:10:00.250', 42.52, 1.52));
    console.log('stored:', r.status, JSON.stringify(r.json));
    assert.deepEqual(r.json, { id: idOf('10:10:00.250'), status: 'stored', reason: null, positionSource: 'photo' });
    const [row] = await q('SELECT TAKENAT, LAT, LON, ALTITUDEM, POSITIONSOURCE, THUMBNAIL, THUMBNAILBYTES, POINT.ST_SRID() S, POINT.ST_X() X, POINT.ST_Y() Y FROM GEOTRACK_PHOTOS WHERE ID = ?', [idOf('10:10:00.250')]);
    assert.equal(utcDate(row.TAKENAT).toISOString(), '2026-09-22T10:10:00.250Z');
    assert.deepEqual([Number(row.LAT), Number(row.LON), Number(row.ALTITUDEM), row.POSITIONSOURCE, row.S, Number(row.X), Number(row.Y)], [42.52, 1.52, 1001.5, 'photo', 4326, 1.52, 42.52]);
    const expected = stripJpegMetadata(FIXTURE);
    assert.ok(Buffer.isBuffer(row.THUMBNAIL) && row.THUMBNAIL.equals(expected), 'thumbnail bytes round-trip, stripped');
    assert.equal(Number(row.THUMBNAILBYTES), expected.length);
    assert.ok(!row.THUMBNAIL.includes(Buffer.from('Exif')));

    // 3. resend as JPEG: one row, new file name
    assert.equal((await post(photo('IMG_0001.JPG', '10:10:00.250', 42.52, 1.52))).json.status, 'stored');
    assert.equal(await count(idOf('10:10:00.250')), 1);
    assert.equal((await q('SELECT FILENAME FROM GEOTRACK_PHOTOS WHERE ID = ?', [idOf('10:10:00.250')]))[0].FILENAME, 'IMG_0001.JPG');

    // 4. inside the private zone: dropped, nothing stored; a stored copy of the same photo is deleted
    r = await post(photo('IMG_0002.HEIC', '10:20:00.000', 42.5003, 1.5002));
    assert.deepEqual([r.json.status, r.json.reason], ['dropped', 'private zone']);
    assert.equal(await count(idOf('10:20:00.000')), 0);
    assert.equal((await post(photo('IMG_0003.HEIC', '10:25:00.000', 42.52, 1.52))).json.status, 'stored');
    assert.equal((await post(photo('IMG_0003.HEIC', '10:25:00.000', 42.5003, 1.5002))).json.status, 'dropped');
    assert.equal(await count(idOf('10:25:00.000')), 0, 'the earlier stored copy is gone');

    // 5. no GPS: OwnTracks within ±10 min is borrowed; none → dropped; a coarsened (home) position → dropped
    assert.equal(await position('2026-09-22T10:13:00Z', 42.53, 1.53), 'inserted');
    r = await post(photo('IMG_0004.HEIC', '10:10:30.000', undefined, undefined));
    assert.deepEqual(r.json, { id: idOf('10:10:30.000'), status: 'stored', reason: null, positionSource: 'owntracks' });
    const [b] = await q('SELECT LAT, LON, ALTITUDEM, ACCURACYM, DIRECTIONDEG FROM GEOTRACK_PHOTOS WHERE ID = ?', [idOf('10:10:30.000')]);
    assert.deepEqual([Number(b.LAT), Number(b.LON), b.ALTITUDEM, b.ACCURACYM, b.DIRECTIONDEG], [42.53, 1.53, null, null, null]);
    r = await post(photo('IMG_0005.HEIC', '10:30:00.000', undefined, undefined)); // the 10:13 fix is 17 min away
    assert.deepEqual([r.json.status, r.json.reason], ['dropped', 'no position']);
    assert.equal(await position('2026-09-22T11:00:00Z', 42.5, 1.5, Z1, true), 'inserted');
    r = await post(photo('IMG_0006.HEIC', '11:02:00.000', undefined, undefined));
    assert.deepEqual([r.json.status, r.json.reason], ['dropped', 'private zone']);

    // 6. PhotoContext: trip, workout, minute and weather hour; a photo outside both has empty links
    await q(`INSERT INTO GEOTRACK_TRIPS (ID, DEVICE, STARTEDAT, ENDEDAT, KIND, POINTCOUNT, WEATHERFETCHEDAT) VALUES (?, ?, ?, ?, 'walk', 0, ?)`,
      [TRIP, device, '2026-09-22T10:00:00.000Z', '2026-09-22T11:00:00.000Z', new Date().toISOString()]); // weather-marked: the live sweep leaves it alone
    await q('INSERT INTO GEOTRACK_WORKOUTS (ID, DEVICE, NAME, STARTEDAT, ENDEDAT, RECEIVEDAT) VALUES (?, ?, ?, ?, ?, ?)',
      ['smoke5-walk', device, 'Outdoor Walk', '2026-09-22T10:05:00.000Z', '2026-09-22T10:40:00.000Z', new Date().toISOString()]);
    assert.equal((await post(photo('IMG_0007.HEIC', '12:30:00.000', 42.6, 1.6))).json.status, 'stored');
    const ctx = await q('SELECT PHOTO_ID, TRIP_ID, TRIPKIND, WORKOUT_ID, MINUTETS, WEATHERHOUR FROM GEOTRACK_PHOTOCONTEXT WHERE PHOTO_ID IN (?, ?) ORDER BY TAKENAT', [idOf('10:10:00.250'), idOf('12:30:00.000')]);
    console.table(ctx);
    assert.deepEqual(ctx.map((c) => [c.TRIP_ID, c.TRIPKIND, c.WORKOUT_ID, c.MINUTETS && utcDate(c.MINUTETS).toISOString(), c.WEATHERHOUR && utcDate(c.WEATHERHOUR).toISOString()]), [
      [TRIP, 'walk', 'smoke5-walk', '2026-09-22T10:10:00.000Z', '2026-09-22T10:00:00.000Z'],
      [null, null, null, '2026-09-22T12:30:00.000Z', '2026-09-22T12:00:00.000Z'],
    ]);

    // 7. a private zone added later: coarsen-backfill's photo pass deletes what now lies inside, idempotently
    await mkZone(Z2, 'smoke5-late', 42.52, 1.52, 100);
    assert.equal(await dropPrivatePhotos({ dryRun: true, device }), 0);
    assert.equal(await count(idOf('10:10:00.250')), 1, 'a dry run deletes nothing');
    assert.equal(await dropPrivatePhotos({ device }), 1);
    assert.equal(await count(idOf('10:10:00.250')), 0);
    assert.equal(await count(idOf('10:10:30.000')), 1, 'the photo at 42.53/1.53 stays');
    assert.equal(await dropPrivatePhotos({ device }), 0, 'second run finds nothing');

    // 8. the trips app's delete (TripService.deletePhoto): the row goes; a second delete finds nothing
    const del = (ID) => deletePhoto({ data: { ID }, reject: (code, message) => { throw Object.assign(new Error(message), { code }); } }, { db: cds.db, readOnly: false });
    await del(idOf('10:10:30.000'));
    assert.equal(await count(idOf('10:10:30.000')), 0);
    await assert.rejects(del(idOf('10:10:30.000')), { code: 404 });
    console.log('smoke ok');
  } finally {
    server.close();
    await cleanup();
    const [left] = await q("SELECT (SELECT COUNT(*) FROM GEOTRACK_PHOTOS WHERE DEVICE = 'smoke5') P, (SELECT COUNT(*) FROM GEOTRACK_POSITIONS WHERE DEVICE = 'smoke5') POS, (SELECT COUNT(*) FROM GEOTRACK_ZONES WHERE NAME LIKE 'smoke5-%') Z FROM DUMMY");
    console.log('left after cleanup:', left);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
