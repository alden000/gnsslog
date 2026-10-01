// Read-time upgrades for data recorded by older versions, so playback, export and upload only
// ever see current names. Stored records are left as they are.
//   v0.6.3 and earlier called the marked location "skyhook".

const EVENT_TYPES = { skyhook: 'mark', skyhook_clear: 'mark_clear', skyhook_active: 'mark_active' };
const SAMPLE_FIELDS = {
  skyActive: 'markActive',
  skyEvent: 'markEvent',
  skyLat: 'markLat',
  skyLon: 'markLon',
  skyDist: 'markDist',
  skyBrg: 'markBrg',
};

export function upgradeEvent(e) {
  return e && EVENT_TYPES[e.type] ? { ...e, type: EVENT_TYPES[e.type] } : e;
}

export function upgradeSession(s) {
  if (!s || !Array.isArray(s.events) || !s.events.some((e) => EVENT_TYPES[e.type])) return s;
  return { ...s, events: s.events.map(upgradeEvent) };
}

export function upgradeSample(r) {
  if (!r || !('skyDist' in r || 'skyActive' in r)) return r;
  const out = {};
  for (const k of Object.keys(r)) out[SAMPLE_FIELDS[k] || k] = r[k];
  return out;
}
