'use strict';
const { parseTime } = require('./health');
const { zoneOf } = require('./geo');
const { photoId } = require('./photo-meta');

const MAX_THUMBNAIL = 500 * 1024;
const WINDOW_MS = 10 * 60000; // OwnTracks fallback: ±10 min around the time taken

/**
 * Remove every APP1–APP15 (EXIF, XMP, MPF, …) and COM segment from a JPEG, wherever it appears, and
 * everything after EOI (e.g. MPF secondary images, which carry their own EXIF). APP0, tables and the
 * entropy-coded data are kept byte for byte. Throws on anything that is not a complete JPEG.
 */
function stripJpegMetadata(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  const parts = [buf.subarray(0, 2)];
  let scanned = false;
  for (let i = 2; ;) {
    if (i + 2 > buf.length) throw new Error(scanned ? 'JPEG without end marker' : 'JPEG without image data');
    if (buf[i] !== 0xff) throw new Error('malformed JPEG');
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xd9) { // EOI: keep it, drop any trailer
      if (!scanned) throw new Error('JPEG without image data');
      return Buffer.concat([...parts, buf.subarray(i, i + 2)]);
    }
    if (i + 4 > buf.length) throw new Error('malformed JPEG');
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw new Error('malformed JPEG');
    if (!((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe)) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
    if (marker === 0xda) { // SOS: entropy-coded data runs to the next marker; FF00, RSTn (FFD0–FFD7) and fill bytes are data
      scanned = true;
      let j = i;
      while (j + 1 < buf.length && !(buf[j] === 0xff && buf[j + 1] !== 0x00 && buf[j + 1] !== 0xff && !(buf[j + 1] >= 0xd0 && buf[j + 1] <= 0xd7))) j++;
      if (j + 1 >= buf.length) throw new Error('JPEG without end marker');
      parts.push(buf.subarray(i, j));
      i = j;
    }
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const opt = (v, d) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** Validate a POST /photos body → photo with its ID and a metadata-free thumbnail. Throws Error(reason) → 400. */
function parseRequest(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('body must be a JSON object');
  const fileName = typeof b.fileName === 'string' ? b.fileName.trim() : '';
  const cameraModel = typeof b.cameraModel === 'string' ? b.cameraModel.trim() : '';
  if (!fileName || fileName.length > 255) throw new Error('fileName missing or longer than 255 characters');
  if (!cameraModel || cameraModel.length > 60) throw new Error('cameraModel missing or longer than 60 characters');
  const takenAt = parseTime(b.takenAt);
  if (!takenAt) throw new Error('takenAt missing or without UTC offset');
  if ((b.lat == null) !== (b.lon == null)) throw new Error('lat and lon must come together');
  if (b.lat != null && !(isNum(b.lat) && Math.abs(b.lat) <= 90 && isNum(b.lon) && Math.abs(b.lon) <= 180)) throw new Error('lat/lon out of range');
  const raw = typeof b.thumbnail === 'string' ? Buffer.from(b.thumbnail, 'base64') : null;
  if (!raw || !raw.length) throw new Error('thumbnail missing');
  if (raw.length > MAX_THUMBNAIL) throw new Error('thumbnail larger than 500 KB');
  let thumbnail;
  try { thumbnail = stripJpegMetadata(raw); } catch (e) { throw new Error(`thumbnail: ${e.message}`); }
  return {
    id: photoId(cameraModel, takenAt), fileName, cameraModel, takenAt,
    lat: b.lat ?? null, lon: b.lon ?? null,
    altitudeM: opt(b.altitudeM, 1), accuracyM: opt(b.accuracyM, 1),
    directionDeg: isNum(b.directionDeg) ? ((Math.round(b.directionDeg) % 360) + 360) % 360 : null,
    thumbnail,
  };
}

/**
 * The privacy decision. With GPS: its zone decides. Without: the closest OwnTracks position
 * (`fallback`: { TS: Date, LAT, LON, ISCOARSENED }) if it lies within ±10 min. A private zone or no
 * usable position → dropped, and nothing about the photo may be stored.
 */
function decidePhoto(photo, zones, fallback) {
  if (photo.lat != null) {
    const z = zoneOf(photo.lat, photo.lon, zones);
    if (z?.isPrivate) return { status: 'dropped', reason: 'private zone' };
    return { status: 'stored', positionSource: 'photo', lat: photo.lat, lon: photo.lon, zone_ID: z?.ID ?? null };
  }
  if (!fallback || Math.abs(fallback.TS - photo.takenAt) > WINDOW_MS) return { status: 'dropped', reason: 'no position' };
  const lat = Number(fallback.LAT), lon = Number(fallback.LON);
  const z = zoneOf(lat, lon, zones);
  if (z?.isPrivate || fallback.ISCOARSENED === true || fallback.ISCOARSENED === 1) return { status: 'dropped', reason: 'private zone' };
  return { status: 'stored', positionSource: 'owntracks', lat, lon, zone_ID: z?.ID ?? null };
}

module.exports = { stripJpegMetadata, parseRequest, decidePhoto, WINDOW_MS };
