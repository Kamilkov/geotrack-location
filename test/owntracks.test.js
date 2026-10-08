const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parse, activitiesOf } = require('../srv/lib/owntracks');

const fixture = fs.readFileSync(__dirname + '/fixtures/location.json');
const received = new Date('2026-09-22T10:00:05Z');

test('maps a full location payload to a Positions row', () => {
  const row = parse('owntracks/kamil/iphone', fixture, received);
  assert.deepEqual(row, {
    device: 'iphone',
    ts: new Date(1758540000 * 1000),
    receivedAt: received,
    lat: 48.208174,
    lon: 16.373819,
    accuracy: 12,
    verticalAccuracy: null,
    altitude: 171,
    velocity: 4,
    course: 90,
    battery: 77,
    batteryState: 1,
    connection: 'm',
    ssid: null,
    pressure: 98.512,
    trigger: 't',
    activities: null,
    raw: fixture.toString(),
  });
});

test('returns null for non-location messages', () => {
  const lwt = JSON.stringify({ _type: 'lwt', tst: 1 });
  assert.equal(parse('owntracks/kamil/iphone', lwt, received), null);
});

test('returns null for unparseable payloads', () => {
  assert.equal(parse('owntracks/kamil/iphone', 'not json', received), null);
});

test('returns null when lat/lon/tst are missing', () => {
  assert.equal(parse('owntracks/kamil/iphone', JSON.stringify({ _type: 'location', lat: 1 }), received), null);
});

test('tolerates missing optional fields', () => {
  const min = JSON.stringify({ _type: 'location', tst: 1758540000, lat: 1.5, lon: 2.5 });
  const row = parse('owntracks/kamil/iphone', min, received);
  assert.equal(row.accuracy, null);
  assert.equal(row.ssid, null);
  assert.equal(row.trigger, null);
});

test('takes the device from the last topic segment', () => {
  const row = parse('owntracks/kamil/android', fixture, received);
  assert.equal(row.device, 'android');
});

test('returns null for out-of-range latitude', () => {
  const bad = JSON.stringify({ _type: 'location', tst: 1758540000, lat: 91, lon: 16 });
  assert.equal(parse('owntracks/kamil/iphone', bad, received), null);
});

test('returns null for out-of-range longitude', () => {
  const bad = JSON.stringify({ _type: 'location', tst: 1758540000, lat: 48, lon: -181 });
  assert.equal(parse('owntracks/kamil/iphone', bad, received), null);
});

test('returns null for a millisecond timestamp', () => {
  const bad = JSON.stringify({ _type: 'location', tst: 1758540000000, lat: 48, lon: 16 });
  assert.equal(parse('owntracks/kamil/iphone', bad, received), null);
});

test('returns null for a non-finite timestamp', () => {
  const nan = JSON.stringify({ _type: 'location', tst: NaN, lat: 48, lon: 16 });
  const inf = JSON.stringify({ _type: 'location', tst: Infinity, lat: 48, lon: 16 });
  assert.equal(parse('owntracks/kamil/iphone', nan, received), null);
  assert.equal(parse('owntracks/kamil/iphone', inf, received), null);
});

test('returns null for a device name over 40 characters', () => {
  const longDevice = 'a'.repeat(41);
  assert.equal(parse(`owntracks/kamil/${longDevice}`, fixture, received), null);
});

test('maps SSID to ssid when present', () => {
  const withSsid = JSON.stringify({ _type: 'location', tst: 1758540000, lat: 48, lon: 16, SSID: 'HomeNet' });
  const row = parse('owntracks/kamil/iphone', withSsid, received);
  assert.equal(row.ssid, 'HomeNet');
});

test('activitiesOf joins iOS motion activities; absent or malformed → null', () => {
  assert.equal(activitiesOf({ motionactivities: ['stationary', 'automotive'] }), 'stationary,automotive');
  assert.equal(activitiesOf({ motionactivities: ['walking'] }), 'walking');
  assert.equal(activitiesOf({ motionactivities: [] }), null);
  assert.equal(activitiesOf({ motionactivities: 'walking' }), null);
  assert.equal(activitiesOf({ motionactivities: [1, null, 'walking'] }), 'walking');
  assert.equal(activitiesOf({}), null);
  assert.equal(activitiesOf(null), null);
});

test('parse carries the motion activities of a location message', () => {
  const msg = { ...JSON.parse(fixture.toString()), motionactivities: ['stationary', 'automotive'] };
  const row = parse('owntracks/kamil/iphone', Buffer.from(JSON.stringify(msg)), received);
  assert.equal(row.activities, 'stationary,automotive');
});

