'use strict';
const { uuidv5 } = require('./ids');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** exiftool's "2026:09:22 17:50:12.345+02:00" → "2026-09-22T17:50:12.345+02:00"; no offset → null. */
function exifTime(s) {
  const m = typeof s === 'string' && /^(\d{4}):(\d\d):(\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?)(Z|[+-]\d\d:\d\d)$/.exec(s.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}${m[5]}` : null;
}

/**
 * One `exiftool -j -n` record → the POST /photos fields without the thumbnail. Throws when the
 * time carries no UTC offset: such a photo cannot be placed on the timeline safely.
 */
function fromExif(x) {
  const takenAt = exifTime(x.SubSecDateTimeOriginal) ?? (x.OffsetTimeOriginal ? exifTime(`${x.DateTimeOriginal}${x.OffsetTimeOriginal}`) : null);
  if (!takenAt) throw new Error('no time with UTC offset');
  const lat = num(x.GPSLatitude), lon = num(x.GPSLongitude), alt = num(x.GPSAltitude), dir = num(x.GPSImgDirection);
  const gps = lat != null && lon != null;
  return {
    cameraModel: String(x.Model ?? '').slice(0, 60),
    takenAt,
    lat: gps ? lat : null,
    lon: gps ? lon : null,
    altitudeM: gps && alt != null ? (x.GPSAltitudeRef === 1 ? -alt : alt) : null, // ref 1 = below sea level
    accuracyM: gps ? num(x.GPSHPositioningError) : null,
    directionDeg: dir == null ? null : Math.round(dir) % 360,
  };
}

/** The same photo gets the same ID whether it arrives as HEIC or JPEG: camera model plus the exact time taken. */
const photoId = (cameraModel, takenAt) => uuidv5(`photo|${cameraModel}|${new Date(takenAt).toISOString()}`);

module.exports = { fromExif, photoId };
