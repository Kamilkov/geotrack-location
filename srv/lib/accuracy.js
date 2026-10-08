'use strict';
// Which positions count: one without an accuracy value, or one whose accuracy is at most the limit of where it
// lies. Outdoors the phone is precise, so a poor position outside every zone is junk; indoors, where stays and
// visits are confirmed, it is normal. maxAccuracyOutsideM 0 or absent: one limit everywhere.
// Outside every zone the vertical accuracy counts too: an offline phone at night reports junk fixes (motorway
// speeds on a bedside table) whose horizontal accuracy can pass the limit while the vertical one reads 100 to
// 300 m; a real fix outdoors has 30 m or better. maxVerticalAccuracyOutsideM 0 or absent: that rule is off.

const NO_LIMIT = 2147483647; // the SQL condition keeps its shape when the vertical rule is off

/** { inside, outside, vertical } in metres; vertical 0 means off */
const accuracyLimits = (settings) => ({
  inside: settings.maxAccuracyM,
  outside: settings.maxAccuracyOutsideM || settings.maxAccuracyM,
  vertical: settings.maxVerticalAccuracyOutsideM || 0,
});

/** The segmenter's check. p: { accuracy, verticalAccuracy, zone_ID } */
const accepted = (p, limits) => (p.accuracy == null || p.accuracy <= (p.zone_ID == null ? limits.outside : limits.inside))
  && !(limits.vertical && p.zone_ID == null && p.verticalAccuracy != null && p.verticalAccuracy > limits.vertical);

/** The same check as a condition on GEOTRACK_POSITIONS; its parameters are acceptedParams(settings) */
const ACCEPTED_SQL = '((ACCURACY IS NULL OR (ZONE_ID IS NULL AND ACCURACY <= ?) OR (ZONE_ID IS NOT NULL AND ACCURACY <= ?))'
  + ' AND (ZONE_ID IS NOT NULL OR VERTICALACCURACY IS NULL OR VERTICALACCURACY <= ?))';
const acceptedParams = (settings) => { const l = accuracyLimits(settings); return [l.outside, l.inside, l.vertical || NO_LIMIT]; };

module.exports = { accuracyLimits, accepted, ACCEPTED_SQL, acceptedParams };
