# GNSS Log — Upload Interface Control Document (ICD)

| | |
|---|---|
| Interface | GNSS Log app → receiving server ("ingest") |
| Schema identifier | `gnsslog/1` |
| Document version | 1.1 (2026-10-03), matches app 0.9.0 |
| Reference implementations | `hub/server.mjs` + `hub/store.mjs` (SQLite, full), `server/receiver.mjs` (files, minimal) |
| Conformance tests | `tests/hub.test.mjs` |

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

## 1. Scope

The GNSS Log app (Android app and PWA) records position, motion and heading at 5 Hz and uploads
each recording ("session") to a server the user configures. This document specifies everything a
server needs to receive those uploads: transport, authentication, message format, field
semantics, delivery guarantees and the expected responses.

Section 9 describes the read API of the GNSS Log hub. It is informative: a server only needs it to
be compatible with the GNSS Log Analyzer web app.

## 2. Overview

```
 GNSS Log app                                     Server
 ────────────                                     ──────
 records 5 Hz samples to on-device storage
 every 3 s while recording / 20 s otherwise:
   for each session, oldest first:
     POST <endpoint>  { session meta, chunk of samples }  ──▶  store (idempotent)
                                                          ◀──  2xx
     (repeat until all samples and the latest metadata are sent)
 on any non-2xx, timeout or network error: retry later with backoff
```

- Upload is **push only**: the server never calls the app.
- Delivery is **at least once**: the same chunk can arrive more than once, so the server MUST
  store idempotently.
- The app keeps all data until it is uploaded. A server that is offline only delays uploads.

## 3. Transport

| Item | Requirement |
|---|---|
| Method | `POST` |
| URL | The endpoint URL configured in the app (Settings → Cloud upload → Endpoint URL), used verbatim, e.g. `https://logs.example.com/ingest`. Any path is allowed. |
| Scheme | HTTPS. The PWA runs on HTTPS and browsers block uploads to `http://`. The Android app can use `http://` on a LAN, but this is not recommended. |
| Request body | One JSON object (section 5), UTF-8 |
| Request headers | `Content-Type: application/json`, plus the authentication header (section 4) |
| Request size | Up to ~0.8 MB with the default chunk size (1000 samples × ~0.7 kB). The server MUST accept at least 5 MB; 20 MB or more is recommended. |
| Client timeout | 30 s per request |
| Compression | Request bodies are not compressed |

### 3.1 CORS (required for the PWA)

The PWA posts from its own origin (e.g. `https://gnsslog.wwweeeiii.com`), so browsers send a CORS
preflight first. The Android app does not need CORS, but a server SHOULD always support it:

