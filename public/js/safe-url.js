/** URL checks for content the page did not write (the model's markdown). No DOM: tested under Node. */

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Whether a link or image address is safe to put in the page: http(s), mailto, or a relative path.
 * Browsers ignore control characters and spaces inside a scheme ("java\tscript:"), so those are
 * dropped before the scheme is read.
 */
export function isSafeUrl(href) {
  const s = String(href ?? '').replace(/[\u0000- \u007f]+/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  return !scheme || ALLOWED_SCHEMES.has(`${scheme[1].toLowerCase()}:`);
}