const iosFixture = fs.readFileSync(__dirname + '/fixtures/ios-position.json');
const loc = (extra) => JSON.stringify({ _type: 'location', tst: 1790000000, lat: 42.5, lon: 1.5, ...extra });
const columns = (row) => [row.accuracy, row.altitude, row.velocity, row.course, row.battery, row.batteryState, row.pressure, row.connection, row.trigger, row.ssid];

test("maps the iOS app's sample position; its extra keys stay in raw only", () => {
  const row = parse('http/trial-iphone', iosFixture, received);
  assert.deepEqual(row, {
    device: 'trial-iphone',
    ts: new Date(1790000000 * 1000),
    receivedAt: received,
    lat: 42.5021,
    lon: 1.5034,
    accuracy: 6,
    verticalAccuracy: 4,
    altitude: 1012,
    velocity: 5,
    course: 87,
    battery: 81,
    batteryState: 1,
    connection: 'w',
    ssid: null,
    pressure: 89.874,
    trigger: 't',
    activities: 'walking',
    raw: iosFixture.toString(),
  });
  for (const key of ['vac', 'sacc', 'cacc', 'mconf']) assert.ok(JSON.parse(row.raw)[key] != null, key);
});

test('a column-bound field of the wrong type is stored as empty; the position is kept', () => {
  const row = parse('http/dev', loc({ acc: {}, alt: '12', vel: [5], cog: true, batt: null, bs: 'x', p: '98', conn: 7, t: 1, SSID: 5 }), received);
  assert.deepEqual(columns(row), [null, null, null, null, null, null, null, null, null, null]);
  assert.deepEqual([row.lat, row.lon], [42.5, 1.5]);
});

test('numbers are rounded for the Integer columns and refused outside a column\'s range', () => {
  const row = parse('http/dev', loc({ acc: 6.6, alt: -12.4, vel: 2147483648, cog: -0.4, bs: 2, p: 89.8741 }), received);
  assert.deepEqual([row.accuracy, row.altitude, row.velocity, row.course, row.batteryState, row.pressure], [7, -12, null, 0, 2, 89.8741]);
  assert.equal(parse('http/dev', loc({ p: 10000 }), received).pressure, null);
  assert.equal(parse('http/dev', loc({ p: -10000 }), received).pressure, null);
  assert.equal(parse('http/dev', loc({ p: 9999.999 }), received).pressure, 9999.999);
  assert.equal(parse('http/dev', loc({ p: 9999.9996 }), received).pressure, null);
});

test('an Integer column takes 2147483647 and -2147483647, and nothing beyond; a number that overflows a double is stored as empty', () => {
  const batt = (v) => parse('http/dev', loc({ batt: v }), received).battery;
  assert.deepEqual([batt(2147483647), batt(-2147483647), batt(2147483648), batt(-2147483648)], [2147483647, -2147483647, null, null]);
  // JSON.stringify (loc) turns Infinity into null, so only the payload text can carry one: 1e400 reads back as Infinity.
  const payload = '{"_type":"location","tst":1790000000,"lat":42.5,"lon":1.5,"batt":1e400,"alt":-1e400,"p":1e400}';
  assert.equal(JSON.parse(payload).batt, Infinity);
  const row = parse('http/dev', payload, received);
  assert.deepEqual([row.battery, row.altitude, row.pressure], [null, null, null]);
  assert.deepEqual([row.lat, row.lon], [42.5, 1.5]);
});

test('conn must be w, m or o; t one character; an SSID at most 64 characters', () => {
  const of = (extra) => parse('http/dev', loc(extra), received);
  assert.equal(of({ conn: 'wwwwwwwwwwww' }).connection, null);
  assert.equal(of({ conn: 'x' }).connection, null);
  assert.equal(of({ conn: 'o' }).connection, 'o');
  assert.equal(of({ t: 'tt' }).trigger, null);
  assert.equal(of({ t: '' }).trigger, null);
  assert.equal(of({ t: 'u' }).trigger, 'u');
  assert.equal(of({ SSID: 'a'.repeat(65) }).ssid, null);
  assert.equal(of({ SSID: 'a'.repeat(64) }).ssid, 'a'.repeat(64));
});

test('raw keeps the original payload, whatever was refused', () => {
  const payload = loc({ acc: {}, conn: 'wwwwwwwwwwww' });
  assert.equal(parse('http/dev', payload, received).raw, payload);
});

test('vac is stored as the vertical accuracy, rounded, like acc; junk values are stored as empty', () => {
  assert.equal(parse('http/dev', loc({ vac: 147.4 }), received).verticalAccuracy, 147);
  assert.equal(parse('http/dev', loc({}), received).verticalAccuracy, null);
  assert.equal(parse('http/dev', loc({ vac: 'tall' }), received).verticalAccuracy, null);
});
