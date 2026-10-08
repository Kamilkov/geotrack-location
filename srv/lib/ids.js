'use strict';
const { createHash } = require('node:crypto');
const NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // RFC 4122 DNS namespace, fixed for this project

/** RFC 4122 version 5 UUID of `name` under the project namespace. */
function uuidv5(name) {
  const ns = Buffer.from(NS.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(String(name)).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function eventKey({ device, zone_ID, kind, at }) {
  return `${device}|${zone_ID}|${kind}|${new Date(at).toISOString()}`;
}

module.exports = { uuidv5, eventKey };
