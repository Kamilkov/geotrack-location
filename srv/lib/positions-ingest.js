'use strict';
const cds = require('@sap/cds');
// ponytail: the Express @sap/cds brings (no own dependency, as in health-ingest.js).
const express = require('express');
const { auth, onError, ZONES, DEVICE } = require('./health-ingest');
const { parse } = require('./owntracks');
const { prepareZones, zoneOf } = require('./geo');
const { coarsen } = require('./coarsen');
const { insertPosition } = require('./store');
const runner = require('./segment-runner');

const log = cds.log('positions');
const MAX_POSITIONS = 500;
const up = (db) => db.run('SELECT 1 FROM DUMMY').then(() => true, () => false);
/** coarsen() takes a zone as findZone returns it; prepareZones names the same four values differently. */
const zoneRow = (z) => z && { ID: z.ID, ISPRIVATE: z.isPrivate, CENTRELAT: z.centreLat, CENTRELON: z.centreLon };

/**
 * A batch of positions in OwnTracks' JSON shape, through the path MQTT uses: parser, zone, coarsening, insert.
 * Answers 200 { stored, duplicates, skipped: [index] }; a resend is safe, the insert recognises a repeat.
 */
async function handle(req, res, db, schedule) {
  const { device, positions } = req.body ?? {};
  if (typeof device !== 'string' || !DEVICE.test(device)) return res.status(400).json({ error: 'device must be 1 to 40 of a-z, 0-9 and -' });
  if (!Array.isArray(positions) || positions.length < 1 || positions.length > MAX_POSITIONS) return res.status(400).json({ error: `positions must hold 1 to ${MAX_POSITIONS} entries` });
  let rows;
  try { rows = await db.run(ZONES); } catch (e) {
    log.error('zones unavailable:', e.code ?? e.name);
    return res.status(503).json({ error: 'database unavailable' });
  }
  const zones = prepareZones(rows); // a private zone without a centre throws → 500: nothing is stored uncoarsened
  const received = new Date();
  const out = { stored: 0, duplicates: 0, skipped: [] };
  // The base zone as a circle: the phone sleeps inside it (GPS off) and lets iOS watch its edge. A base polygon
  // gives it no circle to watch, so it names none and the phone never sleeps.
  const base = rows.find((z) => z.ISBASE && z.KIND === 'circle' && z.RADIUSM != null && z.CENTRELAT != null && z.CENTRELON != null);
  if (base) out.home = { lat: Number(base.CENTRELAT), lon: Number(base.CENTRELON), radiusM: Number(base.RADIUSM) };
  let earliest = null;
  for (const [index, item] of positions.entries()) {
    const row = parse(`http/${device}`, JSON.stringify(item), received);
    if (!row) { out.skipped.push(index); continue; }
    const coarse = coarsen(row, zoneRow(zoneOf(row.lat, row.lon, zones)));
    let result = null;
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      try { result = await insertPosition(coarse, db); } catch (e) {
        // HANA down → 503: the phone resends, and what was stored comes back as duplicates. HANA up → a lock
        // wait or a dropped pooled connection passes, so the insert is tried once more; a second failure is the
        // position's fault, and it is skipped so it cannot block the phone's queue. Logged by code only.
        if (!(await up(db))) {
          log.error('database unavailable after', out.stored, 'stored of', positions.length, e.code ?? '');
          return res.status(503).json({ error: 'database unavailable' });
        }
        if (attempt === 2) log.error('position', index, 'not stored:', e.code ?? e.name);
      }
    }
    if (!result) { out.skipped.push(index); continue; }
    out[result === 'inserted' ? 'stored' : 'duplicates']++;
    if (!earliest || row.ts < earliest) earliest = row.ts;
  }
  // From the earliest usable position, duplicates included: a position stored by a request that then failed is
  // a duplicate on the resend, and only this schedules the rebuild of the trips it belongs to.
  if (earliest) schedule(device, earliest);
  if (out.skipped.length) log.warn(device, 'skipped', out.skipped.length, 'of', positions.length);
  log.info(device, 'positions', positions.length, 'stored', out.stored, 'duplicates', out.duplicates);
  res.json(out);
}

/** Register POST /positions: the workouts' token check before parsing, then a 1 MB JSON body. */
function mount(app, { token = process.env.HEALTH_TOKEN, db, schedule = runner.schedule } = {}) {
  app.post('/positions', auth(token), express.json({ limit: '1mb' }), (req, res) => handle(req, res, db ?? cds.db, schedule), onError);
}

module.exports = { mount };
