/**
 * Minimal FITS reader for DWARF subframes (16-bit Bayer mono, BZERO 32768)
 * and calibration masters. Supports BITPIX 8/16/32/-32/-64, first HDU only.
 */
export interface FitsImage {
  header: Record<string, string | number | boolean>;
  width: number;
  height: number;
  /** Physical values (BZERO/BSCALE applied). */
  data: Float32Array;
  bayer?: string;
}

export function isFits(buf: Buffer): boolean {
  return buf.subarray(0, 9).toString('ascii') === 'SIMPLE  =';
}

export function readFits(buf: Buffer): FitsImage {
  const header: Record<string, string | number | boolean> = {};
  let offset = 0;
  let ended = false;
  while (!ended && offset < buf.length) {
    for (let i = 0; i < 36; i++) {
      const card = buf.subarray(offset + i * 80, offset + i * 80 + 80).toString('ascii');
      const key = card.slice(0, 8).trim();
      if (key === 'END') {
        ended = true;
        break;
      }
      if (card[8] !== '=') continue;
      let raw = card.slice(10);
      const q = raw.match(/^\s*'((?:[^']|'')*)'/);
      if (q) header[key] = q[1].replace(/''/g, "'").trim();
      else {
        raw = raw.split('/')[0].trim();
        if (raw === 'T' || raw === 'F') header[key] = raw === 'T';
        else if (raw !== '' && !Number.isNaN(Number(raw))) header[key] = Number(raw);
        else header[key] = raw;
      }
    }
    offset += 2880;
  }
  const bitpix = Number(header.BITPIX);
  const naxis = Number(header.NAXIS);
  const width = Number(header.NAXIS1);
  const height = Number(header.NAXIS2);
  if (naxis < 2 || !width || !height) throw new Error('FITS has no 2D image in the primary HDU');
  const planes = naxis >= 3 ? Number(header.NAXIS3) || 1 : 1;
  const bzero = Number(header.BZERO ?? 0);
  const bscale = Number(header.BSCALE ?? 1);
  const n = width * height; // first plane only
  const data = new Float32Array(n);
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, Math.min(buf.length - offset, (Math.abs(bitpix) / 8) * n * planes));
  for (let i = 0; i < n; i++) {
    let v: number;
    switch (bitpix) {
      case 8: v = dv.getUint8(i); break;
      case 16: v = dv.getInt16(i * 2, false); break;
      case 32: v = dv.getInt32(i * 4, false); break;
      case -32: v = dv.getFloat32(i * 4, false); break;
      case -64: v = dv.getFloat64(i * 8, false); break;
      default: throw new Error(`unsupported BITPIX ${bitpix}`);
    }
    data[i] = v * bscale + bzero;
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
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = [0, 1, 2, 3].map((i) => img.data[(y * 2 + (i >> 1)) * img.width + x * 2 + (i & 1)]);
      const o = (y * w + x) * 3;
      rgb[o] = px[pos.R[0] ?? 0];
      rgb[o + 1] = pos.G.length === 2 ? (px[pos.G[0]] + px[pos.G[1]]) / 2 : px[pos.G[0] ?? 1];
      rgb[o + 2] = px[pos.B[0] ?? 3];
    }
  }
  return { width: w, height: h, rgb };
}
