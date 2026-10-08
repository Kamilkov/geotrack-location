'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripJpegMetadata, parseRequest, decidePhoto } = require('../srv/lib/photos');
const { circleToWkt, prepareZones } = require('../srv/lib/geo');

// Synthetic 64×48 JPEG made with sips; exiftool wrote Make Apple, Model iPhone 16 Pro, 2026-09-22 17:50:12.345+02:00 and GPS 42.5003/1.5002.
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/photo-synthetic.jpg'));
/** Marker bytes of the header segments up to and including SOS. */
function markers(buf) {
  const out = [];
  for (let i = 2; i < buf.length;) {
    const m = buf[i + 1];
    out.push(m);
    if (m === 0xda) break;
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return out;
}
const seg = (marker, text) => { const body = Buffer.from(text); const h = Buffer.from([0xff, marker, 0, 0]); h.writeUInt16BE(body.length + 2, 2); return Buffer.concat([h, body]); };
const SOI = Buffer.from([0xff, 0xd8]), SOS_DATA = Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0xaa, 0xbb, 0xff, 0xd9]);
/** A hand-written SOS segment header (length 4, two body bytes), for building multi-scan (progressive) JPEGs. */
const SOS = (b1, b2) => Buffer.from([0xff, 0xda, 0x00, 0x04, b1, b2]);
/** Like `markers`, but keeps walking past every SOS by skipping its byte-stuffed entropy data (FF00, RSTn, fill), stopping before EOI. */
function allMarkers(buf) {
  const out = [];
  for (let i = 2; i + 1 < buf.length;) {
    const m = buf[i + 1];
    if (m === 0xd9) break;
    out.push(m);
    i += 2 + buf.readUInt16BE(i + 2);
    if (m === 0xda) {
      let j = i;
      while (j + 1 < buf.length && !(buf[j] === 0xff && buf[j + 1] !== 0x00 && buf[j + 1] !== 0xff && !(buf[j + 1] >= 0xd0 && buf[j + 1] <= 0xd7))) j++;
      i = j;
    }
  }
  return out;
}

const zone = (ID, lat, lon, r, isPrivate) => ({ ID, KIND: 'circle', RADIUSM: r, ISPRIVATE: isPrivate, CENTRELAT: lat, CENTRELON: lon, WKT: circleToWkt(lat, lon, r) });
const ZONES = prepareZones([zone('home', 42.5, 1.5, 100, true), zone('park', 42.52, 1.52, 150, false)]);
const T = new Date('2026-09-22T15:50:12.345Z');
const at = (min) => new Date(T.getTime() + min * 60000);

test('stripJpegMetadata: the fixture loses its EXIF (APP1) and keeps a decodable structure', () => {
  assert.ok(markers(FIXTURE).includes(0xe1), 'fixture must carry EXIF');
  assert.ok(FIXTURE.includes(Buffer.from('iPhone 16 Pro')));
  const out = stripJpegMetadata(FIXTURE);
  assert.ok(!markers(out).some((m) => (m >= 0xe1 && m <= 0xef) || m === 0xfe), markers(out).map((m) => m.toString(16)).join(' '));
  assert.ok(!out.includes(Buffer.from('iPhone 16 Pro')) && !out.includes(Buffer.from('Exif')));
  assert.deepEqual(out.subarray(out.indexOf(Buffer.from([0xff, 0xda]))), FIXTURE.subarray(FIXTURE.indexOf(Buffer.from([0xff, 0xda]))), 'image data unchanged');
});

