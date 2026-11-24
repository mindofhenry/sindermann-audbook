// Time helpers shared by commands and status messages.

/** 3723 -> "1:02:03", 125 -> "2:05" */
export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/**
 * Accepts "90", "2:05", "1:02:03", "5m", "1h2m3s".
 * Returns seconds, or null when the input is not a time.
 */
export function parseTime(input) {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return null;

  if (/^\d+$/.test(text)) return Number(text);

  const clock = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (clock) {
    const [, h = '0', m, s] = clock;
    if (Number(s) > 59 || (clock[1] !== undefined && Number(m) > 59)) return null;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }

  const units = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (units && (units[1] || units[2] || units[3])) {
    return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  }

  return null;
}
