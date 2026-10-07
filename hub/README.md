# GNSS Log hub

Receives recordings from the GNSS Log phone app while they are being recorded, stores them in
SQLite and serves the **Analyzer**: a web app (installable PWA) to replay, analyse, trim and
export them.

```
phone app ──POST https://logs.wwweeeiii.com/ingest──▶ Cloudflare (no login, token) ──┐
                                                                                     ├─tunnel─▶ mini PC: hub
browser ────https://logs.wwweeeiii.com────────────▶ Cloudflare Access (email login) ─┘          (Node.js + SQLite)
```

- **No open ports.** `cloudflared` connects out from the mini PC; Cloudflare handles HTTPS.
- **Private.** The Analyzer sits behind Cloudflare Access (free for up to 50 users). The hub
  verifies the Access login itself and refuses any request through Cloudflare without one (except
  `/ingest`), so a missing or too-broad Access rule fails closed. Uploads need the ingest token.
- **Nothing is lost when the PC is off.** The phone keeps every sample and uploads when the hub
  is reachable again. While recording it uploads every 3 s, so the Analyzer can follow live.
- **No dependencies.** Node.js 22.13+ only (built-in `node:sqlite`); no `npm install`.

## Set up the mini PC (Windows)

### 1. Create the tunnel (Cloudflare dashboard)

1. **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** → *Cloudflared* → name it
   e.g. `minipc`.
2. On the "Install connector" page, copy the **token** (the long string after
   `cloudflared service install`). The installer uses it in step 3.
3. Add one **public hostname**: `logs.wwweeeiii.com`, service `HTTP` → `localhost:8787`.
   Cloudflare creates the DNS record itself.

### 2. Protect the Analyzer with Cloudflare Access (and let uploads through)

**Zero Trust** → **Access** → **Applications** → **Add an application** → *Self-hosted*, twice:

| Application | Domain | Path | Policy |
|---|---|---|---|
| GNSS Log Analyzer | `logs.wwweeeiii.com` | *(empty)* | *Allow* → Include → *Emails* → your address (and anyone you share with) |
| GNSS Log uploads | `logs.wwweeeiii.com` | `ingest` | *Bypass* → Include → *Everyone* |

The phone cannot do the browser login, so the more specific `/ingest` application lets uploads
skip it; they are protected by the ingest token instead.

Note two values for the installer:

- **Team name**: Zero Trust → **Settings** → *Custom pages* → team domain
  `<team>.cloudflareaccess.com` (the `<team>` part).
- **AUD tag**: the application's **Overview** → *Application Audience (AUD) Tag*.

(Use the AUD of the *Analyzer* application, not the uploads one.) The hub checks the signature of
every Access login against your team's keys and this AUD, so nobody gets in by faking headers,
and if the bypass were ever set too broadly the hub would still only answer `/ingest`.

### 3. Run the installer on the mini PC

Download `hub/setup-windows.ps1` from this repository, then in an **administrator** PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup-windows.ps1 -TunnelToken "<token from step 1>" -AccessTeam "<team>" -AccessAud "<AUD tag>"
```

It installs Node.js LTS and `cloudflared` (via winget), puts the app in `C:\GNSSLog\app` and the
data in `C:\GNSSLog\data`, creates an ingest token, and registers the hub to start at boot and
restart if it stops. At the end it prints the phone settings. Run the same command again later to
**update** (data and token are kept). To run from a git checkout instead (updated with `git pull` on each run, data next to it in
`D:\GIT\gnsslog-data`):

```powershell
.\setup-windows.ps1 -AppDir D:\GIT\gnsslog -TunnelToken "…" -AccessTeam "…" -AccessAud "…"
```

From a git checkout the installer also registers **GNSS Log Hub Updater**: every 5 minutes it
fetches the branch and, when there are new commits, fast-forwards, restarts the hub and checks
`/api/health`. If the hub does not come back it returns to the previous commit and skips the bad
one until a newer commit arrives. A checkout with local changes is never touched. Log:
`<data>\update.log`. Turn it off with `-NoAutoUpdate`.

**Already running a Cloudflare tunnel on this PC for something else?** Add the public hostname
`logs.wwweeeiii.com` → `http://localhost:8787` to *that* tunnel and run the installer without
`-TunnelToken`. The installer never replaces another tunnel's service unless you pass
`-ReplaceTunnel`. If port 8787 is taken it stops and names the program; use `-Port <n>` and point
the public hostname at that port.

Options: `-InstallDir`, `-AppDir`, `-DataDir`, `-Port`, `-BackupDir`, `-ReplaceTunnel`,
`-AccessTeam` / `-AccessAud` (can be changed on any run), `-Uninstall`.

### 4. Pair the phones

Open the analyser at `https://logs.wwweeeiii.com` → **Phones → Pair a phone**. It shows a QR code
and a code valid for 10 minutes. On the phone: GNSS Log → **Settings → Cloud upload → Scan QR
code** (or **Enter code**: type the hub address and the code). Each phone gets its own upload key;
**Remove** in the same list revokes it. Sessions recorded before pairing upload too, oldest first.

Phones set up before pairing existed use the shared token from `hub-config.json`
(`ingestToken`). It keeps working until you **Switch off** the "Old shared key" in Phones.

Open `https://logs.wwweeeiii.com`, log in with your email, and install it as an app from the
browser menu if you like.

## Using the Analyzer

- **Sessions** list with duration, distance, top speed and a *Live* badge while uploading. Search,
  or **Import JSON** (a GNSS Log JSON export from the phone).