test('stripJpegMetadata: drops APP1–APP15 and COM, keeps APP0 and tables; rejects non-JPEGs and broken headers', () => {
  const jpeg = Buffer.concat([SOI, seg(0xe0, 'JFIF\0'), seg(0xe1, 'Exif\0\0GPS 42.5003'), seg(0xed, 'Photoshop IPTC'), seg(0xfe, 'comment'), seg(0xdb, 'DQT'), seg(0xef, 'x'), SOS_DATA]);
  const out = stripJpegMetadata(jpeg);
  assert.deepEqual(markers(out), [0xe0, 0xdb, 0xda]);
  assert.deepEqual(out, Buffer.concat([SOI, seg(0xe0, 'JFIF\0'), seg(0xdb, 'DQT'), SOS_DATA]));
  assert.throws(() => stripJpegMetadata(Buffer.from('PNG....')), /not a JPEG/);
  assert.throws(() => stripJpegMetadata(Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x40, 0x00, 0x01])])), /malformed JPEG/);
  assert.throws(() => stripJpegMetadata(Buffer.concat([SOI, seg(0xe0, 'JFIF\0')])), /without image data/);
});

test('stripJpegMetadata: metadata after the first scan and after EOI is removed', () => {
  // Progressive layout: a second scan follows the first, with a COM and an APP1/EXIF between them.
  const progressive = Buffer.concat([
    SOI, seg(0xe0, 'JFIF\0'), seg(0xdb, 'DQT'),
    SOS(0x01, 0x02), Buffer.from([0xaa, 0xbb, 0xff, 0x00, 0xcc, 0xff, 0xd3, 0xdd]), // data with a stuffed FF00 and an RST3
    seg(0xfe, 'x'), seg(0xe1, 'Exif\0\0GPS 42.5003'),
    SOS(0x05, 0x06), Buffer.from([0xee]),
    Buffer.from([0xff, 0xd9]),
  ]);
  const out = stripJpegMetadata(progressive);
  assert.deepEqual(allMarkers(out), [0xe0, 0xdb, 0xda, 0xda]);
  assert.ok(!out.includes(Buffer.from('GPS 42.5003')) && !out.includes(Buffer.from('Exif')));
  assert.deepEqual(out, Buffer.concat([
    SOI, seg(0xe0, 'JFIF\0'), seg(0xdb, 'DQT'),
    SOS(0x01, 0x02), Buffer.from([0xaa, 0xbb, 0xff, 0x00, 0xcc, 0xff, 0xd3, 0xdd]),
    SOS(0x05, 0x06), Buffer.from([0xee]),
    Buffer.from([0xff, 0xd9]),
  ]));
  assert.equal(out.subarray(-2).toString('hex'), 'ffd9');

  // Trailer: a second JPEG (its own EXIF/GPS) plus junk appended after the fixture's own EOI.
  const withTrailer = Buffer.concat([FIXTURE, SOI, seg(0xe1, 'Exif\0\0GPS 42.5003'), SOS_DATA, Buffer.from('lat=42.5003')]);
  assert.deepEqual(stripJpegMetadata(withTrailer), stripJpegMetadata(FIXTURE));

  // Cut off inside the scan data, with no EOI anywhere.
  const cutOff = Buffer.concat([SOI, seg(0xe0, 'JFIF\0'), SOS(0x01, 0x02), Buffer.from([0xaa, 0xbb, 0xcc])]);
  assert.throws(() => stripJpegMetadata(cutOff), /without end marker/);
});

const BODY = { fileName: 'IMG_0001.HEIC', cameraModel: 'iPhone 16 Pro', takenAt: '2026-09-22T17:50:12.345+02:00', lat: 42.52, lon: 1.52, altitudeM: 1001.46, accuracyM: 4.54, directionDeg: 123, thumbnail: FIXTURE.toString('base64') };

test('parseRequest: a valid body → ID, UTC time, rounded optionals, stripped thumbnail', () => {
  const p = parseRequest(BODY);
  assert.equal(p.takenAt.toISOString(), '2026-09-22T15:50:12.345Z');
  assert.deepEqual([p.fileName, p.cameraModel, p.lat, p.lon, p.altitudeM, p.accuracyM, p.directionDeg], ['IMG_0001.HEIC', 'iPhone 16 Pro', 42.52, 1.52, 1001.5, 4.5, 123]);
  assert.ok(!markers(p.thumbnail).includes(0xe1));
  assert.equal(p.id, parseRequest({ ...BODY, fileName: 'IMG_0001.JPG' }).id, 'HEIC and JPEG of one photo share the ID');
  const bare = parseRequest({ ...BODY, lat: undefined, lon: undefined, altitudeM: 'high', accuracyM: null, directionDeg: -90 });
  assert.deepEqual([bare.lat, bare.lon, bare.altitudeM, bare.accuracyM, bare.directionDeg], [null, null, null, null, 270]);
});

