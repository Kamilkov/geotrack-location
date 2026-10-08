'use strict';

/**
 * Writers (MQTT subscriber, segment runner, /health/workouts, /photos, /positions) run only on the VPS
 * (the Docker image sets NODE_ENV=production) or when asked for explicitly (npm run watch).
 * Any other start is read-only: the Mac's .env holds MQTT_URL, and the subscriber's fixed
 * client id would take the persistent session from the VPS.
 */
function ingestEnabled(env) {
  return env.NODE_ENV === 'production' || env.GEOTRACK_INGEST === '1';
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(address) {
  return LOOPBACK.has(address);
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function isLocalHost(host) {
  return typeof host === 'string' && LOCAL_HOST.test(host);
}

/**
 * CSRF guard for /trips, the trips app's OData service behind Caddy's basic auth. The browser sends that
 * password with cross-site requests too, and a cross-site request skips the CORS preflight only with a form
 * or text/plain body. CAP picks its $batch parser by a substring of Content-Type ("text/plain;
 * x=multipart/mixed" passes), so a POST passes only when its media type itself is JSON or multipart/mixed.
 */
function csrfGuard(req, res, next) {
  if (req.method !== 'POST' || req.is(['application/json', 'multipart/mixed'])) return next();
  res.sendStatus(415);
}

module.exports = { ingestEnabled, isLoopback, isLocalHost, csrfGuard };
