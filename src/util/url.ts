/** URL helpers. */

/** A URL without any user:password part (the UI shows the address only). */
export function withoutCredentials(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = '';
    u.password = '';
    const out = u.toString();
    // URL adds a "/" to a bare host; keep the form given, so `${base}/api/…` still joins cleanly
    return url.endsWith('/') ? out : out.replace(/\/+$/, '');
  } catch {
    return url.replace(/\/\/[^/@]*@/, '//');
  }
}

/**
 * A URL's credentials as an Authorization header, and the URL without them: fetch() refuses a URL
 * that carries user:password.
 */
export function splitCredentials(url: string): { url: string; authorization?: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { url };
  }
  if (!u.username && !u.password) return { url };
  const user = decodeOrRaw(u.username);
  const pass = decodeOrRaw(u.password);
  u.username = '';
  u.password = '';
  return { url: u.toString().replace(/\/+$/, ''), authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

/** Percent-decoded, or as written when it is not valid percent-encoding (a bare "%" in a password). */
function decodeOrRaw(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
