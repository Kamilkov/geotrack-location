# GeoTrack server API: what the iOS app needs from a server

The app (`ios/`) talks to one base URL over three `POST` routes with JSON
bodies and a Bearer token. It needs nothing else: no GET, no OData, no
SAP. Any server that keeps to this document works with the app; the CAP
server in `srv/` is the one that exists.

The rules below are the ones the app enforces (`ios/GeoTrackKit`) and the
ones the CAP server enforces (`srv/lib/*-ingest.js`). Where the two differ,
both are named.

## Common to all routes

**Base URL.** An `https` address; `http` only for `localhost` and
`127.0.0.1` (Simulator tests). The route paths are appended to it, so a base
URL with a path prefix works.

**Authentication.** Every request carries `Authorization: Bearer <token>`.
The CAP server compares the token in constant time with `HEALTH_TOKEN`.

**Content.** Request and answer bodies are JSON (`Content-Type:
application/json`). The CAP server's body limits: 1 MB for `/positions` and
`/photos`, 20 MB for `/health/workouts`.

**Answers and what the app does with them.**

| Status | Meaning for the app | App's reaction |
|---|---|---|
| 200 | Done; the body says what happened to each item | Removes the sent items from its queue, as the body says |
| 401 | The token is wrong | Stops sending ("the server rejects the token") until Setup changes |
| 400, 413 | The request itself is refused: a fault in the app | Stops sending; for `/photos` only that one photo is dropped and the round goes on |
| 503 with `{"error":"endpoint disabled…"}` | The server has no token configured | Stops sending ("the server has no token configured") |
| any other (5xx, 503 "database unavailable", timeout, no connection) | Temporary | Keeps the queue and retries after a minute |

Error answers are `{ "error": "<reason>" }`. The app shows a reason to the
owner, so it should be a short fixed text, never an echo of the body.

**Idempotence.** The app resends whatever it got no 200 for. Every route
must therefore take the same item twice without storing it twice: positions
by their device and time, workouts by their id, photos by their id.

**Device names.** 1 to 40 characters of `a-z`, `0-9` and `-`. The CAP
server treats a name starting with `trial` as a trial device: stored, never
used for trips. That is a server policy, not something the app knows.

## `POST /positions`

A batch of positions in OwnTracks' JSON shape. The app sends at most 50 per
request, oldest first, one request at a time; the CAP server takes up to
500.

