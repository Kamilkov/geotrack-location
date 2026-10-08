'use strict';
const cds = require('@sap/cds');
const { segment, encodeMotion, decodeMotion } = require('./segmenter');
const { ACCEPTED_SQL, acceptedParams } = require('./accuracy');
const { haversineM } = require('./geo');
const { eventKey } = require('./ids');
const log = cds.log('segment');
const { utcDate } = require('./time');
const weather = require('./weather');
const { refreshTripRoute } = require('./trip-route');

const pending = new Map();   // device → { timer, minTS }
const DEBOUNCE_MS = 10000;
let srv;                     // IngestService, set by init()

// A device whose name starts with this is stored but never segmented: a trial next to the live device must
// not create trips, zone events, SiteVisits or weather calls of its own (scripts/compare-devices.js reads it).
const TRIAL_PREFIX = 'trial';
const isTrial = (device) => String(device ?? '').startsWith(TRIAL_PREFIX);
// smoke fixtures are segmented by their own script, never by a second process: not by the sweep, and not when
// one arrives here over MQTT or HTTPS
const isSmoke = (device) => String(device ?? '').startsWith('smoke');
const LIVE_DEVICES = `SELECT DISTINCT DEVICE FROM GEOTRACK_POSITIONS WHERE DEVICE NOT LIKE 'smoke%' AND DEVICE NOT LIKE '${TRIAL_PREFIX}%'`;

function init(service) { srv = service; }

// Per-device serialization: schedule()'s debounce timer, startTimer()'s 5-minute sweep,
// and a direct resegment() action call can all target the same device. Without a lock
// they can run concurrently and race on the same GEOTRACK_WATERMARKS/TRIPS/POSITIONS rows.
// Each device gets a single promise chain; `work` always runs even if the previous link
// rejected (`.then(work, work)`, not `.then(work)`), so a failed resegment doesn't
// permanently wedge later scheduled work for that device.
const running = new Map(); // device → in-flight chain tail
function serialize(device, work) {
  const prev = running.get(device) ?? Promise.resolve();
  const p = prev.then(work, work).finally(() => { if (running.get(device) === p) running.delete(device); });
  running.set(device, p);
  return p;
}

/** false when the device is never segmented here (a trial device, a smoke fixture). */
function schedule(device, ts) {
  if (isTrial(device) || isSmoke(device)) return false;
  const p = pending.get(device) || { timer: null, minTS: null };
  if (ts && (!p.minTS || ts < p.minTS)) p.minTS = ts;
  clearTimeout(p.timer);
  p.timer = setTimeout(() => { pending.delete(device); serialize(device, () => runSafeRaw(device, p.minTS)); }, DEBOUNCE_MS);
  pending.set(device, p);
  return true;
}

// `runSafeRaw`/`resegmentRaw`/`runRaw` are the actual implementations. They call each
// other directly (never through `serialize`) because by the time any of them runs it is
// already inside the current holder of that device's slot — re-entering `serialize` from
// inside itself would await a promise that can only settle after itself, i.e. deadlock.
// `run` and `resegment` (exported) are the public, serialized entry points.
async function runSafeRaw(device, minTS) {
  try {
    const settings = await loadSettings();
    const wm = await loadWatermark(device, settings);
    if (minTS && wm.segmentedThroughTS && minTS < wm.segmentedThroughTS) await resegmentRaw(device, minTS);
    else await runRaw(device);
  } catch (e) { log.error('segmentation failed for', device, e.message); }
}

