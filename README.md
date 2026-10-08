# GeoTrack

Self-hosted location, workout and photo tracking for one person: an iOS app
records positions, Apple Watch workouts and photos and sends them to your own
server; the server cuts them into trips, tags zones, adds weather, and serves
a Fiori Elements trip app and read-only MCP tools for Claude.

Built with [Claude Code](https://claude.com/claude-code).

## Parts

| Path | What it is |
|---|---|
| `srv/`, `db/`, `server.js` | SAP CAP (Node 22) service on SAP HANA Cloud: ingest routes, zones, trip segmentation, weather from Open-Meteo |
| `ios/GeoTrackKit` | Swift package, tested on the Mac: keep rule, queue, uploader, workout and photo sync |
| `ios/GeoTrack` | The iOS app (iOS 18+): two screens, Status and Setup. The Xcode project is generated from `project.yml` |
| `app/tripsui` | Fiori Elements List Report / Object Page: trips with route map, workout, heart rate, photos, weather |
| `agent/` | MCP tools over `@cap-js/mcp` (local only, no coordinates in any result) |
| `a4h/` | Optional: RAP `SiteVisit` object on an ABAP system, created when you enter a flagged zone ([a4h/README.md](a4h/README.md)) |
| `deploy/` | Docker Compose and Caddy snippets |
| `docs/api.md` | The HTTP contract the app needs: any server that keeps to it works with the app |

## How it flows

```
iPhone app ──HTTPS, Bearer token──▶ Caddy ──▶ CAP ingest ──▶ HANA Cloud
  POST /positions, /health/workouts, /photos      │  zones, coarsening, trips
                                                  │  weather (Open-Meteo)
                                                  └▶ A4H SiteVisit (optional, persistent queue)
Browser ──basic auth──▶ Caddy ──▶ trip app (/tripsui, /trips)
Claude ──localhost──▶ MCP tools (npm run ui)
```

The app queues everything locally, so a server outage (or the HANA trial's
nightly stop) loses nothing.

## Run locally

Needs Node 22, a HANA Cloud HDI container bound with `cds bind`, and a `.env`
(git-ignored) with what the scripts you run need.

```bash
npm install
npm test                                   # unit tests, no HANA needed
npx cds bind -2 <your-hdi-container>       # hybrid profile: local Node, remote HANA
npm run deploy                             # schema to HANA
npm run watch                              # the full ingest
npm run ui                                 # trip app + MCP tools on http://localhost:4008
node scripts/positions-dev-server.js       # /positions, /health/workouts, /photos over memory, no HANA
```

## The iOS app

Needs Xcode and XcodeGen (`brew install xcodegen`).

```bash
cd ios/GeoTrackKit && swift test
cd ios/GeoTrack && cp -n Local.xcconfig.example Local.xcconfig   # your Apple team id, for a device
cd ios/GeoTrack && xcodegen generate
```

In Setup, enter your server address, its token (`HEALTH_TOKEN` on the server)
and a device name. Building your own copy needs your own bundle id in
`project.yml`.

## Deploy

Paste `deploy/docker-compose.snippet.yml` and `deploy/Caddyfile.snippet` into a
Docker host running Caddy, replace the `example.com` names, and put the
secrets in `geotrack.env` next to the compose file: `VCAP_SERVICES`,
`HEALTH_TOKEN`, and for A4H `A4H_URL`, `SAP_USER`, `SAP_PASSWORD`. Never
commit them. The ingest has no auth of its own: never publish its port; Caddy
exposes only the token-protected POST routes and the password-protected trip
app.

## MCP tools

```bash
claude mcp add --transport http geotrack http://localhost:4008/mcp/geotrack
```

Tools: `describe`, `query`, `totals`, `zoneStats`, `tripsNear`, `tripDetail`.
Try "How far did I walk this month, compared with last month?" or "Was it
raining on any of my walks?"

## Privacy by design

- Positions inside a private zone (home) are coarsened to the zone centre
  before they are stored; the originals are never written, Wi-Fi SSID/BSSID
  included.
- Workout route points inside a private zone are coarsened the same way.
- A photo taken inside a private zone is dropped, not stored. A stored photo
  keeps only a thumbnail with all metadata stripped, on the phone and again on
  the server; the original never leaves the phone.
- Weather lookups send a trip's position rounded to about 1 km.
- MCP results carry no coordinates; `npm run mcp-smoke` fails on any.

## Status

A personal project, shared as is. Issues and pull requests may go unanswered.

## License

[MIT](LICENSE)
