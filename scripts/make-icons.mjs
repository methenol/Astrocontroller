#!/usr/bin/env node
/**
 * Regenerates the installable-app icons in public/icons/.
 * The art is the same reticle as the favicon in index.html, drawn at 512 and
 * resized, so re-running this after a colour change is all it takes.
 *
 *   node scripts/make-icons.mjs        # or: npm run icons
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const C = 256; // canvas is 512x512, so the mark centres at 256
const RING_R = 113, RING_W = 17;      // the blue ring, measured off the shipped icon
const TICK_R0 = 115, TICK_R1 = 157, TICK_W = 20; // round caps paint 10px past each end
const INNER_R = 75, INNER_W = 6;
const DOT_R = 29;
const BLUE = '#3b82f6', PALE = '#93c5fd', DIM = '#4e6884';

// Scattered faint dots, kept clear of the mark (r > 176) and of the rounded corners.
const STARS = [
  [107, 402, 5.2, '#929aa6'], [145, 406, 6.2, '#737b87'], [223, 447, 4.7, '#59606a'],
  [302, 47, 4.1, '#555f6e'], [57, 241, 4.1, '#5f6977'], [362, 424, 4.1, '#5c636d'],
  [406, 98, 3.2, '#484f5d'], [464, 312, 2.0, '#3f444e'], [250, 489, 2.0, '#484d56'],
  [214, 483, 2.3, '#343942'], [330, 128, 1.8, '#8ea6c4'], [192, 92, 1.6, '#3c434e'],
  [452, 176, 1.5, '#4a5262'], [78, 132, 1.5, '#454c58'], [436, 402, 1.6, '#3f4652'],
  [118, 176, 1.3, '#5b6472'], [392, 300, 1.3, '#414854'], [152, 300, 1.2, '#3a414c'],
];

/** The mark, scaled about the centre so the maskable variant fits the safe zone. */
function mark(scale) {
  const t = scale === 1 ? '' : ` transform="translate(${C} ${C}) scale(${scale}) translate(${-C} ${-C})"`;
  const ticks = [0, 90, 180, 270]
    .map((a) => `<line transform="rotate(${a} ${C} ${C})" x1="${C}" y1="${C - TICK_R0}" x2="${C}" y2="${C - TICK_R1}" />`)
    .join('');
  return `<g${t}>
    <circle cx="${C}" cy="${C}" r="${RING_R}" fill="none" stroke="${BLUE}" stroke-width="${RING_W}"/>
    <g stroke="${PALE}" stroke-width="${TICK_W}" stroke-linecap="round">${ticks}</g>
    <circle cx="${C}" cy="${C}" r="${INNER_R}" fill="none" stroke="${DIM}" stroke-width="${INNER_W}"/>
    <circle cx="${C}" cy="${C}" r="${DOT_R}" fill="${PALE}"/>
  </g>`;
}

/** @param {{maskable?: boolean}} o maskable = full-bleed square, mark shrunk to the safe zone */
function svg({ maskable = false } = {}) {
  const field = maskable
    ? '<rect width="512" height="512" fill="url(#sky)"/>'
    : '<rect width="512" height="512" rx="96" fill="url(#sky)"/>';
  const stars = STARS.map(([x, y, r, fill]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" fill-opacity=".85"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#111c2d"/><stop offset="1" stop-color="#05070c"/>
  </linearGradient></defs>
  ${field}${stars}${mark(maskable ? 0.76 : 1)}
</svg>`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const jobs = [
  ['icon-512.png', svg(), null],
  ['icon-192.png', svg(), 192],
  ['icon-maskable-512.png', svg({ maskable: true }), null],
];
for (const [name, doc, width] of jobs) {
  await sharp(Buffer.from(doc)).resize(width ? { width, height: width } : undefined).png().toFile(path.join(OUT_DIR, name));
  console.log(`${name}${width ? ` (${width}px)` : ''}`);
}
