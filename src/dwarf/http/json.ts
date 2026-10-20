/**
 * JSON with integers beyond 2^53 kept exact. Parameter ids in /shootingMode/getParamAndSetting are
 * packed int64s; JSON.parse would round them, so such literals become decimal strings first. Only
 * number tokens are touched: digits inside string values are left as they are.
 */
export function parseBigSafe(text: string): unknown {
  let out = '';
  let last = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x22 /* " */) {
      // skip a whole string, escapes included
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 0x5c /* \ */) i += 2;
        else if (d === 0x22) {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    if (c === 0x2d /* - */ || (c >= 0x30 && c <= 0x39)) {
      const start = i;
      if (c === 0x2d) i++;
      while (i < n && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++;
      const intEnd = i;
      // a fraction or exponent makes it a float: left to JSON.parse
      while (i < n && /[0-9.eE+-]/.test(text[i])) i++;
      const literal = text.slice(start, i);
      if (i === intEnd && !Number.isSafeInteger(Number(literal))) {
        out += text.slice(last, start) + `"${literal}"`;
        last = i;
      }
      continue;
    }
    i++;
  }
  return JSON.parse(last ? out + text.slice(last) : text);
}
