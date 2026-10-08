'use strict';
/**
 * Remove the location and the Wi-Fi identity from a raw OwnTracks JSON string (a BSSID is
 * geolocatable through public Wi-Fi databases). Parsed, not regex-edited, so the result is
 * always valid JSON. Unparseable input yields null.
 */
function stripRaw(raw) {
  try {
    const obj = JSON.parse(raw);
    delete obj.lat; delete obj.lon; delete obj.SSID; delete obj.BSSID;
    return JSON.stringify(obj);
  } catch { return null; }
}

/** Apply zone tagging; for private zones replace coordinates by the zone centre. Pure. */
function coarsen(row, zone) {
  const out = { ...row, zone_ID: zone ? zone.ID : null, isCoarsened: false };
  if (zone && (zone.ISPRIVATE === true || zone.ISPRIVATE === 1)) {
    const lat = Number(zone.CENTRELAT), lon = Number(zone.CENTRELON);
    if (zone.CENTRELAT == null || zone.CENTRELON == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`private zone ${zone.ID} has no centre; cannot coarsen`);
    }
    out.lat = lat;
    out.lon = lon;
    out.isCoarsened = true;
    out.ssid = null;
    out.raw = stripRaw(row.raw);
  }
  return out;
}
module.exports = { coarsen, stripRaw };
