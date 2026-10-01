# GNSS Log

A Progressive Web App that turns a phone (iPhone or Android) into a vessel sensor and recorder.
It logs position, speed, x/y velocity and heading at **5 Hz** with timestamps, keeps every test
case on the device, uploads it to your cloud endpoint whenever there is a connection, and shows a
top-down plot with breadcrumbs and a **Skyhook** station-keeping view.

UI follows the "Aurora Ink" design rules (dark/light/system themes, glass surfaces, gradient
only on the primary actions) remixed to an **"Admiralty" blue-black and gold** palette: navy
canvas and glows, with complementary gold reserved for the things you act on (record, selected
tab, switches, the vessel). The skyhook marker and breadcrumbs use blue so they read against the
gold vessel.

| Token | Dark | Light |
|---|---|---|
| Canvas | `#060A12` | `#F3F5F9` |
| Surfaces | `#0B1220` / `#111A2B` / `#1A2539` | `#FFFFFF` / `#E9EEF6` / `#DBE3EF` |
| Text | `#F2F0E9` / `#A8B2C6` / `#66738C` | `#0B1424` / `#4A5873` / `#8B96AA` |
| Gold gradient | `#B8862B` → `#E3B453` → `#F6DC96` (navy ink `#0A1322` on top) | same |
| Blue accents (trail, skyhook) | `#5AA2FF` / `#7CC4FF` | `#1F5FD1` |
| Status | success `#3DDC97`, warning `#FF9F43`, error `#FF5C6C` | same |

All colours are tokens at the top of `css/app.css`; the canvas plot reads them at runtime.

## Features (v0.1)