test('parseRequest: each invalid field → a reason', () => {
  const cases = [
    [null, /JSON object/], [[], /JSON object/], [{ ...BODY, fileName: '' }, /fileName/], [{ ...BODY, fileName: 'x'.repeat(256) }, /fileName/],
    [{ ...BODY, cameraModel: undefined }, /cameraModel/], [{ ...BODY, takenAt: '2026-09-22T17:50:12' }, /UTC offset/], [{ ...BODY, takenAt: undefined }, /takenAt/],
    [{ ...BODY, lon: undefined }, /together/], [{ ...BODY, lat: 91 }, /out of range/], [{ ...BODY, lat: '42.5' }, /out of range/],
    [{ ...BODY, thumbnail: undefined }, /thumbnail missing/], [{ ...BODY, thumbnail: Buffer.from('not a jpeg').toString('base64') }, /thumbnail: not a JPEG/],
    [{ ...BODY, thumbnail: Buffer.alloc(500 * 1024 + 1, 0xff).toString('base64') }, /larger than 500 KB/],
  ];
  for (const [body, reason] of cases) assert.throws(() => parseRequest(body), reason, JSON.stringify(body)?.slice(0, 60));
});

test('decidePhoto: GPS in the private zone → dropped; elsewhere → stored with the public zone or none', () => {
  const p = { takenAt: T };
  assert.deepEqual(decidePhoto({ ...p, lat: 42.5003, lon: 1.5002 }, ZONES, null), { status: 'dropped', reason: 'private zone' });
  assert.deepEqual(decidePhoto({ ...p, lat: 42.52, lon: 1.52 }, ZONES, null), { status: 'stored', positionSource: 'photo', lat: 42.52, lon: 1.52, zone_ID: 'park' });
  assert.deepEqual(decidePhoto({ ...p, lat: 42.6, lon: 1.6 }, ZONES, null), { status: 'stored', positionSource: 'photo', lat: 42.6, lon: 1.6, zone_ID: null });
  // GPS decides even when OwnTracks says otherwise
  assert.equal(decidePhoto({ ...p, lat: 42.5003, lon: 1.5002 }, ZONES, { TS: T, LAT: '42.600000', LON: '1.600000', ISCOARSENED: false }).status, 'dropped');
});

test('decidePhoto: no GPS → the OwnTracks position within ±10 min; none, too far in time, private or coarsened → dropped', () => {
  const p = { takenAt: T, lat: null, lon: null };
  const pos = (min, lat, lon, coarsened = false) => ({ TS: at(min), LAT: String(lat), LON: String(lon), ISCOARSENED: coarsened });
  assert.deepEqual(decidePhoto(p, ZONES, pos(-10, 42.6, 1.6)), { status: 'stored', positionSource: 'owntracks', lat: 42.6, lon: 1.6, zone_ID: null });
  assert.deepEqual(decidePhoto(p, ZONES, pos(10, 42.52, 1.52)), { status: 'stored', positionSource: 'owntracks', lat: 42.52, lon: 1.52, zone_ID: 'park' });
  assert.deepEqual(decidePhoto(p, ZONES, pos(10.01, 42.6, 1.6)), { status: 'dropped', reason: 'no position' });
  assert.deepEqual(decidePhoto(p, ZONES, null), { status: 'dropped', reason: 'no position' });
  assert.deepEqual(decidePhoto(p, ZONES, pos(2, 42.5, 1.5)), { status: 'dropped', reason: 'private zone' });
  assert.deepEqual(decidePhoto(p, ZONES, pos(2, 42.6, 1.6, 1)), { status: 'dropped', reason: 'private zone' }); // coarsened (HANA may answer 1)
});
