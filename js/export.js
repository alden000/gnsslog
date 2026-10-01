// Local export of a recorded session (CSV of samples, or full JSON with events).

import { SAMPLE_COLUMNS } from './recorder.js';
import { publicMeta } from './sync.js';

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(samples) {
  const lines = [SAMPLE_COLUMNS.join(',')];
  for (const s of samples) lines.push(SAMPLE_COLUMNS.map((k) => csvCell(s[k])).join(','));
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
  if (format === 'csv') return deliverFile(toCSV(samples), `${safeName(session.name)}.csv`, 'text/csv');
  return deliverFile(toJSON(session, samples), `${safeName(session.name)}.json`, 'application/json');
}
