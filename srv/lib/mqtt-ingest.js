'use strict';
const mqtt = require('mqtt');
const cds = require('@sap/cds');
const { parse } = require('./owntracks');
const { insertPosition, findZone } = require('./store');
const { coarsen } = require('./coarsen');
const segmentRunner = require('./segment-runner');

const log = cds.log('mqtt');

/**
 * Subscribe with a persistent session and process messages one at a time.
 * PUBACK is sent only when handleMessage's callback (`done`) is called — but
 * mqtt.js's internal QoS 1 callback (`nextTickWork`) takes no argument, so
 * `done(err)` on its own only withholds the ack; it does NOT drop the
 * connection. To force redelivery on an insert failure we explicitly destroy
 * the underlying socket (`client.stream.destroy()`), which fires the
 * stream's `'close'` event, which mqtt.js turns into `client.emit('close')`
 * and its own reconnect logic (`reconnectPeriod`). On reconnect, with
 * `clean:false`, the broker redelivers every unacknowledged QoS 1 message.
 * That is the whole outage strategy: no local buffer, the broker is the buffer.
 */
function start({ url, username, password, clientId = 'geotrack-ingest', topic = 'owntracks/#', health }) {
  const client = mqtt.connect(url, {
    username, password, clientId,
    clean: false,            // persistent session: broker queues QoS 1 while we are away
    reconnectPeriod: 30000,  // don't hammer a down DB every 5s
    keepalive: 60,
  });

  client.handleMessage = (packet, done) => {
    const received = new Date();
    const row = parse(packet.topic, packet.payload, received);
    if (!row) {
      log.warn('skipping non-location or invalid message on', packet.topic);
      return done(); // poison/irrelevant: ack so it never blocks the queue
    }
    findZone(row.lat, row.lon)
      .then((zone) => insertPosition(coarsen(row, zone)))
      .then((result) => {
        log.info(result, row.device, row.ts.toISOString());
        // Only a new row can be a late position: a redelivered duplicate was segmented already.
        segmentRunner.schedule(row.device, result === 'inserted' ? row.ts : null);
        done();
      })
      .catch((err) => {
        log.error('insert failed, dropping connection for redelivery:', err.message);
        client.stream.destroy(); // force a real disconnect so mqtt.js reconnects and the broker redelivers
        done(err);
      });
  };

  client.on('connect', () => {
    health.mqtt = 'connected';
    client.subscribe(topic, { qos: 1 }, (err) => {
      if (err) log.error('subscribe failed', err); else log.info('subscribed', topic);
    });
  });
  client.on('close', () => { health.mqtt = 'disconnected'; });
  client.on('error', (e) => log.error(e.message));

  return client;
}

module.exports = { start };