async function loadSettings() {
  const [s] = await cds.db.run('SELECT STILLMINUTES, STILLRADIUSM, MINTRIPPOINTS, MAXACCURACYM, MODEMINUTES, STOPMINUTES, WALKMINM, GAPMINUTES, MAXACCURACYOUTSIDEM, MAXVERTICALACCURACYOUTSIDEM FROM GEOTRACK_SETTINGS WHERE ID = 1');
  if (!s) throw new Error('GEOTRACK_SETTINGS row 1 missing');
  return { stillMinutes: s.STILLMINUTES, stillRadiusM: s.STILLRADIUSM, minTripPoints: s.MINTRIPPOINTS, maxAccuracyM: s.MAXACCURACYM,
    modeMinutes: s.MODEMINUTES, stopMinutes: s.STOPMINUTES, walkMinM: s.WALKMINM, gapMinutes: s.GAPMINUTES,
    maxAccuracyOutsideM: s.MAXACCURACYOUTSIDEM, maxVerticalAccuracyOutsideM: s.MAXVERTICALACCURACYOUTSIDEM };
}

async function loadWatermark(device, settings) {
  const [w] = await cds.db.run('SELECT * FROM GEOTRACK_WATERMARKS WHERE DEVICE = ?', [device]);
  if (!w) return { segmentedThroughTS: null, openTrip: null, anchor: null, lastZone_ID: null, lastTS: null, motion: null };
  // MOTIONSTATE is an NCLOB: the driver may hand it back as a Buffer; null on rows written before it existed.
  const m = decodeMotion(w.MOTIONSTATE == null ? null : String(w.MOTIONSTATE));
  let openTrip = null;
  if (w.OPENTRIP_ID) {
    const [t] = await cds.db.run('SELECT ID, STARTEDAT, STARTZONE_ID FROM GEOTRACK_TRIPS WHERE ID = ?', [w.OPENTRIP_ID]);
    // Only reload points the segmenter would actually have kept — otherwise a
    // low-accuracy position the segmenter skipped re-enters the open trip's point
    // list on every reload, diverging further from what run() itself would compute.
    const pts = await cds.db.run(
      `SELECT TS, LAT, LON, ZONE_ID FROM GEOTRACK_POSITIONS WHERE TRIP_ID = ? AND ${ACCEPTED_SQL} ORDER BY TS`,
      [w.OPENTRIP_ID, ...acceptedParams(settings)]);
    if (t) {
      // Path length so far, summed step by step exactly as the segmenter does (walkMinM needs it).
      const cum = [];
      pts.forEach((r, i) => cum.push(i ? cum[i - 1] + haversineM({ lat: Number(pts[i - 1].LAT), lon: Number(pts[i - 1].LON) }, { lat: Number(r.LAT), lon: Number(r.LON) }) : 0));
      openTrip = { ID: t.ID, startedAt: utcDate(t.STARTEDAT), startZone_ID: t.STARTZONE_ID, points: pts.map((r) => utcDate(r.TS)), cum,
        out: pts.map((r) => t.STARTZONE_ID == null || (r.ZONE_ID ?? null) !== t.STARTZONE_ID), mode: m.openTripMode };
    }
  }
  const anchor = w.ANCHORTS ? { ts: utcDate(w.ANCHORTS), lat: Number(w.ANCHORLAT), lon: Number(w.ANCHORLON), zone_ID: w.LASTZONE_ID, moving: m.anchorMoving } : null;
  return {
    segmentedThroughTS: utcDate(w.SEGMENTEDTHROUGHTS),
    openTrip,
    anchor,
    // LASTTS is null only on rows written before the column existed: the anchor time is the best left.
    lastTS: utcDate(w.LASTTS) ?? anchor?.ts ?? null,
    lastZone_ID: w.LASTZONE_ID,
    motion: m.motion,
  };
}

