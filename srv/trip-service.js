'use strict';
const cds = require('@sap/cds');
const { fillWeatherText, fillTripWeather, maskServerError } = require('./lib/trip-read');
const { deletePhoto } = require('./lib/photo-delete');
const { ingestEnabled } = require('./lib/mode');

const log = cds.log('trips');

module.exports = class TripService extends cds.ApplicationService {
  init() {
    this.after('READ', 'TripWeather', fillWeatherText);
    this.after('READ', 'Trips', fillTripWeather);
    this.on('deletePhoto', (req) => deletePhoto(req, { db: cds.db, readOnly: !ingestEnabled(process.env) }));
    this.on('error', (err) => {
      const original = maskServerError(err);
      if (original) log.error(original);
    });
    return super.init();
  }
};
