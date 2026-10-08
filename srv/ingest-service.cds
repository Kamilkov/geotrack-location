using { geotrack } from '../db/schema';

@path: '/ingest'
service IngestService {
  @readonly entity Positions  as projection on geotrack.Positions excluding { point, raw };
            entity Zones      as projection on geotrack.Zones excluding { geom };
  @readonly entity ZoneEvents as projection on geotrack.ZoneEvents;
  @readonly entity Trips      as projection on geotrack.Trips excluding { route };
  @readonly entity TripWeather as projection on geotrack.TripWeather;
  @readonly entity Workouts         as projection on geotrack.Workouts excluding { raw };
  @readonly entity WorkoutHeartRate as projection on geotrack.WorkoutHeartRate;
  @readonly entity WorkoutRoute     as projection on geotrack.WorkoutRoute excluding { point };
  @readonly entity WorkoutTrips     as projection on geotrack.WorkoutTrips;
  @readonly entity WorkoutMinutes   as projection on geotrack.WorkoutMinutes;
            entity Photos       as projection on geotrack.Photos excluding { point };
  @readonly entity PhotoContext as projection on geotrack.PhotoContext;
  @readonly entity Watermarks as projection on geotrack.Watermarks;
            entity Settings   as projection on geotrack.Settings;

  /** Recompute events and trips for one device from a point in time. */
  action resegment(device : String(40), fromTS : Timestamp) returns String;
  /** Re-enqueue the A4H call for one zone event. */
  action retryVisit(eventKey : String) returns String;
  /** Fetch the weather for one closed trip again, now (resets the attempt counter). */
  action refetchWeather(tripID : UUID) returns String;

  event ZoneEntered : { device : String(40); zone_ID : UUID; zoneName : String(60); createsVisit : Boolean; at : Timestamp; eventKey : String; }
  event ZoneLeft    : { device : String(40); zone_ID : UUID; zoneName : String(60); createsVisit : Boolean; at : Timestamp; eventKey : String; }
}
