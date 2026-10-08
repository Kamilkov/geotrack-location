'use strict';
const R = 6371008.8; // mean Earth radius (m)
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance between two {lat, lon} in metres. */
function haversineM(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Circle as a closed WKT polygon (lon lat order), n vertices, geodesic offsets. */
function circleToWkt(lat, lon, radiusM, n = 36) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const brg = (2 * Math.PI * i) / n;
    const dLat = (radiusM * Math.cos(brg)) / R;
    const dLon = (radiusM * Math.sin(brg)) / (R * Math.cos(rad(lat)));
    pts.push(`${(lon + (dLon * 180) / Math.PI).toFixed(7)} ${(lat + (dLat * 180) / Math.PI).toFixed(7)}`);
  }
  pts.push(pts[0]);
  return `POLYGON((${pts.join(', ')}))`;
}

/** Rings of a WKT POLYGON or MULTIPOLYGON as arrays of [lon, lat]. */
function ringsOf(wkt) {
  return [...String(wkt).matchAll(/\(([^()]+)\)/g)].map((m) => m[1].split(',').map((pt) => pt.trim().split(/\s+/).map(Number)));
}

/** Even-odd rule over all rings (outer rings, holes, several polygons alike); planar in lon/lat. */
function inRings(lon, lat, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Zone rows (ID, KIND, RADIUSM, ISPRIVATE, CENTRELAT, CENTRELON, WKT) → zones in findZone's order:
 * private first, then polygons, then circles by radius. A private zone without a centre throws,
 * so no point is ever stored uncoarsened for want of a target.
 */
function prepareZones(rows) {
  return rows.map((z) => {
    const isPrivate = z.ISPRIVATE === true || z.ISPRIVATE === 1;
    const centreLat = z.CENTRELAT == null ? null : Number(z.CENTRELAT), centreLon = z.CENTRELON == null ? null : Number(z.CENTRELON);
    if (isPrivate && !(Number.isFinite(centreLat) && Number.isFinite(centreLon))) throw new Error(`private zone ${z.ID} has no centre; cannot coarsen`);
    const rings = ringsOf(z.WKT);
    if (isPrivate && !rings.length) throw new Error(`private zone ${z.ID} has no usable geometry; cannot coarsen`);
    return { ID: z.ID, isPrivate, centreLat, centreLon, rank: z.KIND === 'polygon' ? 0 : Number(z.RADIUSM), rings };
  }).sort((a, b) => b.isPrivate - a.isPrivate || a.rank - b.rank);
}

/** The zone findZone would pick for this point, from prepareZones' list; null when none. */
const zoneOf = (lat, lon, zones) => zones.find((z) => inRings(lon, lat, z.rings)) ?? null;

module.exports = { haversineM, circleToWkt, prepareZones, zoneOf };