async function runRaw(device) {
  const settings = await loadSettings();
  const wm = await loadWatermark(device, settings);
  const zones = new Map((await cds.db.run('SELECT ID, NAME, ISBASE, CREATESVISIT FROM GEOTRACK_ZONES')).map((z) => [z.ID, z]));
  const rows = await cds.db.run(
    `SELECT TS, LAT, LON, ACCURACY, VERTICALACCURACY, ZONE_ID, ACTIVITIES, TRIGGER FROM GEOTRACK_POSITIONS WHERE DEVICE = ? AND (? IS NULL OR TS > ?) ORDER BY TS`,
    [device, wm.segmentedThroughTS?.toISOString() ?? null, wm.segmentedThroughTS?.toISOString() ?? null]);
  if (!rows.length) return { events: [], trips: [] };
  const positions = rows.map((r) => {
    const z = zones.get(r.ZONE_ID);
    return { ts: utcDate(r.TS), lat: Number(r.LAT), lon: Number(r.LON), accuracy: r.ACCURACY, verticalAccuracy: r.VERTICALACCURACY, zone_ID: r.ZONE_ID,
      zoneIsBase: !!z?.ISBASE, zoneCreatesVisit: !!z?.CREATESVISIT, activities: r.ACTIVITIES, trigger: r.TRIGGER };
  });
  const state = { device, lastTS: wm.lastTS, lastZone_ID: wm.lastZone_ID, lastZoneIsBase: !!zones.get(wm.lastZone_ID)?.ISBASE,
    anchor: wm.anchor, openTrip: wm.openTrip, motion: wm.motion };
  const out = segment(positions, state, settings);
  // The persisted open trip was dropped (fewer than minTripPoints): it is neither closed nor still open.
  const dropped = wm.openTrip && !out.trips.some((t) => t.ID === wm.openTrip.ID) && out.state.openTrip?.ID !== wm.openTrip.ID ? wm.openTrip.ID : null;

  await cds.tx(async (tx) => {
    if (dropped) {
      await tx.run('UPDATE GEOTRACK_POSITIONS SET TRIP_ID = NULL WHERE TRIP_ID = ?', [dropped]);
      // The dropped trip's start fix can be the end fix of the trip closed where it split off
      // (a short walk after parking): a batch run never persists the dropped trip, so that fix
      // stays tagged to the closed trip. Give it back (NULL when no trip ends there, as it already is).
      const start = wm.openTrip.startedAt.toISOString();
      await tx.run('UPDATE GEOTRACK_POSITIONS SET TRIP_ID = (SELECT ID FROM GEOTRACK_TRIPS WHERE DEVICE = ? AND ENDEDAT = ?) WHERE DEVICE = ? AND TS = ?',
        [device, start, device, start]);
      await tx.run('DELETE FROM GEOTRACK_TRIPWEATHER WHERE TRIP_ID = ?', [dropped]);
      await tx.run('DELETE FROM GEOTRACK_TRIPS WHERE ID = ?', [dropped]);
    }
    for (const t of out.trips) await persistTrip(tx, device, t, true, settings);
    if (out.state.openTrip) await persistTrip(tx, device, out.state.openTrip, false, settings);
    const newEvents = [];
    for (const e of out.events) {
      // A stay never confirmed by a walking fix (drive-by, traffic jam) is recorded but never sent to A4H.
      // A row that was sent before this rule existed keeps its VISITID and becomes 'passthrough'.
      const pass = !!e.passThrough;
      const n = await tx.run(`UPDATE GEOTRACK_ZONEEVENTS SET POSITIONTS = ?${pass ? ", VISITSTATUS = 'passthrough'" : ''} WHERE DEVICE = ? AND ZONE_ID = ? AND KIND = ? AND "AT" = ?`,
        [e.positionTS.toISOString(), device, e.zone_ID, e.kind, e.at.toISOString()]);
      // @cap-js/hana's tx.run() returns { changes: N } for DML, not a bare number.
      if ((n?.changes ?? n) === 0) {
        await tx.run(`INSERT INTO GEOTRACK_ZONEEVENTS (DEVICE, ZONE_ID, KIND, "AT", POSITIONTS, ATTEMPTS, VISITSTATUS) VALUES (?, ?, ?, ?, ?, 0, ?)`,
          [device, e.zone_ID, e.kind, e.at.toISOString(), e.positionTS.toISOString(), pass ? 'passthrough' : null]);
        if (!pass) newEvents.push(e);
      }
    }
    const last = positions[positions.length - 1].ts;
    const s = out.state;
    await tx.run(`UPSERT GEOTRACK_WATERMARKS (DEVICE, SEGMENTEDTHROUGHTS, OPENTRIP_ID, ANCHORTS, ANCHORLAT, ANCHORLON, LASTZONE_ID, LASTTS, MOTIONSTATE) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) WITH PRIMARY KEY`,
      [device, last.toISOString(), s.openTrip?.ID ?? null, s.anchor?.ts.toISOString() ?? null, s.anchor?.lat ?? null, s.anchor?.lon ?? null, s.lastZone_ID, s.lastTS?.toISOString() ?? null, encodeMotion(s)]);
    out.newEvents = newEvents;
  });

  for (const e of out.newEvents) {
    const z = zones.get(e.zone_ID);
    const payload = { device, zone_ID: e.zone_ID, zoneName: z?.NAME, createsVisit: !!z?.CREATESVISIT, at: e.at, eventKey: eventKey({ device, zone_ID: e.zone_ID, kind: e.kind, at: e.at }) };
    try {
      await srv.emit(e.kind === 'enter' ? 'ZoneEntered' : 'ZoneLeft', payload);
    } catch (err) {
      // The row is already committed with VISITSTATUS still null, so `retryVisit(eventKey)`
      // can re-enqueue later — record the failure instead of dropping it silently.
      log.error('emit failed for', payload.eventKey, err.message);
      try {
        await cds.db.run(`UPDATE GEOTRACK_ZONEEVENTS SET LASTERROR = ? WHERE DEVICE = ? AND ZONE_ID = ? AND KIND = ? AND "AT" = ?`,
          [String(err.message ?? err).slice(0, 500), device, e.zone_ID, e.kind, e.at.toISOString()]);
      } catch (err2) { log.error('failed to record LASTERROR for', payload.eventKey, err2.message); }
    }
  }
  if (out.trips.length) weather.enrichMissing().catch((e) => log.warn('weather enrichment failed:', e.message));
  log.info(device, 'segmented', positions.length, 'positions →', out.events.length, 'events,', out.trips.length, 'closed trips');
  return out;
}

