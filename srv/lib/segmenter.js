'use strict';
const { haversineM } = require('./geo');
const { uuidv5 } = require('./ids');
const { accuracyLimits, accepted } = require('./accuracy');

/** iOS motion activities ("stationary,automotive") → 'drive' | 'foot' | 'still' | null */
function classOf(activities) {
  if (!activities) return null;
  const a = String(activities).split(',').map((s) => s.trim());
  if (a.includes('automotive')) return 'drive';
  if (a.some((x) => x === 'walking' || x === 'running' || x === 'cycling')) return 'foot';
  if (a.includes('stationary')) return 'still';
  return null;
}

const emptyMotion = () => ({ driveRun: null, footRun: null, stillRun: null, lastDrive: null, stay: null, lastPoint: null });

// Persistable motion state: everything the segmenter needs between runs that the Watermarks
// columns and the reloaded open trip do not carry. Dates travel as ISO strings.
const DATE_KEYS = new Set(['since', 'latest', 'ts', 'startTS']);
function encodeMotion(state) {
  return JSON.stringify({ ...state.motion, openTripMode: state.openTrip?.mode ?? null, anchorMoving: !!state.anchor?.moving });
}
function decodeMotion(json) {
  if (!json) return { motion: emptyMotion(), openTripMode: null, anchorMoving: false };
  const { openTripMode = null, anchorMoving = false, ...motion } = JSON.parse(json, (k, v) => (DATE_KEYS.has(k) && typeof v === 'string' ? new Date(v) : v));
  return { motion: { ...emptyMotion(), ...motion }, openTripMode, anchorMoving };
}

/**
 * Pure segmentation of one device's positions (ascending ts) into zone events and trips. No I/O.
 * Position: { ts, lat, lon, accuracy, zone_ID, zoneIsBase, zoneCreatesVisit, activities }.
 * State: { device, lastTS, lastZone_ID, lastZoneIsBase, anchor{ts,lat,lon,zone_ID,moving},
 *          openTrip{ID,startedAt,startZone_ID,points[],cum[],mode}, motion{...} }.
 */
