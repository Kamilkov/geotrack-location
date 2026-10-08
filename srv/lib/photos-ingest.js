'use strict';
const cds = require('@sap/cds');
const express = require('express');
const { auth, onError, ZONES } = require('./health-ingest');
const { parseRequest, decidePhoto, WINDOW_MS } = require('./photos');
const { prepareZones } = require('./geo');
const { utcDate } = require('./time');

const log = cds.log('photos');
// Uncorrelated (all parameters), so TOP/ORDER BY are fine here.
const NEAREST = `SELECT TOP 1 TS, LAT, LON, ISCOARSENED FROM GEOTRACK_POSITIONS
  WHERE DEVICE = ? AND TS BETWEEN ? AND ? ORDER BY ABS(SECONDS_BETWEEN(TS, ?))`;
// One statement: row and point together, so no transaction is needed.
const UPSERT_PHOTO = `UPSERT GEOTRACK_PHOTOS (ID, DEVICE, TAKENAT, FILENAME, CAMERAMODEL, LAT, LON, POINT, ALTITUDEM, ACCURACYM,
  DIRECTIONDEG, POSITIONSOURCE, ZONE_ID, THUMBNAIL, THUMBNAILBYTES, RECEIVEDAT)
  VALUES (?, ?, ?, ?, ?, ?, ?, NEW ST_POINT(?, ?, 4326), ?, ?, ?, ?, ?, ?, ?, ?) WITH PRIMARY KEY`;

async function handle(req, res, db, device) {
  let photo;
  try { photo = parseRequest(req.body); } catch (e) {
    log.warn('photo rejected: 400', e.message); // fixed reason texts, no values
    return res.status(400).json({ error: e.message });
  }
  let zones, fallback = null;
  try {
    zones = await db.run(ZONES);
    if (photo.lat == null) {
      const t = photo.takenAt.getTime();
      [fallback] = await db.run(NEAREST, [device, new Date(t - WINDOW_MS).toISOString(), new Date(t + WINDOW_MS).toISOString(), photo.takenAt.toISOString()]);
    }
  } catch (e) {
    log.error('database unavailable:', e.code ?? e.name);
    return res.status(503).json({ error: 'database unavailable' });
  }
  // A private zone without a centre or geometry throws here → 500: nothing is stored unchecked.
  const d = decidePhoto(photo, prepareZones(zones), fallback ? { ...fallback, TS: utcDate(fallback.TS) } : null);
  try {
    if (d.status === 'dropped') await db.run('DELETE FROM GEOTRACK_PHOTOS WHERE ID = ?', [photo.id]); // an earlier upload of it goes too
    else {
      const own = d.positionSource === 'photo'; // borrowed OwnTracks positions carry no altitude, accuracy or direction
      await db.run(UPSERT_PHOTO, [
        photo.id, device, photo.takenAt.toISOString(), photo.fileName, photo.cameraModel, d.lat, d.lon, d.lon, d.lat,
        own ? photo.altitudeM : null, own ? photo.accuracyM : null, own ? photo.directionDeg : null,
        d.positionSource, d.zone_ID, photo.thumbnail, photo.thumbnail.length, new Date().toISOString(),
      ]);
    }
  } catch (e) {
    const up = await db.run('SELECT 1 FROM DUMMY').then(() => true, () => false);
    log.error('photo', photo.fileName, 'not stored:', e.code ?? e.name); // HANA messages can quote values
    return res.status(up ? 500 : 503).json({ error: up ? 'not stored' : 'database unavailable' });
  }
  log.info('photo', photo.fileName, d.status, d.reason ?? '', d.positionSource ?? '');
  res.json({ id: photo.id, status: d.status, reason: d.reason ?? null, positionSource: d.positionSource ?? null });
}

/** Register POST /photos: the workouts' token check before parsing, then a 1 MB JSON body (one ~130 KB photo). */
function mount(app, { token = process.env.HEALTH_TOKEN, device = process.env.HEALTH_DEVICE || 'iphone', db } = {}) {
  app.post('/photos', auth(token), express.json({ limit: '1mb' }), (req, res) => handle(req, res, db ?? cds.db, device), onError);
}

module.exports = { mount };