- `OPTIONS <endpoint>` → `204` with
  - `Access-Control-Allow-Origin: *` (or the PWA's origin)
  - `Access-Control-Allow-Methods: POST, OPTIONS`
  - `Access-Control-Allow-Headers: Content-Type, Authorization, X-API-Key`, plus any custom auth
    header name the users will configure
  - `Access-Control-Max-Age: 86400` (recommended)
- The `POST` response MUST also carry `Access-Control-Allow-Origin`.

## 4. Authentication

The app sends one header whose **name** and **value** the user configures:

| App setting | Default | Example |
|---|---|---|
| Auth header | `Authorization` | `Authorization` or `X-API-Key` |
| Value | *(empty: no header sent)* | `Bearer 3f9a…` |

- The server decides the scheme. The reference hub accepts `Authorization: Bearer <token>` or
  `X-API-Key: <token>` and compares in constant time.
- On a bad or missing credential the server SHOULD respond `401`. The app shows the status in its
  sync status and keeps retrying with backoff (section 7), so a fixed credential resumes uploads
  without losing data.
- The auth value is never included in the message body. The session's `config` snapshot excludes
  it.

## 5. Message format (`gnsslog/1`)

Every request body is one object:

| Field | Type | Description |
|---|---|---|
| `schema` | string | Always `"gnsslog/1"`. A server MUST reject (4xx) other values it does not understand. |
| `sentAt` | string | ISO 8601 UTC time the request was built. Informative only. |
| `session` | object | Full, current session metadata (section 5.1). Sent with every chunk. |
| `chunk` | object | `{ from, to, count }`: sample sequence numbers in this request (section 5.3). |
| `samples` | array | Sample objects (section 5.2), ascending `seq`, at most the configured chunk size (default 1000). May be empty (metadata-only update). |
| `final` | boolean | `true` when the session is finished (status `done`) and this request carries (or follows) its last sample. Once `true` it stays `true` on later metadata-only requests for that session. |

Unknown fields MUST be ignored, at every level. New fields are added without changing the schema
identifier. A breaking change gets a new identifier (`gnsslog/2`).

### 5.1 Session metadata

| Field | Type | Description |
|---|---|---|
| `id` | string | Session id, a UUID (RFC 4122, lowercase). Unique per recording; the primary key. Pattern `^[A-Za-z0-9-]{8,64}$`. |
| `name` | string | User-given name, e.g. `"Harbour run 3"`. May change (rename). |
| `notes` | string | Free text. May change. |
| `createdAt` | number | Unix ms when the session was created. |
| `startedAt` | number | Unix ms when recording started. |
| `endedAt` | number \| null | Unix ms when it stopped; `null` while recording. |
| `status` | string | `"recording"` or `"done"`. |
| `interrupted` | boolean | `true` if the app was killed while recording and the session was closed or continued on the next start. |
| `sampleHz` | number | Nominal sample rate, `5`. |
| `sampleCount` | number | Samples recorded so far on the phone (= highest `seq` + 1). Can be ahead of what the server has received. |
| `origin` | object \| null | `{ lat, lon }` (degrees): origin of the local `x`/`y` frame used by the samples. |
| `events` | array | All session events so far, in order (section 5.4). |
| `metaVersion` | number | Increases whenever any metadata changes (events, name, notes, status). Section 6.2. |
| `device` | object | `{ ua, name, perm? }`: browser/WebView user agent, the user-set device name (may be `null`) and, in the Android app, `perm: { location: "always" \| "while-using" \| "denied", battery: "unrestricted" \| "optimised" }`. |
| `config` | object | Snapshot of the app settings at recording start (declination, mounting, filter tuning, …), auth value removed. Informative; keys may change between app versions. |
| `app` | object | `{ version }`, e.g. `"0.8.4"`. |

### 5.2 Samples

One object per 5 Hz sample (every 200 ms). All numbers are JSON numbers; a missing value is
`null` (or, for the string fields, an empty string). Coordinates are WGS84. Angles are degrees,
0–360, clockwise from north unless noted. "Fused" values come from the app's Kalman filters;
"raw" values come straight from the sensor.

| Field | Type | Unit | Description |
|---|---|---|---|
| `seq` | integer | – | Sample number within the session: 0, 1, 2, … contiguous. With `session.id`, the unique key. |
| `t` | integer | Unix ms | Sample time, on a 200 ms grid. Monotonic; a jump of more than 200 ms means a pause or gap (see `segment` and events). |
| `iso` | string | – | `t` as ISO 8601 UTC. |
| `segment` | integer | – | Starts at 0; increases after each pause, gap or app restart. Lines should not be drawn across segments. |
| `lat`, `lon` | number | deg | Fused position. `null` before the first fix. |
| `x`, `y` | number | m | Fused position East/North of `session.origin` (local tangent plane). |
| `vx`, `vy` | number | m/s | Fused velocity East/North. |
| `sog` | number | m/s | Fused speed over ground. |
| `cog` | number | deg | Fused course over ground (true); `null` below 0.2 m/s. |
| `hdg` | number | deg | Fused heading of the vessel (true north): gyro + compass, Kalman filtered. |
| `hdgMag` | number | deg | `hdg` relative to magnetic north (`hdg` − declination). |
| `hdgRate` | number | deg/s | Rate of turn, low-pass filtered. Positive = turning clockwise (to starboard). |
| `hdgSigma` | number | deg | 1-σ heading uncertainty from the filter. |
| `hdgSrc` | string | – | What corrects the heading: `compass`, `cog` (GNSS course, no compass), `gyro` (dead reckoning), `none`. |
| `gyroRate` | number | deg/s | Raw gyro yaw rate (same sign convention as `hdgRate`), bias not removed. |
| `gyroBias` | number | deg/s | Gyro bias estimated by the filter. |
| `compass` | number | deg | Raw magnetometer heading of the mounting (magnetic), before deviation correction. |
| `compassDev` | number | deg | Compass deviation correction applied (learned from GNSS course). |
| `mount` | string | – | Phone mounting used for the heading: `flat` (screen up) or `upright` (screen facing aft). |
| `pitch`, `roll` | number | deg | Phone attitude (W3C DeviceOrientation beta / gamma). |
| `posSigma` | number | m | 1-σ position uncertainty from the filter. |
| `gnssAcc` | number | m | Accuracy reported with the latest GNSS fix (~68 % horizontal radius). |
| `gnssAge` | integer | ms | Age of the latest GNSS fix at `t`. |
| `gnssNew` | integer | 0/1 | 1 if a new GNSS fix arrived since the previous sample. |
| `gnssT` | integer | Unix ms | Time stamp of the latest GNSS fix. |
| `gnssLat`, `gnssLon` | number | deg | Raw position of the latest GNSS fix. |
| `gnssAlt` | number | m | Raw altitude of the latest fix (above the WGS84 ellipsoid on Android). |
| `gnssSpeed` | number | m/s | Raw speed of the latest fix. |
| `gnssCog` | number | deg | Raw course of the latest fix (true). |
| `markActive` | integer | 0/1 | 1 while a marked location is set. |
| `markEvent` | string | – | `mark`, `clear` or `active` on the sample where that happened (several joined with `;`), else `""`. |
| `markLat`, `markLon` | number | deg | The marked location, while set. |
| `markDist` | number | m | Distance from the vessel to the marked location. |
| `markBrg` | number | deg | Bearing from the vessel to the marked location (true). |

Servers MUST accept and store fields not listed here (new ones are added over time). The
reference hub turns every new field into a database column automatically.

### 5.3 Chunks

- `chunk.from`: the first `seq` the app has not had acknowledged before this request.
- `chunk.to`: the `seq` of the last sample in `samples`. When `samples` is empty, `to` = `from − 1`.
- `chunk.count`: the number of samples in this request (`samples.length`).
- Samples in a request are contiguous and ascending (`from` … `to`).
- A chunk whose response was lost is sent again with the same range. After an app reinstall or
  data reset, ranges can start over from 0.

### 5.4 Events

`session.events` is the session's full, ordered event list, sent with every chunk. Each event has
`type`, `t` (Unix ms) and `seq` (the next sample number at that moment), plus fields per type:

| `type` | Extra fields | Meaning |
|---|---|---|
| `start` | – | Recording started (`seq` 0). |
| `stop` | `reason?` (`"interrupted"`) | Recording stopped (`seq` = sample count). |
| `pause` | `reason` (`"background"`) | Web app hidden: sampling paused. |
| `resume` | `reason` (`"foreground"`, `"reopened"`), `gapMs`, `segment` | Sampling resumed after a pause or app restart. |
| `mark` | `lat`, `lon`, `x`, `y`, `acc`, `markedAt` | User marked the current position. |
| `mark_active` | same as `mark` | A previously marked location still applies (new session, resumed session, trimmed copy). |
| `mark_clear` | – | Marked location cleared. |
| `gap` | `gapMs`, `segment` | Android app: no data at all for this stretch (the whole app was frozen). |
| `catchup` | `frozenMs`, `frames`, `fixes`, `samples`, `holes`, `gnssService?`, `gnssOn?`, `gnssProvider?`, `gnssLogged?`, `gnssLastFixAgoMs?`, `gnssError?` | Android app: data missed by a frozen WebView was recovered from the native log, with the state of the native GNSS listener (diagnostic). |
| `late` | `spanMs`, `maxLagMs`, `frames` | Android app: data arrived late in a burst and was placed at its real time (diagnostic). |

Unknown event types MUST be ignored or stored as they are.

## 6. Server behaviour

### 6.1 Storing samples (idempotent)

- The unique key of a sample is (`session.id`, `seq`).
- Receiving a sample that already exists MUST NOT create a duplicate. Overwriting it with the same
  content (upsert) is correct.
- Chunks can arrive more than once and, in rare cases (several devices or retries racing), out of
  order. The server SHOULD not assume `from` equals its current count.
- Rows MUST be ordered by `seq` (equivalently `t`) when read back.

### 6.2 Storing metadata

- Store the `session` object from the request if its `metaVersion` is **greater than or equal to**
  the stored one; otherwise keep the stored one (an older retry arrived late).
- Metadata changes without new samples (rename, notes, a mark cleared after the last upload) come
  as requests with an empty `samples` array.
- If the server lets its own users edit names or notes, it SHOULD keep those edits separately so
  a later upload does not overwrite them (the reference hub stores them as `edits`).

### 6.3 Session lifecycle

| Phase | `status` | `final` | What the server sees |
|---|---|---|---|
| Recording | `recording` | `false` | A chunk every ~3 s (5 Hz → ~15 samples per request) |
| Phone offline | – | – | Nothing; afterwards a backlog in chunks of up to 1000 samples |
| Stopped | `done` | `true` from the request carrying the last sample | `endedAt` set, `stop` event |
| Late edits | `done` | `true` | Metadata-only requests |

A session is **live** while uploads keep arriving and it is not `done`. The reference hub treats a
session as live if it received data within the last 2 minutes and `final` was never `true`.

### 6.4 Deleted sessions

If a user deletes a session on the server while the phone is still uploading it, the server
SHOULD keep a tombstone and answer later uploads for that id with `2xx` (and discard them).
Otherwise the session reappears. Answering `4xx` would make the app retry indefinitely.

### 6.5 Data from older app versions

Version 0.6.3 and earlier called the marked location "skyhook". Servers SHOULD map these names:

| Old | New |
|---|---|
| event `skyhook`, `skyhook_clear`, `skyhook_active` | `mark`, `mark_clear`, `mark_active` |
| sample `skyActive`, `skyEvent`, `skyLat`, `skyLon`, `skyDist`, `skyBrg` | `markActive`, `markEvent`, `markLat`, `markLon`, `markDist`, `markBrg` |

## 7. Responses and retries

| Server response | App behaviour |
|---|---|
| `2xx` | Accepted. The app records the chunk as sent and continues. The body is ignored. A JSON body such as `{"ok":true,"session":"…","received":15}` is recommended for debugging. |
| Any other status (`4xx`, `5xx`) | The whole upload pass stops (nothing after this request is sent, for any session) and the status text is shown to the user. Retried with exponential backoff: 5 s, 10 s, 20 s … up to 5 min, and immediately when the device comes back online or the user taps sync. |
| Timeout (30 s) or network error | Same as above. |

Consequences for server implementers:

- **A `4xx` is never final.** The app retries the same chunk forever, and nothing after it is sent,
  for this or any other session. Use `4xx` only for problems the user can fix (credentials, schema). Answer
  `2xx` for anything you choose to drop (duplicates, deleted sessions).
- Respond within a few seconds. Writing should be transactional, so a retried chunk never leaves
  half a chunk behind.

Recommended codes: `200` accepted, `400` malformed JSON / unknown schema / bad session id,
`401` bad credential, `413` too large, `5xx` server fault.

## 8. Examples

### 8.1 A chunk while recording

```http
POST /ingest HTTP/1.1
Host: logs.example.com
Content-Type: application/json
Authorization: Bearer 3f9a0c1e5b7d…
```

```json
{
  "schema": "gnsslog/1",
  "sentAt": "2026-10-02T01:36:42.310Z",
  "session": {
    "id": "3f2b9c1e-6a4d-4c8e-9b7a-2d5e8f1a0c34",
    "name": "Harbour run 3",
    "notes": "",
    "createdAt": 1790904598120,
    "startedAt": 1790904600000,
    "endedAt": null,
    "status": "recording",
    "interrupted": false,
    "sampleHz": 5,
    "sampleCount": 2012,
    "origin": { "lat": 1.2655, "lon": 103.8302 },
    "events": [
      { "type": "start", "t": 1790904600000, "seq": 0 },
      { "type": "mark", "t": 1790905000000, "seq": 2000, "lat": 1.26797569, "lon": 103.83901668, "x": 981.2, "y": 273.6, "acc": 3, "markedAt": 1790905000000 }
    ],
    "metaVersion": 2,
    "device": { "ua": "Mozilla/5.0 (Linux; Android 16; SM-S928B …) …", "name": "Tender 2" },
    "config": { "declination": 0, "mount": "auto", "compassSigma": 6, "rateSmoothing": 0.5 },
    "app": { "version": "0.8.4" }
  },
  "chunk": { "from": 1997, "to": 2011, "count": 15 },
  "samples": [
    {
      "seq": 2010, "t": 1790905002000, "iso": "2026-10-02T01:36:42.000Z", "segment": 0,
      "lat": 1.26798349, "lon": 103.83902762, "x": 982.485, "y": 274.838, "vx": 0.59, "vy": 0.472,
      "sog": 0.721, "cog": 51.35,
      "hdg": 53.69, "hdgMag": 53.69, "hdgRate": -0.109, "hdgSigma": 1.71, "hdgSrc": "compass",
      "gyroRate": -0.77, "gyroBias": 0.0981, "compass": 52.9, "compassDev": 0.8, "mount": "flat",
      "pitch": -0.74, "roll": -1.75,
      "posSigma": 1.8, "gnssAcc": 3.6, "gnssAge": 180, "gnssNew": 1, "gnssT": 1790905001820,
      "gnssLat": 1.2679836, "gnssLon": 103.8390281, "gnssAlt": 6.2, "gnssSpeed": 0.724, "gnssCog": 50.9,
      "markActive": 1, "markEvent": "", "markLat": 1.26797569, "markLon": 103.83901668,
      "markDist": 1.494, "markBrg": 214.1
    }
  ],
  "final": false
}
```

(`samples` shows one of the 15 samples.)

### 8.2 The last chunk of a finished session (abridged)

Same structure as 8.1; the differences:

```json
{
  "schema": "gnsslog/1",
  "sentAt": "2026-10-02T01:45:00.120Z",
  "session": {
    "id": "3f2b9c1e-6a4d-4c8e-9b7a-2d5e8f1a0c34",
    "status": "done",
    "endedAt": 1790905499800,
    "sampleCount": 4375,
    "metaVersion": 5,
    "events": [
      { "type": "start", "t": 1790904600000, "seq": 0 },
      { "type": "mark", "t": 1790905000000, "seq": 2000, "lat": 1.26797569, "lon": 103.83901668, "x": 981.2, "y": 273.6, "acc": 3, "markedAt": 1790905000000 },
      { "type": "mark_clear", "t": 1790905360000, "seq": 3675 },
      { "type": "stop", "t": 1790905499800, "seq": 4375 }
    ]
  },
  "chunk": { "from": 4362, "to": 4374, "count": 13 },
  "samples": [],
  "final": true
}
```

(`session` shows only the fields that changed; the app always sends all of them. `samples` holds
the 13 samples 4362–4374.)

### 8.3 A metadata-only update (renamed after upload, abridged)

```json
{
  "schema": "gnsslog/1",
  "sentAt": "2026-10-02T03:10:00.000Z",
  "session": { "id": "3f2b9c1e-6a4d-4c8e-9b7a-2d5e8f1a0c34", "name": "Harbour run 3 (good)", "metaVersion": 6 },
  "chunk": { "from": 4375, "to": 4374, "count": 0 },
  "samples": [],
  "final": true
}
```

### 8.4 Response

```http
HTTP/1.1 200 OK
Content-Type: application/json
Access-Control-Allow-Origin: *

{"ok":true,"session":"3f2b9c1e-6a4d-4c8e-9b7a-2d5e8f1a0c34","received":15,"to":2011,"sampleCount":2012}
```

## 9. GNSS Log hub read API (informative)

A server that also wants to work with the GNSS Log Analyzer web app implements these endpoints on
the same origin as the Analyzer. Times are Unix ms. In the reference hub they sit behind
Cloudflare Access.

| Method | Path | Response |
|---|---|---|
| GET | `/api/health` | `{ ok, version, node, user }` |
| GET | `/api/sessions` | Array of summaries: `id, name, notes, startedAt, endedAt, status, device, app, source (phone\|import\|trim), parentId, final, live, sampleCount, maxSeq, firstT, lastT, receivedAt, marks, stats` |
| GET | `/api/sessions/:id` | Summary + `events, origin, config, meta, columns, stats` |
| GET | `/api/sessions/:id/samples?t0&t1&afterSeq&cols=a,b&limit` | `{ columns: [...], rows: [[...], ...] }`, ordered by `seq`. `seq` and `t` are always the first two columns. |
| GET | `/api/sessions/:id/export.{csv\|json\|gpx\|geojson\|kml}?t0&t1&every&cols` | File download (`Content-Disposition: attachment`). `every` = minimum ms between rows. `json` is a GNSS Log export: `{ schema, session, samples }`. |
| PATCH | `/api/sessions/:id` | Body `{ name?, notes? }` → updated session |
| DELETE | `/api/sessions/:id` | `{ ok: true }`; later uploads for the id are ignored (2xx) |
| POST | `/api/sessions/:id/trim` | Body `{ t0, t1, name?, deleteOriginal? }` → the new session. `409` if `deleteOriginal` while the original is live. |
| POST | `/api/import` | Body: a GNSS Log JSON export → `{ ok, session, received, sampleCount }` |
| GET | `/api/stream` | Server-sent events, one JSON message per change: `{ type: "session", session }` or `{ type: "deleted", id }` |

`stats` = `{ samples, start, end, duration (s), distance (m), maxSog, avgSog (m/s), movingTime (s), bbox [minLat, minLon, maxLat, maxLon], minMarkDist, maxMarkDist }`.

## 10. Checklist for implementers

- [ ] `POST` on the endpoint accepts JSON bodies of at least 5 MB
- [ ] `OPTIONS` preflight answered with the CORS headers in 3.1
- [ ] Authentication header checked; `401` when wrong
- [ ] `schema` checked; unknown schema → `400`
- [ ] Samples upserted by (`session.id`, `seq`); repeated chunks harmless
- [ ] Metadata replaced only when `metaVersion` ≥ stored
- [ ] Empty `samples` arrays accepted (metadata-only updates)
- [ ] Unknown fields and event types kept or ignored, never rejected
- [ ] `2xx` for anything deliberately dropped (duplicates, deleted sessions)
- [ ] Old `sky*` field names mapped (if supporting data from app ≤ 0.6.3)
- [ ] Tested with the app: Settings → Cloud upload → Endpoint URL + auth, record a minute, check the sync status shows "Synced"

## 11. Revision history

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-02 | First issue (app 0.8.4). |
| 1.1 | 2026-10-03 | `device.perm`; GNSS diagnostics on `catchup` events (app 0.9.0). |