async function persistTrip(tx, device, t, closed, settings) {
  await tx.run(`UPSERT GEOTRACK_TRIPS (ID, DEVICE, STARTEDAT, ENDEDAT, STARTZONE_ID, ENDZONE_ID, POINTCOUNT) VALUES (?, ?, ?, ?, ?, ?, ?) WITH PRIMARY KEY`,
    [t.ID, device, t.startedAt.toISOString(), closed ? t.endedAt.toISOString() : null, t.startZone_ID, closed ? t.endZone_ID : null, t.points.length]);
  if (closed) {
    // Trip IDs are deterministic from the start time: a resegment that changes the end would
    // keep stale weather hours, so a close always clears them; enrichMissing refetches.
    await tx.run('DELETE FROM GEOTRACK_TRIPWEATHER WHERE TRIP_ID = ?', [t.ID]);
    await tx.run(`UPDATE GEOTRACK_TRIPS SET WEATHERCODE = NULL, WEATHERTEXT = NULL, TEMPERATUREC = NULL, APPARENTTEMPERATUREC = NULL,
        PRECIPITATIONMM = NULL, WINDKMH = NULL, WEATHERFETCHEDAT = NULL, WEATHERATTEMPTS = 0, WEATHERATTEMPTEDAT = NULL, WEATHERERROR = NULL WHERE ID = ?`, [t.ID]);
  }
  // A stillness close ends the trip at the anchor, before the still fixes an earlier run tagged
  // while it was open: untag that tail so the metrics below only see the trip's own points.
  if (closed) await tx.run('UPDATE GEOTRACK_POSITIONS SET TRIP_ID = NULL WHERE TRIP_ID = ? AND TS > ?', [t.ID, t.endedAt.toISOString()]);
  // Only tag positions the segmenter actually kept — a position it skipped for low
  // accuracy still falls inside [startedAt, endedAt] by time, but must not be tagged,
  // or LENGTHM/ROUTEWKT/KIND (computed FROM the tagged rows) diverge from what the
  // segmenter itself saw, and a reload would hand the open trip a point count the
  // segmenter never produced.
  await tx.run(`UPDATE GEOTRACK_POSITIONS SET TRIP_ID = ? WHERE DEVICE = ? AND TS >= ? AND TS <= ? AND ${ACCEPTED_SQL}`,
    [t.ID, device, t.startedAt.toISOString(), (closed ? t.endedAt : t.points[t.points.length - 1]).toISOString(), ...acceptedParams(settings)]);
  if (closed) {
    await tx.run(`UPDATE GEOTRACK_TRIPS SET
        DURATIONMIN = ROUND(SECONDS_BETWEEN(STARTEDAT, ENDEDAT) / 60),
        KIND = (SELECT CASE WHEN MEDIAN(VELOCITY) <= 7 THEN 'walk' WHEN MEDIAN(VELOCITY) >= 20 THEN 'drive' ELSE 'unknown' END FROM GEOTRACK_POSITIONS WHERE TRIP_ID = ? AND VELOCITY IS NOT NULL)
      WHERE ID = ?`, [t.ID, t.ID]);
    // Length and line: from the Watch route where a workout recorded one, else from these positions.
    await refreshTripRoute(tx, t.ID, settings, { atClose: true });
    // The segmenter knows the travel mode; the median-speed KIND above is only the fallback.
    if (t.kind) await tx.run('UPDATE GEOTRACK_TRIPS SET KIND = ? WHERE ID = ?', [t.kind, t.ID]);
  }
}

