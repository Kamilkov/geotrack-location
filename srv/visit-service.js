'use strict';
const cds = require('@sap/cds');
const { uuidv5 } = require('./lib/ids');
const MAX_ATTEMPTS = cds.env.requires.queue?.maxAttempts ?? 10;

// CAP's remote client wraps HTTP errors as a plain Error with statusCode 502; the real
// status is in reason.response.status (e.code/e.status kept for other callers and fakes).
const httpStatus = (e) => e.reason?.response?.status ?? e.code ?? e.status;
// A4H answers a duplicate VisitUUID with 400 "The key value is already in use" (verified live), not 409.
const isExists = (e) => httpStatus(e) === 409 || /already (exists|in use)/i.test(e.message || '');
const isNotFound = (e) => httpStatus(e) === 404;
// A second close fails RAP feature control: 422 "Operation is not enabled".
const isClosed = (e) => httpStatus(e) === 422 || /not enabled|already closed/i.test(e.message || '');
const keyParts = (k) => { const [device, zone_ID, kind, at] = k.split('|'); return { device, zone_ID, kind, at }; };

function makeHandlers({ a4h, db }) {
  const setStatus = async (eventKey, status, visitID, err) => {
    const k = keyParts(eventKey);
    // A resegment may have superseded the event (or found it was only passed through) meanwhile; that status must stay.
    // reason.message carries the root cause ("fetch failed Caused by: connect ECONNREFUSED ...").
    if (err) await db.run(`UPDATE GEOTRACK_ZONEEVENTS SET ATTEMPTS = ATTEMPTS + 1, LASTERROR = ?, VISITSTATUS = CASE WHEN ATTEMPTS + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE DEVICE = ? AND ZONE_ID = ? AND KIND = ? AND "AT" = ? AND COALESCE(VISITSTATUS, '') NOT IN ('superseded', 'passthrough')`,
      [String(err.reason?.message ?? err.message).slice(0, 500), MAX_ATTEMPTS, k.device, k.zone_ID, k.kind, k.at]);
    else await db.run(`UPDATE GEOTRACK_ZONEEVENTS SET VISITSTATUS = '${status}', VISITID = ?, LASTERROR = NULL WHERE DEVICE = ? AND ZONE_ID = ? AND KIND = ? AND "AT" = ? AND COALESCE(VISITSTATUS, '') NOT IN ('superseded', 'passthrough')`,
      [visitID, k.device, k.zone_ID, k.kind, k.at]);
  };

  // A resegment can supersede (and a later one delete) an event while its call waits in the
  // queue; only a live row may still reach A4H.
  const isLive = async (eventKey) => {
    const k = keyParts(eventKey);
    const [ev] = await db.run(`SELECT VISITSTATUS FROM GEOTRACK_ZONEEVENTS WHERE DEVICE = ? AND ZONE_ID = ? AND KIND = ? AND "AT" = ?`, [k.device, k.zone_ID, k.kind, k.at]);
    const live = !!ev && !['superseded', 'passthrough'].includes(ev.VISITSTATUS);
    if (!live) cds.log('visit').info('skipping A4H call, event', ev ? ev.VISITSTATUS : 'deleted', eventKey);
    return live;
  };

  const create = async (d, enterKey) => {
    const VisitUUID = uuidv5(enterKey);
    try {
      await a4h.send({ method: 'POST', path: '/SiteVisit', data: { VisitUUID, ZoneExtID: d.zone_ID, ZoneName: d.zoneName ?? '', Device: d.device, ArrivedAt: new Date(d.at).toISOString(), ExtEventKey: enterKey } });
    } catch (e) { if (!isExists(e)) throw e; }
    return VisitUUID;
  };

  return {
    async createVisit(msg) {
      const d = msg.data;
      if (!(await isLive(d.eventKey))) return;
      try {
        const id = await create(d, d.eventKey);
        await setStatus(d.eventKey, 'created', id);
      } catch (e) { await setStatus(d.eventKey, null, null, e); throw e; }
    },
    async closeVisit(msg) {
      const d = msg.data;
      if (!(await isLive(d.eventKey))) return;
      const id = uuidv5(d.enterEventKey);
      try {
        const doClose = () => a4h.send({ method: 'POST', path: `/SiteVisit(${id})/SAP__self.close`, data: { DepartedAt: new Date(d.at).toISOString() } });
        try { await doClose(); }
        catch (e) {
          if (isClosed(e)) { /* already closed: done */ }
          else if (isNotFound(e)) { await create({ ...d, at: keyParts(d.enterEventKey).at }, d.enterEventKey); await doClose(); }
          else throw e;
        }
        await setStatus(d.eventKey, 'closed', id);
      } catch (e) { await setStatus(d.eventKey, null, null, e); throw e; }
    },
  };
}

module.exports = class VisitService extends cds.ApplicationService {
  async init() {
    const a4h = await cds.connect.to('a4h');
    // Own root tx per status write: the queue runs this handler inside a tx it rolls back
    // on error, which would otherwise discard the ATTEMPTS/LASTERROR update with it.
    const db = { run: (sql, params) => cds.tx((tx) => tx.run(sql, params)) };
    const h = makeHandlers({ a4h, db });
    this.on('createVisit', (msg) => h.createVisit(msg));
    this.on('closeVisit', (msg) => h.closeVisit(msg));
    await super.init();
  }
};
module.exports.makeHandlers = makeHandlers;
