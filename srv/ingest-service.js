'use strict';
const cds = require('@sap/cds');
const { circleToWkt } = require('./lib/geo');

module.exports = class IngestService extends cds.ApplicationService {
  async init() {
    const { Zones, Photos } = this.entities;

    const runner = require('./lib/segment-runner');
    const { utcDate } = runner;
    const ids = require('./lib/ids');
    runner.init(this);
    this.on('resegment', (req) => runner.resegment(req.data.device, req.data.fromTS));

    // Zone event → queued VisitService call. The 'pending' mark and the outbox row are written
    // in the same (current) transaction, so an event is never marked without being enqueued.
    const enqueueVisit = async ({ device, zone_ID, kind, at, zoneName, eventKey }) => {
      const visits = cds.queued(await cds.connect.to('VisitService'));
      const atIso = new Date(at).toISOString();
      let enterEventKey;
      if (kind === 'leave') {
        const [prev] = await cds.db.run(`SELECT TOP 1 "AT" FROM GEOTRACK_ZONEEVENTS WHERE DEVICE = ? AND ZONE_ID = ? AND KIND = 'enter' AND "AT" <= ? AND (VISITSTATUS IS NULL OR VISITSTATUS NOT IN ('superseded', 'passthrough')) ORDER BY "AT" DESC`, [device, zone_ID, atIso]);
        if (!prev) return false;
        enterEventKey = ids.eventKey({ device, zone_ID, kind: 'enter', at: utcDate(prev.AT) });
      }
      await cds.db.run(`UPDATE GEOTRACK_ZONEEVENTS SET VISITSTATUS = 'pending', ATTEMPTS = 0 WHERE DEVICE = ? AND ZONE_ID = ? AND KIND = ? AND "AT" = ?`, [device, zone_ID, kind, atIso]);
      if (kind === 'enter') await visits.emit('createVisit', { eventKey, device, zone_ID, zoneName, at });
      else await visits.emit('closeVisit', { eventKey, enterEventKey, device, zone_ID, zoneName, at });
      return true;
    };
    this.on('ZoneEntered', (msg) => msg.data.createsVisit && enqueueVisit({ ...msg.data, kind: 'enter' }));
    this.on('ZoneLeft', (msg) => msg.data.createsVisit && enqueueVisit({ ...msg.data, kind: 'leave' }));
    this.on('retryVisit', async (req) => {
      const [device, zone_ID, kind, at] = String(req.data.eventKey).split('|');
      if (!/^(enter|leave)$/.test(kind) || isNaN(Date.parse(at))) return req.reject(400, 'eventKey must be device|zone_ID|enter or leave|ISO time');
      const [ev] = await cds.db.run(`SELECT E."AT", E.VISITSTATUS, Z.NAME, Z.CREATESVISIT FROM GEOTRACK_ZONEEVENTS E LEFT JOIN GEOTRACK_ZONES Z ON Z.ID = E.ZONE_ID WHERE E.DEVICE = ? AND E.ZONE_ID = ? AND E.KIND = ? AND E."AT" = ?`, [device, zone_ID, kind, new Date(at).toISOString()]);
      if (!ev) return req.reject(404, `no zone event ${req.data.eventKey}`);
      // Rebuild the key from the stored row: the VisitUUID is uuidv5(eventKey), so a caller's
      // differently formatted timestamp would otherwise create a second SiteVisit.
      const evAt = utcDate(ev.AT), eventKey = ids.eventKey({ device, zone_ID, kind, at: evAt });
      if (ev.VISITSTATUS === 'superseded') return req.reject(409, `${eventKey} was superseded by a resegment`);
      if (ev.VISITSTATUS === 'passthrough') return req.reject(409, `${eventKey} was only passed through, not a visit`);
      if (!ev.CREATESVISIT) return `not retried: zone of ${eventKey} does not create visits`;
      if (!(await enqueueVisit({ device, zone_ID, kind, at: evAt, zoneName: ev.NAME, eventKey }))) return req.reject(409, `no enter event before ${eventKey}`);
      return `re-enqueued ${eventKey}`;
    });

    const weather = require('./lib/weather');
    this.on('refetchWeather', async (req) => {
      const [t] = await cds.db.run('SELECT ID, ENDEDAT FROM GEOTRACK_TRIPS WHERE ID = ?', [req.data.tripID]);
      if (!t) return req.reject(404, `no trip ${req.data.tripID}`);
      if (!t.ENDEDAT) return req.reject(409, `trip ${t.ID} is still open`);
      // Plain cds.db.run() here would join the still-open request transaction: the reset UPDATE's
      // row lock would then sit uncommitted while fetchTrip's own db.tx(...) (a separate root tx)
      // waits on that same row — a self-deadlock until HANA's lock-wait timeout. Each gets its own
      // committed root transaction instead, and fetchTrip's bookkeeping survives a later req.reject
      // (which only rolls back the request's own, otherwise-empty, transaction).
      await cds.tx((tx) => tx.run('UPDATE GEOTRACK_TRIPS SET WEATHERATTEMPTS = 0, WEATHERATTEMPTEDAT = NULL WHERE ID = ?', [t.ID]));
      // No wrapping root tx needed here: fetchTrip's own reads join the request's ambient
      // transaction (harmless — reads take no locks), and both its success and its failure
      // write (see weather.js) already open their own root tx via db.tx(...).
      const r = await weather.fetchTrip(t.ID);
      if (!r.ok) return req.reject(502, r.error);
      return r.text;
    });

    // Photos arrive only through POST /photos (the privacy decision lives there); OData may read and delete them.
    this.before(['CREATE', 'UPDATE'], Photos, (req) => req.reject(405, 'photos arrive through POST /photos only'));

    this.before(['CREATE', 'UPDATE'], Zones, async (req) => {
      // CAP's UPDATE req.data holds only the fields actually sent (a PATCH).
      // Validate/recompute against the full row-as-it-will-be, not just the delta,
      // so a partial update (e.g. radiusM alone) doesn't skip wkt recomputation.
      let z = req.data;
      if (req.event === 'UPDATE') {
        const id = req.data.ID ?? req.params[0]?.ID ?? req.params[0];
        const stored = await SELECT.one.from(Zones).where({ ID: id });
        z = { ...stored, ...req.data };
      }
      if (z.isPrivate && (z.centreLat == null || z.centreLon == null)) {
        req.reject(400, 'private zones need centreLat and centreLon (coarsening target)');
      }
      if (z.kind === 'circle') {
        if (z.centreLat == null || z.centreLon == null || !(z.radiusM > 0)) req.reject(400, 'circle needs centreLat, centreLon, radiusM > 0');
        req.data.wkt = circleToWkt(Number(z.centreLat), Number(z.centreLon), z.radiusM);
      } else if (z.kind === 'polygon') {
        if (!/^POLYGON\s*\(\(/i.test(z.wkt || '')) req.reject(400, 'polygon needs wkt starting with POLYGON((');
      } else {
        req.reject(400, 'kind must be circle or polygon');
      }
    });

    this.after(['CREATE', 'UPDATE'], Zones, async (data, req) => {
      const id = data.ID || req.data.ID;
      const [{ WKT }] = await cds.db.run('SELECT WKT FROM GEOTRACK_ZONES WHERE ID = ?', [id]);
      if (WKT) await cds.db.run('UPDATE GEOTRACK_ZONES SET GEOM = ST_GeomFromText(?, 4326) WHERE ID = ?', [WKT, id]);
    });

    await super.init();
  }
};