/** Recompute from fromTS (moved back to the latest trip start before it, then over any trip or visit-zone stay spanning it). */
async function resegmentRaw(device, fromTS) {
  const settings = await loadSettings();
  let cut = utcDate(fromTS);
  // A cut past the watermark would reset it past positions never segmented, skipping them for good.
  const [w] = await cds.db.run('SELECT SEGMENTEDTHROUGHTS FROM GEOTRACK_WATERMARKS WHERE DEVICE = ?', [device]);
  const through = utcDate(w?.SEGMENTEDTHROUGHTS);
  if (through && cut.getTime() > through.getTime() + 1) cut = new Date(through.getTime() + 1);
  // Start at the latest trip start before the cut: a trip can be closed after the fact (a stop
  // ends a drive at its last drive fix minutes later; a dropped walk leaves no row), so a cut
  // past a trip's ENDEDAT can still fall inside the stretch the segmenter was deciding.
  const [latest] = await cds.db.run('SELECT MAX(STARTEDAT) S FROM GEOTRACK_TRIPS WHERE DEVICE = ? AND STARTEDAT < ?', [device, cut.toISOString()]);
  if (latest?.S) cut = utcDate(latest.S);
  // From there only move earlier, to cover trips and visit-zone stays that span the cut: the
  // segmenter only confirms a stay it saw begin, and the trip that arrived at that stay ends at
  // its first fix, so moving to a stay can put the cut on a trip's end — which the next pass
  // then covers. Both moves only go earlier, so the loop ends.
  const visitZones = new Set((await cds.db.run('SELECT ID FROM GEOTRACK_ZONES WHERE CREATESVISIT = TRUE AND COALESCE(ISBASE, FALSE) = FALSE')).map((z) => z.ID));
  for (let moved = true; moved;) {
    moved = false;
    const [cover] = await cds.db.run(`SELECT MIN(STARTEDAT) S FROM GEOTRACK_TRIPS WHERE DEVICE = ? AND (ENDEDAT IS NULL OR ENDEDAT >= ?)`, [device, cut.toISOString()]);
    const coverS = utcDate(cover?.S);
    if (coverS && coverS < cut) { cut = coverS; moved = true; }
    const [before] = await cds.db.run(`SELECT TOP 1 TS, ZONE_ID FROM GEOTRACK_POSITIONS WHERE DEVICE = ? AND TS < ? AND ${ACCEPTED_SQL} ORDER BY TS DESC`,
      [device, cut.toISOString(), ...acceptedParams(settings)]);
    if (before && visitZones.has(before.ZONE_ID)) {
      const [edge] = await cds.db.run(`SELECT MAX(TS) T FROM GEOTRACK_POSITIONS WHERE DEVICE = ? AND TS < ? AND ${ACCEPTED_SQL} AND (ZONE_ID IS NULL OR ZONE_ID <> ?)`,
        [device, utcDate(before.TS).toISOString(), ...acceptedParams(settings), before.ZONE_ID]);
      const [first] = await cds.db.run(`SELECT MIN(TS) T FROM GEOTRACK_POSITIONS WHERE DEVICE = ? AND TS > ? AND ZONE_ID = ? AND ${ACCEPTED_SQL}`,
        [device, utcDate(edge?.T)?.toISOString() ?? '1970-01-01T00:00:00.000Z', before.ZONE_ID, ...acceptedParams(settings)]);
      const stayStart = utcDate(first?.T);
      if (stayStart && stayStart < cut) { cut = stayStart; moved = true; }
    }
  }
  const cutIso = cut.toISOString();
  await cds.tx(async (tx) => {
    await tx.run(`UPDATE GEOTRACK_POSITIONS SET TRIP_ID = NULL WHERE DEVICE = ? AND TS >= ?`, [device, cutIso]);
    // Trips first, weather second: fetchTrip/persistTrip both lock the trip row before touching
    // TripWeather, so deleting trips first takes the same lock in the same order — a concurrent
    // fetch then either commits its weather rows before this DELETE proceeds (cleaned up by the
    // uncorrelated NOT IN below) or blocks behind this transaction and finds the trip already
    // gone. The old order (weather, then trips) could delete weather rows before a same-tx fetch
    // commit, leaving its just-written rows orphaned once the trip DELETE went through.
    await tx.run(`DELETE FROM GEOTRACK_TRIPS WHERE DEVICE = ? AND STARTEDAT >= ?`, [device, cutIso]);
    await tx.run(`DELETE FROM GEOTRACK_TRIPWEATHER WHERE TRIP_ID NOT IN (SELECT ID FROM GEOTRACK_TRIPS)`);
    // Keep every event that ever reached A4H (VISITID set) or is in flight; recompute the rest.
    await tx.run(`DELETE FROM GEOTRACK_ZONEEVENTS WHERE DEVICE = ? AND "AT" >= ? AND VISITID IS NULL AND (VISITSTATUS IS NULL OR VISITSTATUS NOT IN ('created','closed','pending'))`, [device, cutIso]);
    // Reset the watermark to the position just before the cut, not just its zone — an
    // anchor of null paired with a real LASTZONE_ID is the inconsistent state that made
    // the segmenter crash on the very next zone change (state.lastTS null, at.toISOString()).
    // Only a position the segmenter would have accepted: a skipped low-accuracy fix as the
    // anchor would open a phantom trip on the next accurate one. Motion state restarts from the previous
    // fix (its lastPoint, or the next trip's first step would count 0 m where a batch run counts the step).
    const [prev] = await tx.run(`SELECT TOP 1 TS, LAT, LON, ZONE_ID FROM GEOTRACK_POSITIONS WHERE DEVICE = ? AND TS < ? AND ${ACCEPTED_SQL} ORDER BY TS DESC`,
      [device, cutIso, ...acceptedParams(settings)]);
    const prevIso = prev ? utcDate(prev.TS).toISOString() : null;
    await tx.run(`UPSERT GEOTRACK_WATERMARKS (DEVICE, SEGMENTEDTHROUGHTS, OPENTRIP_ID, ANCHORTS, ANCHORLAT, ANCHORLON, LASTZONE_ID, LASTTS, MOTIONSTATE) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?) WITH PRIMARY KEY`,
      [device, new Date(cut.getTime() - 1).toISOString(), prevIso, prev ? Number(prev.LAT) : null, prev ? Number(prev.LON) : null, prev?.ZONE_ID ?? null, prevIso,
        prev ? JSON.stringify({ lastPoint: { lat: Number(prev.LAT), lon: Number(prev.LON) } }) : null]);
  });
  const out = await runRaw(device);
  // sent events not produced again → superseded
  const keys = new Set(out.events.map((e) => `${e.zone_ID}|${e.kind}|${e.at.toISOString()}`));
  const sent = await cds.db.run(`SELECT ZONE_ID, KIND, "AT" FROM GEOTRACK_ZONEEVENTS WHERE DEVICE = ? AND "AT" >= ? AND VISITSTATUS IN ('created','closed','pending')`, [device, cutIso]);
  for (const s of sent) {
    const sAt = utcDate(s.AT).toISOString();
    if (!keys.has(`${s.ZONE_ID}|${s.KIND}|${sAt}`))
      await cds.db.run(`UPDATE GEOTRACK_ZONEEVENTS SET VISITSTATUS = 'superseded' WHERE DEVICE = ? AND ZONE_ID = ? AND KIND = ? AND "AT" = ?`, [device, s.ZONE_ID, s.KIND, sAt]);
  }
  return `resegmented ${device} from ${cutIso}: ${out.events.length} events, ${out.trips.length} closed trips`;
}

