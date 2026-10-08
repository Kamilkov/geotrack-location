'use strict';

// A field bound to a column is stored only when it fits the column; anything else is stored as empty.
// An object as `acc` or a twelve-character `conn` would fail at the insert: over MQTT the broker would then
// redeliver the message without end, over HTTPS it would block the phone's oldest batch.
const INT_MAX = 2147483647;
/** A finite number in an Integer column's range, rounded. `|| 0` turns -0 into 0. */
const int = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= INT_MAX ? Math.round(v) || 0 : null);
/** A finite number that fits Decimal(7,3): at most 9999.999. */
const dec = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 9999.999 ? v : null);
/** A string of 1 to max characters. */
const str = (v, max) => (typeof v === 'string' && v.length >= 1 && v.length <= max ? v : null);
const CONN = new Set(['w', 'm', 'o']);

/** iOS motion activities as one comma-separated string ("stationary,automotive"); null when absent or malformed. */
function activitiesOf(m) {
  if (!Array.isArray(m?.motionactivities)) return null;
  const s = m.motionactivities.filter((x) => typeof x === 'string' && x).join(',');
  return s ? s.slice(0, 60) : null;
}

/**
 * Parse an OwnTracks MQTT message into a geotrack.Positions row.
 * Returns null for anything that is not a usable location message.
 */
function parse(topic, payload, receivedAt) {
  let m;
  try {
    m = JSON.parse(payload.toString());
  } catch {
    return null;
  }
  if (!m || m._type !== 'location') return null;
  if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon) || !Number.isFinite(m.tst)) return null;
  if (m.lat < -90 || m.lat > 90) return null;
  if (m.lon < -180 || m.lon > 180) return null;
  if (m.tst < 946684800 || m.tst > 4102444800) return null;

  const device = topic.split('/').pop();
  if (!device || device.length < 1 || device.length > 40) return null;

  return {
    device,
    ts: new Date(m.tst * 1000),
    receivedAt,
    lat: m.lat,
    lon: m.lon,
    accuracy: int(m.acc),
    verticalAccuracy: int(m.vac),
    altitude: int(m.alt),
    velocity: int(m.vel),
    course: int(m.cog),
    battery: int(m.batt),
    batteryState: int(m.bs),
    connection: CONN.has(m.conn) ? m.conn : null,
    ssid: str(m.SSID, 64),
    pressure: dec(m.p),
    trigger: str(m.t, 1),
    activities: activitiesOf(m),
    raw: payload.toString(),
  };
}

module.exports = { parse, activitiesOf };