- **Track** (left): pan / zoom, *No map / Street / Satellite*, OpenSeaMap seamarks, colour by speed,
  *Follow* the vessel during playback, click the track to jump there. The marked location, the
  line to it and the distance are shown at the playback position.
- **Charts** (right): speed, heading/COG, rate of turn, distance to mark, velocity east/north,
  position accuracy, heading uncertainty, pitch/roll and gyro bias. Click to jump, **drag to
  select a time range**, scroll to zoom time, double-click for the full range.
- **Playback**: play/pause (Space), 0.5×–64×, timeline with a speed overview; selection edges can
  be dragged. ← / → step 1 s (Shift: 10 s). `[` / `]` set the selection start / end at the
  cursor.
- **Statistics** for the whole session, or for the selection once there is one.
- **Trim…** copies the selection into a new session (optionally deleting the original). Every
  column is kept, events are re-based, and a mark active at the start is carried in.
- **Export → Image**: *Report* (title, statistics, track and charts on one page), *Track* or
  *Charts*, as **SVG** (vector; the map, if shown, is embedded as an image), **JPG** or **PNG** at
  1–3×, light or dark, for the whole session, the current view or the selection.
- **Export → Data**: CSV (all or core columns), GNSS Log JSON (re-importable), GPX, GeoJSON or
  KML, for the whole session, the view or the selection, at 5 Hz, 1 Hz or every 5 s.

## Data, backups and SQL

- Database: `C:\GNSSLog\data\gnsslog.db` (SQLite). Log: `C:\GNSSLog\data\hub.log`.
- A consistent copy is written every day to `data\backups\gnsslog-YYYY-MM-DD.db`; the newest 14
  are kept. Set `-BackupDir` (or `backupDir` in `hub-config.json`) to a OneDrive / Google Drive
  folder for an off-site copy.
- Every sample field is its own column, so any SQLite tool (DB Browser for SQLite, `sqlite3`,
  Python/pandas) can query it, e.g. all fast turns:

  ```sql
  SELECT s.id, json_extract(s.meta, '$.name') AS name, datetime(t / 1000, 'unixepoch') AS utc, sog, hdgRate
  FROM samples JOIN sessions s ON s.id = samples.session_id
  WHERE sog > 2.5 AND abs(hdgRate) > 3
  ORDER BY t;
  ```

  Open the database read-only, or work on a backup copy, while the hub is running.

## API

The upload format (`/ingest`) is specified in [../docs/ICD.md](../docs/ICD.md).

All under `https://logs…` (needs the Access login) except `/ingest`.

| Method | Path | |
|---|---|---|
| POST | `/ingest` | phone uploads (schema `gnsslog/1`, `Authorization: Bearer <phone key>`) |
| POST | `/ingest/pair` | phone redeems a one-time pairing code for its own key |
| GET/POST/PATCH/DELETE | `/api/devices…` | paired phones, pairing codes, the old shared key on/off |
| GET | `/api/sessions` | list with statistics |
| GET | `/api/sessions/:id` | metadata, events, statistics, available columns |
| GET | `/api/sessions/:id/samples?t0=&t1=&afterSeq=&cols=a,b` | `{ columns, rows }` |
| GET | `/api/sessions/:id/export.{csv,json,gpx,geojson,kml}?t0=&t1=&every=&cols=` | download |
| PATCH | `/api/sessions/:id` | `{ name, notes }` |
| DELETE | `/api/sessions/:id` | later uploads for it are ignored |
| POST | `/api/sessions/:id/trim` | `{ t0, t1, name, deleteOriginal }` |
| POST | `/api/import` | GNSS Log JSON export |
| GET | `/api/stream` | server-sent events for live updates |

Times are Unix milliseconds.

## Running elsewhere

Any OS with Node.js 22.13+:

```sh
HUB_INGEST_TOKEN=secret node --disable-warning=ExperimentalWarning hub/server.mjs
# or: node hub/server.mjs --config path/to/hub-config.json
```

Config keys / environment variables: `port`/`HUB_PORT` (8787), `host`/`HUB_HOST` (127.0.0.1;
`0.0.0.0` opens it to the LAN **without a login**), `dataDir`/`HUB_DATA`,
`ingestToken`/`HUB_INGEST_TOKEN`, `backupDir`/`HUB_BACKUP_DIR`, `backupKeep`/`HUB_BACKUP_KEEP`,
`accessTeam`/`HUB_ACCESS_TEAM`, `accessAud`/`HUB_ACCESS_AUD`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Phone shows upload errors `401` | The phone was removed in Phones, or it used the old shared key after it was switched off: pair it again. |
| Pairing says "not a GNSS Log hub" | The hub is older than the app: wait for the auto-update (5 min) or re-run the installer. |
| Pairing hangs or shows a login page | The Cloudflare *Bypass* application must cover the path `ingest` and everything under it (`/ingest/pair`). |
| Phone shows `403` or a login page error | The *Bypass* application for path `ingest` on `logs.wwweeeiii.com` is missing. |
| Browser shows "Cloudflare Access is not configured on the hub" | Re-run the installer with `-AccessTeam` and `-AccessAud` (step 2). |
| Browser shows "Log in through Cloudflare Access" | The Access application for `logs.…` is missing, or its AUD differs from the one given to the installer. |
| `502` / `1033` from Cloudflare | Hub or tunnel not running: Task Scheduler → *GNSS Log Hub*; `Get-Service cloudflared`; `C:\GNSSLog\data\hub.log`. |
| Nothing new after an update | Git checkout: see `<data>\update.log` (updates arrive within 5 minutes). Otherwise re-run the installer. Then reload the Analyzer (it updates on the next visit). |
