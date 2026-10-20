/** Time-zone arithmetic on the platform's IANA database (no dependency). */

const HOUR_MS = 3600e3;
/** Further than any UTC offset (±14 h) and nearer than any two DST changes. */
const DAY_MS = 24 * HOUR_MS;

/** UTC offset of a time zone at an instant, in hours (null when the zone is unknown). */
export function timezoneOffsetHours(tz: string, at: number): number | null {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
    const part = dtf.formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = part.match(/GMT([+-])(\d{2}):?(\d{2})?/);
    if (!m) return part === 'GMT' ? 0 : null;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) + Number(m[3] ?? 0) / 60);
  } catch {
    return null;
  }
}

/**
 * The instant at which the wall clock in `tz` reads `wallAsUtc` (a wall-clock time encoded as if it
 * were UTC). The candidates are the offsets in force a day before and a day after, which bracket
 * any DST change near that time, on either side of Greenwich. A wall time skipped by a spring
 * change lands that much later; one repeated by an autumn change resolves to its first occurrence.
 * An unknown zone is taken as UTC.
 */
export function zonedWallTimeToInstant(wallAsUtc: number, tz: string): number {
  const offsetAt = (t: number) => timezoneOffsetHours(tz, t) ?? 0;
  const before = offsetAt(wallAsUtc - DAY_MS);
  const after = offsetAt(wallAsUtc + DAY_MS);
  // an instant is right when the zone's offset at that instant is the one that produced it
  const valid = [...new Set([before, after])].map((o) => wallAsUtc - o * HOUR_MS).filter((t) => wallAsUtc - offsetAt(t) * HOUR_MS === t);
  // none valid: the wall time was skipped (spring change); the pre-change offset puts it past the gap
  return valid.length ? Math.min(...valid) : wallAsUtc - before * HOUR_MS;
}

/** A duration in words for messages: "a minute", "90 s", "5 minutes". */
export function inWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s === 60) return 'a minute';
  if (s % 60 === 0 && s > 60) return `${s / 60} minutes`;
  return `${s} s`;
}
