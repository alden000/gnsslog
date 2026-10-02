// Data extraction formats, shared by the hub server (download endpoints) and the analyser.
//   csv      every (or chosen) sample column
//   json     GNSS Log export (schema gnsslog/1): can be imported again
//   gpx      GPX 1.1 track + marked locations as waypoints
//   geojson  LineString track + mark points
//   kml      Google Earth track + mark placemarks

export const FORMATS = {
  csv: { ext: 'csv', type: 'text/csv; charset=utf-8' },
  json: { ext: 'json', type: 'application/json' },
  gpx: { ext: 'gpx', type: 'application/gpx+xml' },
  geojson: { ext: 'geojson', type: 'application/geo+json' },
  kml: { ext: 'kml', type: 'application/vnd.google-earth.kml+xml' },
};

const MARK_TYPES = new Set(['mark', 'mark_active']);
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const fin = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const iso = (t) => new Date(Number(t)).toISOString();

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows (objects) with a usable position. */
function positions(rows) {
  return rows.filter((r) => fin(r.lat) && fin(r.lon));
}

/** Marked locations among the session events that fall inside [t0, t1]. */
export function marksIn(events = [], t0 = -Infinity, t1 = Infinity) {
  return events.filter((e) => MARK_TYPES.has(e.type) && fin(e.lat) && fin(e.lon) && e.t >= t0 && e.t <= t1);
}

/** Keep one row per `everyMs` (0 = all rows). */
export function decimate(rows, everyMs = 0) {
  if (!(everyMs > 0)) return rows;
  const out = [];
  let next = -Infinity;
  for (const r of rows) {
    if (r.t >= next) {
      out.push(r);
      next = r.t + everyMs - 1;
    }
  }
  return out;
}

/**
 * Serialise rows (sample objects) to a format.
 * meta: { id, name, notes, startedAt, events, ... } ; columns: CSV column order.
 */
export function serialize(format, { meta, rows, columns, events = meta?.events || [] }) {
  const name = meta?.name || 'GNSS Log session';
  const t0 = rows.length ? rows[0].t : 0;
  const t1 = rows.length ? rows[rows.length - 1].t : 0;
  const marks = marksIn(events, t0, t1);

  if (format === 'csv') {
    const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','));
    return lines.join('\n') + '\n';
  }

  if (format === 'json') {
    const session = { ...meta, events: events.filter((e) => e.t >= t0 && e.t <= t1), sampleCount: rows.length };
    return JSON.stringify({ schema: 'gnsslog/1', session, samples: rows });
  }

  if (format === 'geojson') {
    const pts = positions(rows);
    const features = [
      {
        type: 'Feature',
        properties: {
          name,
          start: rows.length ? iso(t0) : null,
          end: rows.length ? iso(t1) : null,
          coordTimes: pts.map((r) => iso(r.t)),
          sog: pts.map((r) => (fin(r.sog) ? Number(r.sog) : null)),
          hdg: pts.map((r) => (fin(r.hdg) ? Number(r.hdg) : null)),
        },
        geometry: { type: 'LineString', coordinates: pts.map((r) => [Number(r.lon), Number(r.lat)]) },
      },
      ...marks.map((e) => ({
        type: 'Feature',
        properties: { name: 'Marked location', time: iso(e.t), type: e.type },
        geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
      })),
    ];
    return JSON.stringify({ type: 'FeatureCollection', features });
  }

  if (format === 'gpx') {
    const pts = positions(rows);
    const out = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="GNSS Log" xmlns="http://www.topografix.com/GPX/1/1">',
      `<metadata><name>${esc(name)}</name>${rows.length ? `<time>${iso(t0)}</time>` : ''}</metadata>`,
    ];
    for (const e of marks) out.push(`<wpt lat="${e.lat}" lon="${e.lon}"><time>${iso(e.t)}</time><name>Marked location</name></wpt>`);
    out.push(`<trk><name>${esc(name)}</name><trkseg>`);
    for (const r of pts) {
      const ext = [
        fin(r.sog) ? `<speed>${r.sog}</speed>` : '',
        fin(r.cog) ? `<course>${r.cog}</course>` : '',
        fin(r.hdg) ? `<heading>${r.hdg}</heading>` : '',
      ].join('');
      out.push(
        `<trkpt lat="${r.lat}" lon="${r.lon}">${fin(r.gnssAlt) ? `<ele>${r.gnssAlt}</ele>` : ''}<time>${iso(r.t)}</time>${ext ? `<extensions>${ext}</extensions>` : ''}</trkpt>`,
      );
    }
    out.push('</trkseg></trk>', '</gpx>');
    return out.join('\n') + '\n';
  }

  if (format === 'kml') {
    const pts = positions(rows);
    const out = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
      `<name>${esc(name)}</name>`,
      '<Style id="track"><LineStyle><color>ffbfd42d</color><width>3</width></LineStyle></Style>',
      `<Placemark><name>${esc(name)}</name><styleUrl>#track</styleUrl>`,
      rows.length ? `<TimeSpan><begin>${iso(t0)}</begin><end>${iso(t1)}</end></TimeSpan>` : '',
      '<LineString><tessellate>1</tessellate><coordinates>',
      pts.map((r) => `${r.lon},${r.lat}`).join(' '),
      '</coordinates></LineString></Placemark>',
    ];
    for (const e of marks) {
      out.push(`<Placemark><name>Marked location</name><TimeStamp><when>${iso(e.t)}</when></TimeStamp><Point><coordinates>${e.lon},${e.lat}</coordinates></Point></Placemark>`);
    }
    out.push('</Document></kml>');
    return out.join('\n') + '\n';
  }

  throw new Error(`Unknown format: ${format}`);
}

export function fileName(name, format, suffix = '') {
  const base = (name || 'session').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'session';
  return `${base}${suffix}.${FORMATS[format].ext}`;
}
