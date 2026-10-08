'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fromExif, photoId } = require('../srv/lib/photo-meta');
const { parseRequest } = require('../srv/lib/photos');

// An `exiftool -j -n` record as the Mac script reads it (synthetic, near 42.50/1.50).
const EXIF = {
  SourceFile: 'IMG_0001.HEIC', Make: 'Apple', Model: 'iPhone 16 Pro',
  SubSecDateTimeOriginal: '2026:09:22 17:50:12.345+02:00', DateTimeOriginal: '2026:09:22 17:50:12', OffsetTimeOriginal: '+02:00',
  GPSLatitude: 42.5003, GPSLongitude: 1.5002, GPSAltitude: 1001.5, GPSAltitudeRef: 0, GPSHPositioningError: 4.5, GPSImgDirection: 359.7,
};

test('fromExif: time with sub-seconds and offset, signed GPS, direction rounded into 0–359', () => {
  assert.deepEqual(fromExif(EXIF), {
    cameraModel: 'iPhone 16 Pro', takenAt: '2026-09-22T17:50:12.345+02:00',
    lat: 42.5003, lon: 1.5002, altitudeM: 1001.5, accuracyM: 4.5, directionDeg: 0,
  });
  assert.deepEqual([fromExif({ ...EXIF, GPSLatitude: -42.5003, GPSLongitude: -1.5002 }).lat, fromExif({ ...EXIF, GPSLatitude: -42.5003, GPSLongitude: -1.5002 }).lon], [-42.5003, -1.5002]);
});

test('fromExif: falls back to DateTimeOriginal + OffsetTimeOriginal; no offset at all throws', () => {
  const { SubSecDateTimeOriginal, ...noSubSec } = EXIF;
  assert.equal(fromExif(noSubSec).takenAt, '2026-09-22T17:50:12+02:00');
  assert.equal(fromExif({ ...EXIF, SubSecDateTimeOriginal: '2026:09:22 17:50:12.345' }).takenAt, '2026-09-22T17:50:12+02:00');
  const { OffsetTimeOriginal, ...noOffset } = noSubSec;
  assert.throws(() => fromExif(noOffset), /no time with UTC offset/);
  assert.throws(() => fromExif({ Make: 'Apple', Model: 'iPhone 16 Pro' }), /no time with UTC offset/);
});

test('fromExif: altitude below sea level is negative; no GPS → no position, altitude or accuracy', () => {
  assert.equal(fromExif({ ...EXIF, GPSAltitudeRef: 1 }).altitudeM, -1001.5);
  const { GPSLatitude, GPSLongitude, ...noGps } = EXIF;
  const r = fromExif(noGps);
  assert.deepEqual([r.lat, r.lon, r.altitudeM, r.accuracyM, r.directionDeg], [null, null, null, null, 0]);
  assert.equal(fromExif({ ...EXIF, GPSLongitude: undefined }).lat, null); // half a position is no position
});

test('photoId: the same photo as HEIC or JPEG → one ID; another time or camera → another ID', () => {
  const heic = fromExif(EXIF), jpeg = fromExif({ ...EXIF, SourceFile: 'IMG_0001.JPG' });
  assert.equal(photoId(heic.cameraModel, heic.takenAt), photoId(jpeg.cameraModel, jpeg.takenAt));
  assert.equal(photoId('iPhone 16 Pro', '2026-09-22T17:50:12.345+02:00'), photoId('iPhone 16 Pro', new Date('2026-09-22T15:50:12.345Z')));
  assert.notEqual(photoId('iPhone 16 Pro', '2026-09-22T17:50:12.346+02:00'), photoId('iPhone 16 Pro', '2026-09-22T17:50:12.345+02:00'));
  assert.notEqual(photoId('iPhone 15', heic.takenAt), photoId('iPhone 16 Pro', heic.takenAt));
  assert.match(photoId('iPhone 16 Pro', heic.takenAt), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

const appBody = require('./fixtures/ios-photo.json');

// The contract with the owner's app: ios/GeoTrackKit's PhotoMetaTests reads the same file and checks that the
// app's encoder produces it. Here: the server takes it, and the Mac's exiftool record of the same photo gives
// the same fields and the same ID, so both paths land on one row.
test('the app\'s request body: the server takes it, and it names the photo as the Mac does', () => {
  const mac = fromExif({ SubSecDateTimeOriginal: '2026:09:22 17:50:12.345+02:00', Model: 'iPhone 17 Pro', GPSLatitude: 42.51, GPSLongitude: 1.52,
    GPSAltitude: 1012.4, GPSAltitudeRef: 0, GPSHPositioningError: 4.7, GPSImgDirection: 271.6 });
  const { fileName, thumbnail, ...fields } = appBody;
  assert.deepEqual(fields, mac);
  const photo = parseRequest(appBody);
  assert.equal(photo.id, photoId(mac.cameraModel, mac.takenAt));
  assert.equal(photo.fileName, 'IMG_0001.HEIC');
  assert.deepEqual([photo.lat, photo.lon, photo.altitudeM, photo.accuracyM, photo.directionDeg], [42.51, 1.52, 1012.4, 4.7, 272]);
});
