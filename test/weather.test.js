'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hoursOf, buildRequest, parseResponse, summarise, isDue, HOURLY, FORECAST_URL, ARCHIVE_URL } = require('../srv/lib/weather');
const fixture = require('./fixtures/open-meteo-2026-09-22.json');

const T = (s) => new Date(s);
const P = (s, lat, lon) => ({ ts: T(s), lat, lon });

test('hoursOf: one hour the trip spans → one entry, nearest position to the half hour, rounded', () => {
  const trip = { startedAt: T('2026-09-22T15:43:46Z'), endedAt: T('2026-09-22T15:58:00Z') };
  const hours = hoursOf(trip, [P('2026-09-22T15:43:46Z', 42.504324, 1.495137), P('2026-09-22T15:51:25Z', 42.50852, 1.494415)]);
  // 15:43:46 is 13.8 min from the half hour, 15:51:25 is 21.4 min → the first position wins, rounded to 42.5 / 1.5
  assert.deepEqual(hours, [{ hour: T('2026-09-22T15:00:00Z'), lat: 42.5, lon: 1.5 }]);
});

test('hoursOf: a trip across midnight yields hours on both dates and picks per-hour positions', () => {
  const trip = { startedAt: T('2026-09-22T23:20:00Z'), endedAt: T('2026-09-23T00:40:00Z') };
  const hours = hoursOf(trip, [P('2026-09-22T23:20:00Z', 42.5, 1.5), P('2026-09-23T00:35:00Z', 42.51, 1.49)]);
  assert.deepEqual(hours.map((h) => h.hour.toISOString()), ['2026-09-22T23:00:00.000Z', '2026-09-23T00:00:00.000Z']);
  assert.deepEqual(hours.map((h) => [h.lat, h.lon]), [[42.5, 1.5], [42.51, 1.49]]);
});

test('hoursOf: throws when the trip has no positions', () => {
  assert.throws(() => hoursOf({ startedAt: T('2026-09-22T15:00:00Z'), endedAt: T('2026-09-22T15:30:00Z') }, []), /no positions/);
});

test('buildRequest: distinct coordinates in order of first use, hour → location index, forecast within 90 days', () => {
  const hours = [
    { hour: T('2026-09-22T15:00:00Z'), lat: 42.5, lon: 1.5 },
    { hour: T('2026-09-22T16:00:00Z'), lat: 42.51, lon: 1.49 },
    { hour: T('2026-09-22T17:00:00Z'), lat: 42.5, lon: 1.5 },
  ];
  const r = buildRequest(hours, T('2026-09-22T15:43:46Z'), T('2026-09-24T10:00:00Z'));
  assert.deepEqual(r.locationIndex, [0, 1, 0]);
  assert.equal(r.source, 'forecast');
  assert.ok(r.url.startsWith(FORECAST_URL + '?'), r.url);
  assert.match(r.url, /latitude=42\.5,42\.51&longitude=1\.5,1\.49&/);
  assert.match(r.url, new RegExp(`hourly=${HOURLY.join(',')}&`));
  assert.match(r.url, /start_date=2026-09-22&end_date=2026-09-22&timezone=UTC$/);
});

test('buildRequest: trips older than 90 days go to the archive endpoint; midnight crossing spans two dates', () => {
  const hours = [{ hour: T('2026-05-01T23:00:00Z'), lat: 42.5, lon: 1.5 }, { hour: T('2026-05-02T00:00:00Z'), lat: 42.5, lon: 1.5 }];
  const r = buildRequest(hours, T('2026-05-01T23:10:00Z'), T('2026-09-24T10:00:00Z'));
  assert.equal(r.source, 'archive');
  assert.ok(r.url.startsWith(ARCHIVE_URL + '?'));
  assert.match(r.url, /start_date=2026-05-01&end_date=2026-05-02/);
  assert.deepEqual(r.locationIndex, [0, 0]);
});

test('parseResponse: array response, one row per hour from the right location, values and elevation carried', () => {
  const hours = [
    { hour: T('2026-09-22T15:00:00Z'), lat: 42.5, lon: 1.5 },
    { hour: T('2026-09-22T16:00:00Z'), lat: 42.51, lon: 1.49 },
    { hour: T('2026-09-22T17:00:00Z'), lat: 42.5, lon: 1.5 },
  ];
  const rows = parseResponse(fixture, hours, [0, 1, 0], 'forecast');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.hour.toISOString()), hours.map((h) => h.hour.toISOString()));
  assert.equal(rows[1].lat, 42.51);
  assert.equal(rows[1].elevationM, Math.round(fixture[1].elevation));
  assert.equal(rows[0].temperatureC, fixture[0].hourly.temperature_2m[15]);
  assert.equal(rows[1].windKmh, fixture[1].hourly.wind_speed_10m[16]);
  assert.equal(rows[2].weatherCode, fixture[0].hourly.weather_code[17]);
  assert.equal(rows[0].source, 'forecast');
  for (const r of rows) for (const k of ['apparentTemperatureC', 'precipitationMm', 'humidityPct', 'cloudCoverPct', 'windGustKmh', 'windDirectionDeg', 'pressureHpa']) assert.equal(typeof r[k], 'number', k);
});

