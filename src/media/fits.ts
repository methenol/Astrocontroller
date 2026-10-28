/**
 * Minimal FITS reader for DWARF subframes (16-bit Bayer mono, BZERO 32768), calibration masters
 * and Seestar stacks (a 3-plane RGB cube). Supports BITPIX 8/16/32/-32/-64, first HDU: the first
 * plane, and all three of an RGB cube.
 */
export interface FitsImage {
  header: Record<string, string | number | boolean>;
  width: number;
  height: number;
  /** Physical values (BZERO/BSCALE applied). */
  data: Float32Array;
  bayer?: string;
  /** an RGB cube (NAXIS3 = 3): the three planes interleaved, BZERO/BSCALE applied */
  rgb?: Float32Array;
}

const BLOCK = 2880;
const CARD = 80;
const BITPIX_BYTES: Readonly<Record<number, number>> = { 8: 1, 16: 2, 32: 4, [-32]: 4, [-64]: 8 };
/** Larger than any DWARF frame or master by far; a header claiming more is corrupt, not an image to allocate. */
const MAX_PIXELS = 200_000_000;

export function isFits(buf: Buffer): boolean {
  return buf.subarray(0, 9).toString('ascii') === 'SIMPLE  =';
}

function parseValue(raw: string): string | number | boolean {
  const q = raw.match(/^\s*'((?:[^']|'')*)'/);
  if (q) return q[1].replace(/''/g, "'").trim();
  const v = raw.split('/')[0].trim();
  if (v === 'T' || v === 'F') return v === 'T';
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

/** The header cards up to END, and where the data starts (the next block boundary). */
function readHeader(buf: Buffer): { header: FitsImage['header']; dataOffset: number } {
  const header: FitsImage['header'] = {};
  for (let offset = 0; offset + CARD <= buf.length; offset += CARD) {
    const card = buf.subarray(offset, offset + CARD).toString('ascii');
    const key = card.slice(0, 8).trim();
    if (key === 'END') return { header, dataOffset: Math.ceil((offset + CARD) / BLOCK) * BLOCK };
    if (card[8] === '=') header[key] = parseValue(card.slice(10));
  }
  throw new Error('FITS header has no END card (truncated file?)');
}

export function readFits(buf: Buffer): FitsImage {
  const { header, dataOffset } = readHeader(buf);
  const bitpix = Number(header.BITPIX);
  const bytes = Object.hasOwn(BITPIX_BYTES, bitpix) ? BITPIX_BYTES[bitpix] : undefined;
  if (!bytes) throw new Error(`unsupported FITS BITPIX ${header.BITPIX}`);
  const naxis = Number(header.NAXIS);
  const width = Number(header.NAXIS1);
  const height = Number(header.NAXIS2);
  if (naxis < 2 || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('FITS has no 2D image in the primary HDU');
  const n = width * height;
  if (n > MAX_PIXELS) throw new Error(`FITS claims ${width}×${height} pixels: more than ${MAX_PIXELS}, the header is corrupt`);
  const cube = naxis >= 3 && Number(header.NAXIS3) === 3 && buf.length >= dataOffset + 3 * n * bytes;
  const need = (cube ? 3 : 1) * n * bytes;
  if (buf.length < dataOffset + need) throw new Error(`FITS data is truncated: ${buf.length - dataOffset} of ${need} bytes for ${width}×${height}`);
  const bzero = Number(header.BZERO ?? 0);
  const bscale = Number(header.BSCALE ?? 1);
  if (!Number.isFinite(bzero) || !Number.isFinite(bscale)) throw new Error(`FITS BZERO/BSCALE are not numbers (${header.BZERO}, ${header.BSCALE})`);
  const dv = new DataView(buf.buffer, buf.byteOffset + dataOffset, need);
  const read: (i: number) => number =
    bitpix === 8 ? (i) => dv.getUint8(i)
    : bitpix === 16 ? (i) => dv.getInt16(i * 2, false)
    : bitpix === 32 ? (i) => dv.getInt32(i * 4, false)
    : bitpix === -32 ? (i) => dv.getFloat32(i * 4, false)
    : (i) => dv.getFloat64(i * 8, false);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = read(i) * bscale + bzero;
  if (cube) {
    const rgb = new Float32Array(n * 3);
    for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) rgb[i * 3 + c] = read(c * n + i) * bscale + bzero;
    // a stack is debayered already: its Bayer card describes the subs it came from
    return { header, width, height, data, rgb };
  }
  const bayer = typeof header.BAYERPAT === 'string' ? header.BAYERPAT.toUpperCase() : undefined;
  return { header, width, height, data, bayer };
}

/** 2×2 superpixel debayer → half-resolution RGB (interleaved). */
export function superpixel(img: FitsImage): { width: number; height: number; rgb: Float32Array } {
  const pat = (img.bayer ?? 'RGGB').slice(0, 4);
  const w = Math.floor(img.width / 2);
  const h = Math.floor(img.height / 2);
  const rgb = new Float32Array(w * h * 3);
  const pos: Record<string, number[]> = { R: [], G: [], B: [] };
  [...pat].forEach((c, i) => pos[c]?.push(i));
  const r = pos.R[0] ?? 0;
  const g0 = pos.G[0] ?? 1;
  const g1 = pos.G.length === 2 ? pos.G[1] : g0;
  const b = pos.B[0] ?? 3;
  const px = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let i = 0; i < 4; i++) px[i] = img.data[(y * 2 + (i >> 1)) * img.width + x * 2 + (i & 1)];
      const o = (y * w + x) * 3;
      rgb[o] = px[r];
      rgb[o + 1] = (px[g0] + px[g1]) / 2;
      rgb[o + 2] = px[b];
    }
  }
  return { width: w, height: h, rgb };
}
