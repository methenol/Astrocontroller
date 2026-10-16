/** Small statistics shared across the application. */

/** The median: the middle value, or the mean of the two middle values of an even count (NaN when empty). */
export function median(xs: readonly number[]): number {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