// Closed trips whose window can hold a Watch point of a workout from..to. Inclusive, like the window
// in which the close reads Watch points (srv/lib/trip-route.js).
const OVERLAPPING = 'SELECT ID FROM GEOTRACK_TRIPS WHERE DEVICE = ? AND ENDEDAT IS NOT NULL AND STARTEDAT <= ? AND ENDEDAT >= ?';

/**
 * Rebuild length and line of the closed trips that overlap from..to (a workout's start and end). The lookup
 * runs inside the device's queue too: a segment run that is closing such a trip has committed before it.
 * One transaction per trip; a trip that fails is logged and the others go on.
 */
function refreshRoutes(device, from, to) {
  return serialize(device, async () => {
    const settings = await loadSettings();
    const trips = await cds.db.run(OVERLAPPING, [device, to, from]);
    for (const t of trips) {
      try { await cds.tx((tx) => refreshTripRoute(tx, t.ID, settings)); }
      catch (e) { log.error('trip', t.ID, 'route not refreshed:', e.code ?? e.name); }
    }
  });
}

function run(device) { return serialize(device, () => runRaw(device)); }
function resegment(device, fromTS) {
  const from = utcDate(fromTS);
  if (!device || !from || isNaN(from)) return Promise.reject(Object.assign(new Error('resegment needs a device and a valid fromTS'), { status: 400 }));
  if (isTrial(device)) return Promise.reject(Object.assign(new Error('trial devices are not segmented'), { status: 400 }));
  return serialize(device, () => resegmentRaw(device, from));
}

function startTimer(everyMs = 300000) {
  cds.spawn({ every: everyMs }, async () => {
    // Catch here: cds.spawn shuts the whole server down on a TypeError-class error, and the
    // hdb driver throws one when HANA is unreachable by IP (TLS servername), killing ingest.
    let devices;
    try { devices = await cds.db.run(LIVE_DEVICES); }
    catch (e) { return log.error('segment sweep skipped:', e.message); }
    for (const d of devices) await serialize(d.DEVICE, () => runSafeRaw(d.DEVICE, null));
    try { await weather.enrichMissing(); } catch (e) { log.error('weather sweep skipped:', e.message); }
  });
}

module.exports = { init, schedule, run, resegment, refreshRoutes, startTimer, utcDate, isTrial, LIVE_DEVICES, loadSettings };