test('parseResponse: single-location plain-object response is accepted', () => {
  const hours = [{ hour: T('2026-09-22T16:00:00Z'), lat: 42.5, lon: 1.5 }];
  const rows = parseResponse(fixture[0], hours, [0], 'archive');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'archive');
});

test('parseResponse: a missing hour or a null temperature throws "incomplete hours"', () => {
  const hours = [{ hour: T('2026-09-23T03:00:00Z'), lat: 42.5, lon: 1.5 }]; // not in the fixture's day
  assert.throws(() => parseResponse(fixture, hours, [0], 'forecast'), /incomplete hours/);
  const nulled = JSON.parse(JSON.stringify(fixture[0]));
  nulled.hourly.temperature_2m[16] = null;
  assert.throws(() => parseResponse(nulled, [{ hour: T('2026-09-22T16:00:00Z'), lat: 42.5, lon: 1.5 }], [0], 'forecast'), /incomplete hours/);
});

test('summarise: worst code, means to 1 decimal, precipitation sum, max wind', () => {
  const rows = [
    { temperatureC: 18.2, apparentTemperatureC: 15.2, precipitationMm: 0, windKmh: 11, weatherCode: 0 },
    { temperatureC: 17.1, apparentTemperatureC: 14.9, precipitationMm: 0.3, windKmh: 13.7, weatherCode: 61 },
    { temperatureC: 16.0, apparentTemperatureC: 13.0, precipitationMm: 1.25, windKmh: 9, weatherCode: 3 },
  ];
  assert.deepEqual(summarise(rows), { weatherCode: 61, weatherText: 'slight rain', temperatureC: 17.1, apparentTemperatureC: 14.4, precipitationMm: 1.55, windKmh: 13.7 });
});

test('summarise: a null in one variable is ignored, not averaged/summed/maxed as 0', () => {
  const rows = [
    { temperatureC: 10, apparentTemperatureC: null, precipitationMm: 1, windKmh: 5, weatherCode: 0 },
    { temperatureC: 20, apparentTemperatureC: 8, precipitationMm: null, windKmh: null, weatherCode: 3 },
  ];
  const s = summarise(rows);
  assert.equal(s.temperatureC, 15);          // mean unaffected — no nulls here
  assert.equal(s.apparentTemperatureC, 8);   // mean of [8] alone, not (0+8)/2 = 4
  assert.equal(s.precipitationMm, 1);        // sum of [1] alone, not 1+0
  assert.equal(s.windKmh, 5);                // max of [5] alone, not max(5, 0)
  assert.equal(s.weatherCode, 3);
});

test('summarise: an all-null weatherCode gives a null code and a null text', () => {
  const rows = [
    { temperatureC: 10, apparentTemperatureC: 10, precipitationMm: 0, windKmh: 5, weatherCode: null },
    { temperatureC: 12, apparentTemperatureC: 12, precipitationMm: 0, windKmh: 6, weatherCode: null },
  ];
  const s = summarise(rows);
  assert.equal(s.weatherCode, null);
  assert.equal(s.weatherText, null);
});

test('isDue: never when fetched; immediately when never attempted; then 5, 10, 20 … min capped at 6 h', () => {
  const now = T('2026-09-24T12:00:00Z');
  const ago = (min) => new Date(now.getTime() - min * 60000);
  assert.equal(isDue({ weatherFetchedAt: now, weatherAttempts: 0, weatherAttemptedAt: null }, now), false);
  assert.equal(isDue({ weatherFetchedAt: null, weatherAttempts: 0, weatherAttemptedAt: null }, now), true);
  assert.equal(isDue({ weatherFetchedAt: null, weatherAttempts: 1, weatherAttemptedAt: ago(4) }, now), false);
  assert.equal(isDue({ weatherFetchedAt: null, weatherAttempts: 1, weatherAttemptedAt: ago(5) }, now), true);
  assert.equal(isDue({ weatherFetchedAt: null, weatherAttempts: 3, weatherAttemptedAt: ago(19) }, now), false);
  assert.equal(isDue({ weatherFetchedAt: null, weatherAttempts: 3, weatherAttemptedAt: ago(20) }, now), true);
  assert.equal(isDue({ weatherFetchedAt: null, weatherAttempts: 12, weatherAttemptedAt: ago(359) }, now), false);
  assert.equal(isDue({ weatherFetchedAt: null, weatherAttempts: 12, weatherAttemptedAt: ago(360) }, now), true);
  assert.equal(isDue({ weatherFetchedAt: null, weatherAttempts: null, weatherAttemptedAt: null }, now), true);
});
