'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fillWeatherText, fillTripWeather, maskServerError, HANA_DOWN } = require('../srv/lib/trip-read');

test('fillWeatherText: one row, arrays, null codes and empty results', () => {
  const one = { weatherCode: 61 };
  fillWeatherText(one);
  assert.equal(one.weatherText, 'slight rain');
  const rows = [{ weatherCode: 0 }, { weatherCode: null }, { hour: 'x' }];
  fillWeatherText(rows);
  assert.deepEqual(rows.map((r) => r.weatherText), ['clear sky', undefined, undefined]);
  fillWeatherText(null);
  fillWeatherText([]);
});

test('fillTripWeather: expanded weather of each trip', () => {
  const trips = [{ ID: 'a', weather: [{ weatherCode: 3 }] }, { ID: 'b' }];
  fillTripWeather(trips);
  assert.equal(trips[0].weather[0].weatherText, 'overcast');
  fillTripWeather({ ID: 'c', weather: [{ weatherCode: 95 }] });
  fillTripWeather(undefined);
});

test('maskServerError: 5xx and status-less errors keep only the fixed hint, 4xx stay', () => {
  // In production CAP sends a 5xx message only with $sanitize false; the error may then carry nothing else.
  const only = (e) => ({ ...e, message: e.message });
  const masked = (status) => ({ message: HANA_DOWN, code: String(status), status, $sanitize: false });
  // As @cap-js/hana throws it: the SQL text on `query`.
  const sql = Object.assign(new Error('invalid table name: Could not find table/view X in schema F79B'),
    { name: 'SqlError', code: 259, sqlState: 'HY000', query: 'SELECT ID FROM GEOTRACK_TRIPS' });
  assert.equal(maskServerError(sql), 'invalid table name: Could not find table/view X in schema F79B');
  assert.deepEqual(only(sql), masked(500));
  const down = Object.assign(new Error('Connection refused'), { status: 503 });
  maskServerError(down);
  assert.deepEqual(only(down), masked(503));
  const sql4xx = Object.assign(new Error('insufficient privilege'), { code: 258, sqlState: 'HY000' });
  maskServerError(sql4xx);
  assert.deepEqual(only(sql4xx), masked(500));
  // hdb's error when HANA is stopped: the host in the message, a code that is no number.
  const closed = Object.assign(new Error('Could not connect to any host: [ x.hanacloud.ondemand.com:443 - socket hang up ]'), { code: 'EHDBOPENCONN' });
  maskServerError(closed);
  assert.deepEqual(only(closed), masked(500));
  const plain = new Error('boom');
  maskServerError(plain);
  assert.deepEqual(only(plain), masked(500));
  for (const e of [Object.assign(new Error('read-only'), { status: 405 }), Object.assign(new Error('ENTITY_IS_READ_ONLY'), { code: 405 }), Object.assign(new Error('bad key'), { code: '400' }), Object.assign(new Error('nf'), { statusCode: 404 })]) {
    const before = only(e);
    assert.equal(maskServerError(e), null);
    assert.deepEqual(only(e), before);
  }
});
