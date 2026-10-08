'use strict';
const cds = require('@sap/cds');
const { dbHealthy, state } = require('./srv/lib/store');
const { ingestEnabled, isLoopback, isLocalHost, csrfGuard } = require('./srv/lib/mode');

const health = { mqtt: 'disconnected' };

// cds.env does not interpolate $VARS in package.json, so fill the A4H credentials from the
// environment here, before any service connects. Mutate the object package.json declares:
// cds.requires.ZSB_GTSITEVISIT_O4 (the `service` alias) holds a shallow copy sharing it.
Object.assign(cds.env.requires.a4h.credentials, { url: process.env.A4H_URL, username: process.env.SAP_USER, password: process.env.SAP_PASSWORD });
const missing = ['A4H_URL', 'SAP_USER', 'SAP_PASSWORD'].filter((k) => !process.env[k]);
if (missing.length) cds.log('visits').warn(`${missing.join(', ')} not set: SiteVisit calls to A4H will fail and retry`);

// After the cds.env access above, so a value from .env counts too.
const ingest = ingestEnabled(process.env);

cds.on('bootstrap', (app) => {
  // In both modes: the trips app's one write (deletePhoto) must not be reachable from another site.
  app.use('/trips', csrfGuard);

  // Read-only mode serves only this Mac: CAP listens on every interface and has no host option.
  // Also rejects a foreign Host header (DNS rebinding) so another site can't reach this origin
  // through the browser using the loopback address under a name it controls.
  if (!ingest) {
    app.use((req, res, next) => (isLoopback(req.socket.remoteAddress) && isLocalHost(req.headers.host) ? next() : res.sendStatus(403)));
  }

  app.get('/health', async (_req, res) => {
    res.json({
      mqtt: health.mqtt,
      db: (await dbHealthy()) ? 'ok' : 'down',
      lastStoredAt: state.lastStoredAt,
    });
  });

  if (!ingest) return;
  require('./srv/lib/health-ingest').mount(app);
  require('./srv/lib/photos-ingest').mount(app);
  require('./srv/lib/positions-ingest').mount(app);
});

cds.on('served', () => {
  if (!ingest) return cds.log('mode').info('read-only: ingest, runner and MQTT off');
  require('./srv/lib/segment-runner').startTimer(300000);
  if (!process.env.MQTT_URL) return cds.log('mqtt').warn('MQTT_URL not set, subscriber disabled');
  require('./srv/lib/mqtt-ingest').start({
    url: process.env.MQTT_URL,
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS,
    health,
  });
});

module.exports = cds.server;
module.exports.health = health;
