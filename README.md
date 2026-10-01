# GNSS Log

A Progressive Web App that turns a phone (iPhone or Android) into a vessel sensor and recorder.
It logs position, speed, x/y velocity and heading at **5 Hz** with timestamps, keeps every test
case on the device, uploads it to your cloud endpoint whenever there is a connection, and shows a
top-down plot with breadcrumbs and a **Skyhook** station-keeping view.

UI follows the "Aurora Ink" design rules (dark/light/system themes, glass surfaces, gradient
only on the primary actions) remixed to a **"Tidewater" sea-teal and coral** palette: teal and coral are complementary, so
the deep-teal canvas stays calm while coral marks the things you act on (record, selected tab,
switches, the vessel). Breadcrumbs and the skyhook marker are aqua so they read against the
coral vessel.

| Token | Dark | Light |
|---|---|---|
| Canvas | `#041113` | `#F1F7F6` |
| Surfaces | `#0A1A1D` / `#0F2428` / `#173236` | `#FFFFFF` / `#E3F0EE` / `#D2E5E2` |
| Text | `#EEF6F4` / `#9CB9B6` / `#5E7D7A` | `#072226` / `#3F5E5D` / `#86A19F` |
| Coral gradient | `#F2685A` → `#FF8A6B` → `#FFBB8F` (ink `#2A0F0B` on top) | same; accent text `#C2412F` |
| Aqua (trail, skyhook) | `#2DD4BF` / `#5EEAD4` | `#0F766E` / `#0E7490` |
| Status | success `#4ADE80`, warning `#FACC15`, error `#FF3D6E` | same |

All colours are tokens at the top of `css/app.css`; the canvas plot reads them at runtime.

## Features (v0.1)

| Area | What it does |
|---|---|
| Sensors | GNSS via the Geolocation API (high accuracy), magnetometer heading via `deviceorientationabsolute` (Android) / `webkitCompassHeading` (iOS), gyroscope via `devicemotion`. |
| Heading filter | 2-state Kalman filter (heading, gyro bias). The gyro yaw rate (projected onto the vertical, so it works when the phone is tilted) drives the prediction; the compass corrects it with innovation gating against magnetic disturbances. With no compass it falls back to GNSS course over ground while making way. |
| Compass deviation | Learns heading-dependent compass error (magnets such as MagSafe rings, steel, mounts) from GNSS course while running straight above ~4 kn, using the ship's-compass model A + B·sinθ + C·cosθ + D·sin2θ + E·cos2θ. Applied to the compass before the heading filter. Toggle and reset in Settings → Heading sensor; it also absorbs average crab angle, so reset it if you change the mount. |
| Position filter | 4-state constant-velocity Kalman filter (x, y, vx, vy) in a local East/North frame. Fuses GNSS position and GNSS (Doppler) velocity and gives a smooth 5 Hz track from a ~1 Hz receiver. |
| Logging | 5 Hz on a drift-free 200 ms grid. Each row has the fused state and the raw inputs (see [columns](#sample-columns)). Start/stop with a name and notes per test case. Sessions left open by a crash or a killed tab are closed on the next launch and marked *interrupted*. |
| Skyhook | Marks the current fused position. The plot recentres on the spot, draws a line to the vessel and shows the live distance and bearing. Every mark/clear is logged with time and position (also when a recording starts with a spot already set). |
| Visualiser | Vessel-centred (or skyhook-centred) top-down plot, north-up or heading-up, fading breadcrumb trail, GNSS accuracy disc, dashed 30 s velocity vector (where the vessel will be in 30 s on its current course and speed), range rings, scale bar, auto-range, pinch/wheel zoom (double-tap returns to auto). |
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

- **Keep the app on screen while recording.** A screen wake lock is held during a recording, but
  phones freeze web apps that are not visible (GPS and sensor feeds stop) and Android later
  discards them, even with Samsung's "keep open". To use other apps at the same time, put GNSS
  Log in **split screen** or **pop-up view** so it stays visible.
- When the app goes to the background the recording **pauses** (no rows are written, a `pause`
  event is logged) and **resumes** when it comes back (`resume` event with `gapMs`). If the phone
  closed the app, reopening it offers **Continue recording** in the same test case. Each
  continuation increments the `segment` column, so gaps are easy to split on.
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
      { "type": "pause", "t": 1790838300000, "seq": 1500, "reason": "background" },
      { "type": "resume", "t": 1790838330000, "seq": 1500, "reason": "foreground", "gapMs": 30000, "segment": 1 },
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
| `segment` | 0 at start; +1 after each pause/resume or app reopen (rows within a segment are continuous 5 Hz) |
| `lat`, `lon` | Fused position (WGS84) |
| `x`, `y` | Fused position in metres East/North of `session.origin` |
| `vx`, `vy` | Fused velocity East/North (m/s) |
| `sog`, `cog` | Fused speed (m/s) and course over ground (°T) |
| `hdg`, `hdgMag` | Filtered heading, true and magnetic (°) |
| `hdgRate` | Bias-corrected rate of turn, low-pass filtered (°/s, + = to starboard; time constant in Settings) |
| `hdgSigma`, `hdgSrc` | Heading 1σ (°) and source (`compass`, `cog`, `none`) |
| `gyroRate`, `gyroBias` | Raw gyro yaw rate and estimated bias (°/s) |
| `compass` | Raw magnetometer heading of the mount (°M) |
| `compassDev` | Learned deviation correction applied to `compass` (°) |
| `pitch`, `roll` | Device beta/gamma (°) |
| `posSigma` | Position filter 1σ (m) |
| `gnssAcc`, `gnssAge`, `gnssNew` | Last fix accuracy (m), its age (ms), 1 if the fix is new on this row |
| `gnssT`, `gnssLat`, `gnssLon`, `gnssAlt`, `gnssSpeed`, `gnssCog` | Raw last fix |
| `skyActive` | 1 while a skyhook spot is set, else 0 |
| `skyEvent` | On the row where it happened: `mark` (marked or re-marked), `clear`, or `active` (spot already set when the recording started); empty otherwise |
| `skyLat`, `skyLon` | The active skyhook spot (empty when none) |
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
