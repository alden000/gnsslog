// Tactile feedback for taps. In the Android app it uses the system's own touch feedback
// (VesselSensors.haptic -> View.performHapticFeedback, follows the phone's "touch
// interactions" vibration setting); in browsers that support it, a short vibration.
//
// Kinds: tap (buttons), select (switches, segmented choices, tabs), confirm (start recording,
// mark location), heavy (stop recording), warn (destructive confirmations, errors).
// Any element can choose its kind with data-haptic="confirm" (or "none").

import { isNative, plugin } from './native.js';

const PATTERNS = { tap: 8, select: 5, confirm: 14, heavy: 28, warn: [16, 70, 16] };
let enabled = true;
let last = 0;

export function haptic(kind = 'tap') {
  if (!enabled) return;
  const now = performance.now();
  // One light buzz per gesture (nested targets, synthetic clicks); stronger kinds always play.
  if ((kind === 'tap' || kind === 'select') && now - last < 45) return;
  last = now;
  if (isNative) {
    plugin('VesselSensors').haptic({ kind }).catch(() => {});
    return;
  }
  try {
    navigator.vibrate?.(PATTERNS[kind] ?? PATTERNS.tap);
  } catch {}
}

const TARGETS = 'button, [role="button"], [role="switch"], [role="tab"], .pressable, .dock-tab, .session, a[href], input[type="checkbox"], select';

function kindFor(el) {
  if (el.dataset.haptic) return el.dataset.haptic;
  if (el.matches('[role="switch"], .switch, input[type="checkbox"], .dock-tab, [role="tab"]') || el.closest('.segmented')) return 'select';
  return 'tap';
}

/** Buzz on every tap of an interactive element; settings key 'haptics' turns it off. */
export function installHaptics(settings) {
  enabled = settings.get('haptics') !== false;
  settings.addEventListener('change', (e) => {
    if (e.detail.key === 'haptics') {
      enabled = !!e.detail.value;
      if (enabled) haptic('select'); // feel it when switching on
    }
  });
  document.addEventListener(
    'click',
    (e) => {
      const el = e.target.closest?.(TARGETS);
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
      const kind = kindFor(el);
      if (kind !== 'none') haptic(kind);
    },
    true,
  );
}