```json
{
  "device": "iphone",
  "positions": [
    { "_type": "location", "tst": 1790000000, "lat": 42.5021, "lon": 1.5034,
      "acc": 6, "alt": 1013, "vac": 4, "vel": 5, "cog": 182, "batt": 81, "bs": 1,
      "conn": "w", "p": 89.914, "t": "t", "motionactivities": ["walking"],
      "mconf": "high", "sacc": 0.5, "cacc": 12.0 }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `_type` | yes | Always `"location"`; anything else is skipped |
| `tst` | yes | Unix seconds, between 2000 and 2100 |
| `lat`, `lon` | yes | Degrees, 6 decimals |
| `acc` | no | Horizontal accuracy, metres |
| `alt` | no | Altitude, metres |
| `vel` | no | Speed, km/h |
| `cog` | no | Course, degrees from north |
| `batt`, `bs` | no | Battery percent; state 0 unknown, 1 unplugged, 2 charging, 3 full |
| `conn` | no | `"w"` Wi-Fi, `"m"` mobile, `"o"` offline |
| `p` | no | Pressure, kPa |
| `t` | no | `"t"` when the position was kept because of time, not distance; `"c"` on the first position after Home sleep (see the answer's `home`) |
| `motionactivities` | no | iOS motion activities, e.g. `["stationary","automotive"]` |
| `vac`, `sacc`, `cacc`, `mconf` | no | Vertical, speed and course accuracy; motion confidence (`low`/`medium`/`high`). The app adds these to OwnTracks' shape; the CAP server keeps them in the raw payload only |

A value the phone does not have is left out, never sent as `null`.

**Answer**

```json
{ "stored": 48, "duplicates": 1, "skipped": [17], "home": { "lat": 42.5021, "lon": 1.5034, "radiusM": 300 } }
```

- `stored` + `duplicates` + the number of entries in `skipped` **must equal
  the number of positions sent**, and every index in `skipped` must point
  into the batch. Otherwise the app keeps the whole batch and retries: an
  answer that does not account for the batch removes nothing.
- `skipped` holds the 0-based indices of positions the server could not use
  (unparseable, or failed to store while the database was up). The app moves
  them aside and does not resend them.
- `duplicates` are positions already stored under this device and time.
- `home` (optional) is the base zone as a circle. The app sleeps when the
  phone has had no network at all for a minute while its last fix lay inside
  it: GPS off, iOS watching the circle's edge, the network's return waking
  it. The app keeps the circle of the last answer and forgets it when an
  answer names none. A server without a
  base zone, or with a base polygon, leaves the field out, and the app never
  sleeps. The first position after a sleep carries `"t": "c"` (OwnTracks'
  region trigger); the CAP server starts the trip at that position, from the
  base zone, instead of treating the silent night as a gap.

The CAP server answers `503 { "error": "database unavailable" }` when HANA
is down, even part-way through a batch; the resend then returns the stored
part as duplicates.

## `POST /health/workouts`

One workout per request, in the JSON shape of Health Auto Export's export
version 2, with the device named beside `data`. (Health Auto Export itself
sends the same body without `device`; the CAP server then uses its
configured device.)

```json
{
  "device": "iphone",
  "data": { "workouts": [ {
    "id": "7E0C2C9A-5D0B-4C3E-9C1E-2A3B4C5D6E7F",
    "name": "Hiking",
    "start": "2026-09-22T15:43:46Z",
    "end": "2026-09-22T17:10:02Z",
    "duration": 5176,
    "isIndoor": false,
    "distance": { "qty": 6420, "units": "m" },
    "activeEnergyBurned": { "qty": 512.3, "units": "kcal" },
    "elevationUp": { "qty": 310, "units": "m" },
    "temperature": { "qty": 18.5, "units": "degC" },
    "humidity": { "qty": 61, "units": "%" },
    "heartRate": { "min": { "qty": 92, "units": "bpm" }, "avg": { "qty": 128, "units": "bpm" }, "max": { "qty": 161, "units": "bpm" } },
    "heartRateData": [ { "date": "2026-09-22T15:43:50Z", "Min": 93, "Avg": 93, "Max": 93, "units": "bpm", "source": "Apple Watch" } ],
    "heartRateRecovery": [],
    "stepCount": [ { "date": "2026-09-22T15:43:46Z", "qty": 8120, "units": "count" } ],
    "route": [
      { "latitude": 42.5021, "longitude": 1.5034, "altitude": 1013.2, "timestamp": "2026-09-22T15:43:46Z",
        "speed": 1.3, "course": 182, "horizontalAccuracy": 5, "verticalAccuracy": 4, "speedAccuracy": 0.5, "courseAccuracy": 12 }
    ]
  } ] }
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Up to 64 characters; the app sends HealthKit's workout UUID. A resend replaces the stored copy |
| `start`, `end` | yes | A time with a UTC offset: ISO 8601 with `Z` or `±hh:mm`, or Health Auto Export's `"2026-09-22 15:43:46 +0200"`. A time without an offset is unreadable |
| `name` | no | The activity name as Health Auto Export spells it ("Outdoor Walk", "Hiking", …); cut to 60 characters |
| `duration` | no | Seconds; otherwise `end` − `start` |
| `isIndoor` | no | Boolean |
| `distance`, `elevationUp` | no | `{ qty, units }` with units `m`, `km`, `mi`, `ft` or `yd` |
| `activeEnergyBurned` | no | Units `kcal`, `Cal` or `kJ` |
| `temperature` | no | Units `degC`, `°C`, `degF` or `°F` |
| `humidity` | no | `{ qty }`, percent |
| `heartRate` | no | `min`/`avg`/`max`, each `{ qty, units: "bpm" }` |
| `heartRateData`, `heartRateRecovery` | no | Samples `{ date, Min, Avg, Max, units, source }`; the app sends one value as all three. Repeated dates: the first wins |
| `stepCount` | no | `[{ date, qty, units: "count" }]`, summed |
| `route` | no | Points with `latitude`, `longitude`, `timestamp` and `horizontalAccuracy` required; `altitude`, `speed`, `course`, `verticalAccuracy`, `speedAccuracy`, `courseAccuracy` optional. A negative accuracy or speed means "unknown" (CoreLocation) |

A quantity in a unit not listed is stored as empty, never converted wrongly.

**Answer**

```json
{
  "device": "iphone",
  "workouts": [ { "id": "7E0C2C9A-…", "name": "Hiking", "hrSamples": 1, "routePoints": 1,
                  "coarsened": 0, "startsInPrivateZone": false, "endsInPrivateZone": false } ],
  "skipped": [ ]
}
```

- The app looks for its workout's `id` in `workouts`: found means stored,
  with `hrSamples` and `routePoints` shown to the owner. Otherwise it looks
  for `{ "index": 0, "reason": "…" }` in `skipped`: found means rejected for
  good, with the reason shown. Neither means "retry later".
- `device` **must echo the device the request named.** Before its first
  workout (once per launch and after every Setup change) the app posts an
  empty list, `{ "device": "iphone", "data": { "workouts": [] } }`, and
  sends nothing until the answer's `device` matches. A server that does not
  echo it is taken for one that ignores device names, and the app stops with
  "the server does not store workouts under a device name yet".
- The CAP server stores a trial device's workout under the id
  `<device>:<id>`, so it never replaces another device's copy; the answer
  still names the id as sent.

## `POST /photos`

One photo per request: its metadata and an 800 px JPEG thumbnail without
metadata, base64 in the JSON. The full image never leaves the phone.

```json
{
  "fileName": "IMG_0001.HEIC",
  "cameraModel": "iPhone 15 Pro",
  "takenAt": "2026-09-22T17:50:12.345+02:00",
  "lat": 42.5021, "lon": 1.5034,
  "altitudeM": 1013.4, "accuracyM": 4.7, "directionDeg": 182,
  "thumbnail": "/9j/4AAQSkZJRg…"
}
```

| Field | Required | Meaning |
|---|---|---|
| `fileName` | yes | 1 to 255 characters |
| `cameraModel` | yes | 1 to 60 characters |
| `takenAt` | yes | The time taken with its UTC offset, as for workouts, sub-seconds allowed. With `cameraModel` it makes the photo's id (UUID v5 of `photo\|<cameraModel>\|<takenAt as ISO UTC>`), so the same photo gets the same id whichever way it arrives |
| `lat`, `lon` | together or not at all | The photo's own GPS position |
| `altitudeM`, `accuracyM`, `directionDeg` | no | From the photo's GPS data |
| `thumbnail` | yes | Base64 JPEG, at most 500 KB. The CAP server strips any metadata segment it still carries |

The CAP server does not take a device for photos: it files them under its
configured device.

**Answer**

```json
{ "id": "3f9a12c4-…", "status": "stored", "reason": null, "positionSource": "photo" }
```

- `status` is `"stored"` or `"dropped"`; anything else makes the app retry.
- `positionSource` is `"photo"` (its own GPS) or `"owntracks"` (a position of
  the device within ±10 minutes, when the photo had none). The app tells the
  owner when a position was borrowed.
- A dropped photo carries a `reason` (`"private zone"`, `"no position"`).
  The app shows it and does not resend.
- A 400 (`{ "error": "<reason>" }`, e.g. `"takenAt missing or without UTC
  offset"`) concerns this one photo: the app drops it with the reason and
  goes on with the next.

## What the server decides, not the app

The app is a recorder. Everything that gives the data meaning is the
server's: zones and the coarsening of positions, routes and photos inside
private zones; stop detection, the gap rule and segmentation into trips;
which device is live and which is a trial; weather; the trips UI. A
different server gets raw positions, workouts and photos and builds its own
trips. The CAP server's rules are in its code under `srv/lib`.