| Area | What it does |
|---|---|
| Sensors | GNSS via the Geolocation API (high accuracy), magnetometer heading via `deviceorientationabsolute` (Android) / `webkitCompassHeading` (iOS), gyroscope via `devicemotion`. |
| Heading filter | 2-state Kalman filter (heading, gyro bias). The gyro yaw rate (projected onto the vertical, so it works when the phone is tilted) drives the prediction; the compass corrects it with innovation gating against magnetic disturbances. With no compass it falls back to GNSS course over ground while making way. |
| Position filter | 4-state constant-velocity Kalman filter (x, y, vx, vy) in a local East/North frame. Fuses GNSS position and GNSS (Doppler) velocity and gives a smooth 5 Hz track from a ~1 Hz receiver. |
| Logging | 5 Hz on a drift-free 200 ms grid. Each row has the fused state and the raw inputs (see [columns](#sample-columns)). Start/stop with a name and notes per test case. Sessions left open by a crash or a killed tab are closed on the next launch and marked *interrupted*. |
| Skyhook | Marks the current fused position. The plot recentres on the spot, draws a line to the vessel and shows the live distance and bearing. Every mark/clear is logged with time and position (also when a recording starts with a spot already set). |
| Visualiser | Vessel-centred (or skyhook-centred) top-down plot, north-up or heading-up, fading breadcrumb trail, GNSS accuracy disc, 30 s velocity vector, range rings, scale bar, auto-range, pinch/wheel zoom (double-tap returns to auto). |
| Storage | IndexedDB on the device. "Keep data" asks the browser for persistent storage. |
| Sync | Chunked JSON POSTs to your endpoint, resumable per session, retried with back-off, triggered when online, every 20 s, after a stop, or with "Sync now". Optional auth header. |
| Playback | Replays any session on the same plot with a scrubber and 1–30× speed, including skyhook marks at the time they were made. |
| Export | CSV (samples) or JSON (session + events + samples), via the share sheet on phones. |
| Offline | Service worker caches the app shell (and web fonts after first load). Installable to the home screen. |

## Running it

Sensors only work in a **secure context** (HTTPS, or `http://localhost`).

```bash
npm start            # static dev server on http://localhost:8080
npm run receiver     # reference upload receiver on http://localhost:8787/ingest
npm test             # unit tests (filters, attitude maths, geodesy)
npm install && npm run test:e2e   # Playwright end-to-end run with simulated sensors
```

To use it on a phone, host the files over HTTPS. The repo includes a GitHub Pages workflow
(`.github/workflows/pages.yml`, runs on pushes to `main` and the current default branch): enable **Settings → Pages → Source:
GitHub Actions**, then open `https://<user>.github.io/gnsslog/`. Any static host works — the app
is plain files (`index.html`, `manifest.webmanifest`, `sw.js`, `css/`, `js/`, `icons/`), no build.

Then on the phone:

1. Open the URL, **Add to Home Screen** (iOS: Share → Add to Home Screen; Android: Install app).
2. Tap **Enable** on the Live tab (iOS asks for Motion & Orientation access; both ask for Location).
3. Settings → set **Phone mounting** (flat with the top edge to the bow, or upright with the back
   camera to the bow), **mounting offset** if the phone is not aligned with the keel, and the local
   **magnetic declination** so headings are true.
4. Settings → **Endpoint URL** (and auth header if needed) for cloud upload.

### Field notes

- Keep the app in the foreground while recording. A screen wake lock is held during a recording;
  mobile browsers suspend web pages (and their GPS/sensor feeds) when the screen is locked or the
  app is backgrounded.
- Phones deliver GNSS at about 1 Hz; the 5 Hz rows are Kalman-predicted between fixes.
  `gnssNew = 1` marks the rows where a new fix arrived, and the raw fix is in the `gnss*` columns.
- Keep the phone away from steel, speakers and motors; check the diagnostics line at the bottom
  of Settings → Heading sensor while turning slowly through 360°.
- If heading moves the wrong way during turns before catching up, flip **Invert gyro yaw**.

## Upload API (schema `gnsslog/1`)

`POST <endpoint>` with `Content-Type: application/json` and, if configured, your auth header.
Each request carries the full session metadata plus one chunk of samples (up to 1000):

```json
{
  "schema": "gnsslog/1",
  "sentAt": "2026-10-01T07:00:25.123Z",
  "session": {
    "id": "8f0c…", "name": "Test 2026-10-01 07:00", "notes": "",
    "createdAt": 1790838000000, "startedAt": 1790838000000, "endedAt": 1790838360000,
    "status": "done", "interrupted": false, "sampleHz": 5, "sampleCount": 1800,
    "origin": { "lat": 1.264, "lon": 103.84 },
    "events": [
      { "type": "start", "t": 1790838000000, "seq": 0 },
      { "type": "skyhook", "t": 1790838012000, "seq": 60, "lat": 1.2640123, "lon": 103.8400456,
        "x": 1.32, "y": 1.37, "acc": 3.1, "markedAt": 1790838012000 },
      { "type": "skyhook_clear", "t": 1790838200000, "seq": 1000 },
      { "type": "stop", "t": 1790838360000, "seq": 1800 }
    ],
    "metaVersion": 4, "device": { "ua": "…", "name": "Tender 2" }, "config": { "mount": "flat", … },
    "app": { "version": "0.1.0" }
  },
  "chunk": { "from": 0, "to": 999, "count": 1000 },
  "samples": [ { "seq": 0, "t": 1790838000000, "iso": "…", "lat": 1.264, … } ],
  "final": false
}
```

- Respond with any `2xx` to acknowledge; anything else is retried later.
- Chunks are idempotent by `(session.id, chunk.from … chunk.to)` — a chunk can arrive twice if a
  response was lost. `final: true` is set on the last chunk of a finished session.
- Metadata-only updates (rename, notes, new events) arrive with `count: 0`. Keep the session
  meta with the highest `metaVersion`.
- The endpoint must allow CORS from the app's origin (`POST`, `Content-Type`, your auth header).

`server/receiver.mjs` is a dependency-free reference implementation that stores chunks on disk
and serves `GET /sessions` and `GET /sessions/<id>.csv`. Set `RECEIVER_TOKEN` to require
`Authorization: Bearer <token>`.

### Sample columns

| Column | Meaning |
|---|---|
| `seq`, `t`, `iso` | Row index, epoch ms, ISO time |
| `lat`, `lon` | Fused position (WGS84) |
| `x`, `y` | Fused position in metres East/North of `session.origin` |
| `vx`, `vy` | Fused velocity East/North (m/s) |
| `sog`, `cog` | Fused speed (m/s) and course over ground (°T) |
| `hdg`, `hdgMag` | Filtered heading, true and magnetic (°) |
| `hdgRate` | Bias-corrected rate of turn (°/s, + = to starboard) |
| `hdgSigma`, `hdgSrc` | Heading 1σ (°) and source (`compass`, `cog`, `none`) |
| `gyroRate`, `gyroBias` | Raw gyro yaw rate and estimated bias (°/s) |
| `compass` | Raw magnetometer heading of the mount (°M) |
| `pitch`, `roll` | Device beta/gamma (°) |
| `posSigma` | Position filter 1σ (m) |
| `gnssAcc`, `gnssAge`, `gnssNew` | Last fix accuracy (m), its age (ms), 1 if the fix is new on this row |
| `gnssT`, `gnssLat`, `gnssLon`, `gnssAlt`, `gnssSpeed`, `gnssCog` | Raw last fix |
| `skyDist`, `skyBrg` | Distance (m) and bearing (°T) from the vessel to the skyhook spot |

## Code map

```
index.html            screens: Live, Sessions, Settings, Playback (pushed)
css/app.css           Aurora Ink tokens + components
js/app.js             wiring, 5 Hz ticker, UI
js/sensors.js         Geolocation / DeviceOrientation / DeviceMotion + iOS permissions
js/attitude.js        rotation maths: mount heading, gyro yaw projection
js/filters.js         HeadingKF, PositionKF
js/fusion.js          sensor fusion, skyhook state
js/recorder.js        sessions, 5 Hz rows, events, wake lock
js/db.js              IndexedDB
js/sync.js            chunked resumable uploader
js/visualizer.js      canvas plot
js/export.js          CSV / JSON export
sw.js                 offline cache
server/               dev server + reference receiver
tests/                unit tests + Playwright e2e
```