function segment(positions, state, settings) {
  const st = {
    device: state.device, lastTS: state.lastTS ?? null, lastZone_ID: state.lastZone_ID ?? null,
    lastZoneIsBase: !!state.lastZoneIsBase,
    anchor: state.anchor ? { moving: false, ...state.anchor } : null,
    openTrip: state.openTrip ? { mode: null, ...state.openTrip, points: [...state.openTrip.points], cum: [...(state.openTrip.cum ?? state.openTrip.points.map(() => 0))],
      out: [...(state.openTrip.out ?? state.openTrip.points.map(() => true))] } : null,
    motion: { ...emptyMotion(), ...structuredClone(state.motion ?? {}) },
  };
  const m = st.motion;
  const events = [], trips = [];
  const stillMs = settings.stillMinutes * 60000, modeMs = settings.modeMinutes * 60000, stopMs = settings.stopMinutes * 60000;
  const gapMs = settings.gapMinutes ? settings.gapMinutes * 60000 : Infinity;
  const limits = accuracyLimits(settings);

  const openTrip = (startedAt, startZone_ID, mode = null) => {
    // A new (non-split) trip measures its mode and stops from its own fixes only.
    if (!mode) {
      if (m.driveRun && m.driveRun.since < startedAt) m.driveRun = null;
      if (m.footRun && m.footRun.since < startedAt) m.footRun = null;
      if (m.stillRun && m.stillRun.since <= startedAt) m.stillRun = null;
    }
    // `out`: per point, whether it lies outside the zone the trip set out from; only those are evidence of a trip.
    st.openTrip = { ID: uuidv5(`${st.device}|${startedAt.toISOString()}`), startedAt, startZone_ID: startZone_ID ?? null, points: [startedAt], cum: [0], out: [startZone_ID == null], mode };
  };
  // A trip needs minTripPoints positions outside the zone it set out from, wherever it ends: a single stray
  // position outside Home, or two junk fixes before a silence, are no trip.
  const closeTrip = (endedAt, endZone_ID) => {
    const t = st.openTrip; st.openTrip = null;
    const n = t.points.filter((x) => x <= endedAt).length;
    const points = t.points.slice(0, n), lengthM = n ? t.cum[n - 1] : 0;
    if (t.out.slice(0, n).filter(Boolean).length < settings.minTripPoints) return;
    if (t.mode === 'foot' && lengthM < settings.walkMinM) return;
    trips.push({ ID: t.ID, startedAt: t.startedAt, endedAt, startZone_ID: t.startZone_ID, endZone_ID: endZone_ID ?? null, points,
      kind: t.mode === 'drive' ? 'drive' : t.mode === 'foot' ? 'walk' : null });
  };
  // Close the open trip at `at` and continue its later points in a new trip of `mode` starting there.
  const split = (at, zone_ID, mode) => {
    const t = st.openTrip;
    const k = t.points.filter((x) => x <= at).length;
    const base = k ? t.cum[k - 1] : 0;
    // The tail keeps its flags, judged against the old start zone: a split happens on the move, outside zones.
    const tailPts = t.points.slice(k), tailCum = t.cum.slice(k).map((c) => c - base), tailOut = t.out.slice(k);
    closeTrip(at, zone_ID);
    openTrip(at, zone_ID, mode);
    st.openTrip.points.push(...tailPts); st.openTrip.cum.push(...tailCum); st.openTrip.out.push(...tailOut);
  };
  const setAnchor = (p, zone) => { st.anchor = { ts: p.ts, lat: p.lat, lon: p.lon, zone_ID: zone, moving: false }; };
  const confirmed = (run) => run && run.latest - run.since >= modeMs;
  // Where a trip that has stopped ends: a drive at its last drive fix, once a still or on-foot fix followed it;
  // any other trip where the still run began (at the trip's start at the earliest). Null without such evidence.
  const stopEnd = (tr) => {
    if (tr.mode === 'drive' && m.lastDrive && m.lastDrive.ts >= tr.startedAt && (m.stillRun || m.footRun)) return m.lastDrive;
    return m.stillRun && { ts: m.stillRun.since < tr.startedAt ? tr.startedAt : m.stillRun.since, zone_ID: m.stillRun.zone_ID };
  };

  for (const p of positions) {
    if (!accepted(p, limits)) continue;   // by where it lies: see accuracy.js
    const zone = p.zone_ID ?? null;
    const c = classOf(p.activities);
    const prevTS = st.lastTS ?? p.ts;

    // --- silence: more than gapMinutes since the last accepted position is not bridged. The open trip ends
    // at that position, or where it had stopped before the phone fell silent, and the position that ends the
    // silence becomes the anchor, so no trip starts before it.
    // The drive and foot runs end too: a run that began before the silence would take this fix into itself, and
    // the trip that opens here would then drop the run, and with it its own first fix, as older than the trip.
    // (A still run needs no reset: a new trip drops every still run that began at or before its start.)
    const gap = st.lastTS != null && p.ts - st.lastTS > gapMs;
    // Home sleep: the phone keeps its GPS off inside the base zone and iOS wakes it at the zone's edge; that first
    // fix carries OwnTracks' region trigger "c". The silence before it was the sleep, not a gap in a trip: Home is
    // left at this fix, and the trip starts here, from Home.
    const wake = gap && p.trigger === 'c' && st.lastZoneIsBase && zone !== st.lastZone_ID;
    if (gap) {
      if (st.openTrip) {
        const end = stopEnd(st.openTrip) || { ts: st.lastTS, zone_ID: st.lastZone_ID };
        closeTrip(end.ts, end.zone_ID);
      }
      setAnchor(p, zone);
      m.driveRun = null; m.footRun = null;
    }

    // --- zone transitions
    if (zone !== st.lastZone_ID) {
      if (st.lastZone_ID != null) {
        if (m.stay && m.stay.zone_ID === st.lastZone_ID) {
          if (m.stay.confirmed) {
            events.push({ kind: 'leave', zone_ID: st.lastZone_ID, at: prevTS, positionTS: p.ts });
            if (!st.openTrip && !gap) { openTrip(prevTS, st.lastZone_ID); setAnchor(p, zone); }
          } else {
            events.push({ kind: 'enter', zone_ID: m.stay.zone_ID, at: m.stay.startTS, positionTS: m.stay.startTS, passThrough: true });
            events.push({ kind: 'leave', zone_ID: m.stay.zone_ID, at: prevTS, positionTS: p.ts, passThrough: true });
          }
          m.stay = null;
        } else {
          events.push({ kind: 'leave', zone_ID: st.lastZone_ID, at: wake ? p.ts : prevTS, positionTS: p.ts });
          // Restart the stillness clock on a base leave: after a long stay the anchor is the entry position.
          if (st.lastZoneIsBase && !st.openTrip && (!gap || wake)) { openTrip(wake ? p.ts : prevTS, st.lastZone_ID); setAnchor(p, zone); }
        }
      }
      if (zone != null) {
        if (p.zoneCreatesVisit && !p.zoneIsBase) m.stay = { zone_ID: zone, startTS: p.ts, confirmed: false };
        else events.push({ kind: 'enter', zone_ID: zone, at: p.ts, positionTS: p.ts });
      }
    }
    const inConfirmedStay = m.stay?.confirmed && m.stay.zone_ID === zone;

    // --- movement: open a trip (never on a still fix, never inside Home or a confirmed stay)
    if (!st.anchor) setAnchor(p, zone);
    else if (haversineM(st.anchor, p) > settings.stillRadiusM) {
      if (!st.openTrip && !p.zoneIsBase && !inConfirmedStay && c !== 'still') openTrip(st.lastTS ?? st.anchor.ts, st.lastZone_ID);
      setAnchor(p, zone);
    }
    if (st.openTrip && st.openTrip.points[st.openTrip.points.length - 1] < p.ts) {
      st.openTrip.points.push(p.ts);
      st.openTrip.cum.push(st.openTrip.cum[st.openTrip.cum.length - 1] + (m.lastPoint ? haversineM(m.lastPoint, p) : 0));
      st.openTrip.out.push(st.openTrip.startZone_ID == null || zone !== st.openTrip.startZone_ID);
    }
    // --- entering Home closes the open trip (closeTrip drops it unless enough positions lay outside its start zone).
    if (zone !== st.lastZone_ID && zone != null && p.zoneIsBase && st.openTrip) {
      closeTrip(p.ts, zone);
      setAnchor(p, zone);
    }

    // --- a walking fix inside a visit zone confirms the stay: the trip ends at arrival
    if (m.stay && !m.stay.confirmed && m.stay.zone_ID === zone && c === 'foot') {
      m.stay.confirmed = true;
      events.push({ kind: 'enter', zone_ID: zone, at: m.stay.startTS, positionTS: p.ts });
      if (st.openTrip) closeTrip(m.stay.startTS < st.openTrip.startedAt ? st.openTrip.startedAt : m.stay.startTS, zone);
      setAnchor(p, zone);
    }

    // --- motion runs: drive and foot break each other; still is neutral for them; unknown is neutral for all
    const here = { ts: p.ts, zone_ID: zone }, before = { ts: prevTS, zone_ID: st.lastZone_ID };
    if (c === 'drive') { m.driveRun = m.driveRun ? { ...m.driveRun, latest: p.ts } : { since: p.ts, latest: p.ts, before }; m.footRun = null; m.stillRun = null; m.lastDrive = here; }
    if (c === 'foot') { m.footRun = m.footRun ? { ...m.footRun, latest: p.ts } : { since: p.ts, latest: p.ts, before }; m.driveRun = null; m.stillRun = null; }
    if (c === 'still') m.stillRun = m.stillRun ? { ...m.stillRun, latest: p.ts } : { since: p.ts, latest: p.ts, zone_ID: zone };

    // --- mode confirmation: adopt, or split at the last fix of the old mode
    const t = st.openTrip;
    if (t && confirmed(m.driveRun)) {
      if (!t.mode) t.mode = 'drive';
      else if (t.mode === 'foot') split(m.driveRun.before.ts < t.startedAt ? t.startedAt : m.driveRun.before.ts, m.driveRun.before.ts < t.startedAt ? t.startZone_ID : m.driveRun.before.zone_ID, 'drive');
    } else if (t && confirmed(m.footRun)) {
      if (!t.mode) t.mode = 'foot';
      else if (t.mode === 'drive') split(m.lastDrive && m.lastDrive.ts > t.startedAt ? m.lastDrive.ts : t.startedAt, m.lastDrive && m.lastDrive.ts > t.startedAt ? m.lastDrive.zone_ID : t.startZone_ID, 'foot');
    }

    // --- stop: still for stopMinutes (counted from the trip's start at the earliest)
    if (st.openTrip && m.stillRun) {
      const tr = st.openTrip;
      const since = m.stillRun.since < tr.startedAt ? tr.startedAt : m.stillRun.since;
      if (m.stillRun.latest - since >= stopMs) {
        const end = stopEnd(tr);
        closeTrip(end.ts, end.zone_ID);
        setAnchor(p, zone);
      }
    }

    // --- fallback without motion evidence: stillMinutes within stillRadiusM closes at the anchor.
    // Judged on evidence gathered BEFORE this fix — the fix that ends a silent gap must not also
    // be the evidence that excuses the gap it ends.
    if (st.openTrip && !st.anchor.moving && p.ts - st.anchor.ts > stillMs) { closeTrip(st.anchor.ts, zone); setAnchor(p, zone); }

    // Motion evidence since the anchor (not the anchor fix itself) keeps the no-data fallback from closing a trip.
    if ((c === 'drive' || c === 'foot') && st.anchor.ts < p.ts) st.anchor.moving = true;

    st.lastTS = p.ts; st.lastZone_ID = zone; st.lastZoneIsBase = !!p.zoneIsBase;
    m.lastPoint = { lat: p.lat, lon: p.lon };
  }
  return { events, trips, state: st };
}

module.exports = { segment, classOf, encodeMotion, decodeMotion };