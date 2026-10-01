// Local export of a recorded session (CSV of samples, or full JSON with events).

import { SAMPLE_COLUMNS, SKY_EVENT_LABEL } from './recorder.js';
import { publicMeta } from './sync.js';
import { isNative, shareTextFile } from './native.js';

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Skyhook state per row from the session's events. Rows recorded before these columns
 * existed get them filled in; rows that already carry them are left as recorded.
 */
export function withSkyhookColumns(samples, events = []) {
  const evs = events.filter((e) => SKY_EVENT_LABEL[e.type]).sort((a, b) => a.seq - b.seq || a.t - b.t);
  let spot = null;
  let k = 0;
  return samples.map((row) => {
    const labels = [];
    while (k < evs.length && evs[k].seq <= row.seq) {
      const e = evs[k++];
      spot = e.type === 'skyhook_clear' ? null : { lat: e.lat, lon: e.lon };
      if (e.seq === row.seq) labels.push(SKY_EVENT_LABEL[e.type]);
    }
    if (row.skyActive !== undefined) return row;
    return {
      ...row,
      skyActive: spot ? 1 : 0,
      skyEvent: labels.join(';'),
      skyLat: spot ? spot.lat : null,
      skyLon: spot ? spot.lon : null,
    };
  });
}

export function toCSV(samples, events) {
  const lines = [SAMPLE_COLUMNS.join(',')];
  for (const s of withSkyhookColumns(samples, events)) lines.push(SAMPLE_COLUMNS.map((k) => csvCell(s[k])).join(','));
  return lines.join('\n') + '\n';
}

export function toJSON(session, samples) {
  return JSON.stringify(
    { schema: 'gnsslog/1', session: publicMeta(session), samples: samples.map(({ sid, ...rest }) => rest) },
    null,
    0,
  );
}

function safeName(name) {
  return (name || 'session').replace(/[^\w.-]+/g, '_').slice(0, 80);
}

/** Share (mobile) or download (desktop) a text file. */
export async function deliverFile(text, filename, type) {
  if (isNative) return shareTextFile(text, filename);
  const file = new File([text], filename, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function exportSession(db, session, format) {
  const samples = await db.getSamples(session.id);
  if (format === 'csv') return deliverFile(toCSV(samples, session.events), `${safeName(session.name)}.csv`, 'text/csv');
  return deliverFile(toJSON(session, samples), `${safeName(session.name)}.json`, 'application/json');
}
