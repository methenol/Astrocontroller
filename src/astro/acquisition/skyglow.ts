/**
 * How bright the sky is where the scope points, at a moment: the site's zenith sky (a sky meter,
 * this rig's own measurements, or the Bortle class), brightened toward the horizon by airmass, plus
 * the scattered moonlight of Krisciunas & Schaefer (1991, PASP 103, 1033), and how much of a target's
 * light the atmosphere passes. The extinction coefficient follows the forecast's transparency.
 *
 * The moonlit sky is what decides whether a long sub clips or a broadband target is worth a minute,
 * and it changes by magnitudes across one night: a flat "Moon up" penalty cannot say either.
 */
import * as A from 'astronomy-engine';
import type { Site } from '../sky.js';

/** V-band extinction, mag per airmass, for 7Timer transparency 1 (best) … 8 (worst). */
const K_BY_TRANSPARENCY = [0.12, 0.13, 0.15, 0.17, 0.2, 0.24, 0.3, 0.38];
/** A clear, average night's extinction when the forecast has no transparency. */
export const K_DEFAULT = 0.172;
/** Below this the Moon's scattering law misbehaves; the moonlight of a closer pointing is taken at it. */
const MIN_SEP_DEG = 10;

export function extinctionFor(transparencyIdx: number | undefined): number {
  if (transparencyIdx === undefined || !Number.isFinite(transparencyIdx)) return K_DEFAULT;
  return K_BY_TRANSPARENCY[Math.min(8, Math.max(1, Math.round(transparencyIdx))) - 1];
}

/** Airmass of a zenith distance (K&S's form; good to the horizon's last few degrees). */
export function airmass(altDeg: number): number {
  const z = ((90 - Math.max(0.5, altDeg)) * Math.PI) / 180;
  return 1 / Math.sqrt(1 - 0.96 * Math.sin(z) ** 2);
}

/** mag/arcsec² ↔ nanolamberts (K&S equations 1–2). */
const toNl = (mag: number) => 34.08 * Math.exp(20.7233 - 0.92104 * mag);
const toMag = (nl: number) => (20.7233 - Math.log(nl / 34.08)) / 0.92104;

export interface MoonGeometry {
  /** the Moon's altitude */
  altDeg: number;
  /** its separation from the target */
  sepDeg: number;
  /** phase angle: 0 full, 180 new */
  phaseAngleDeg: number;
}

/** Scattered moonlight toward a target at `altDeg`, nanolamberts (K&S equations 15–21); 0 with the Moon down. */
function moonNl(altDeg: number, m: MoonGeometry | null | undefined, k: number): number {
  if (!m || m.altDeg <= 0) return 0;
  const a = Math.abs(m.phaseAngleDeg);
  const iStar = 10 ** (-0.4 * (3.84 + 0.026 * a + 4e-9 * a ** 4));
  const rho = Math.max(MIN_SEP_DEG, m.sepDeg);
  const cr = Math.cos((rho * Math.PI) / 180);
  const f = 10 ** 5.36 * (1.06 + cr * cr) + 10 ** (6.15 - rho / 40);
  return f * iStar * 10 ** (-0.4 * k * airmass(m.altDeg)) * (1 - 10 ** (-0.4 * k * airmass(altDeg)));
}

/** The dark sky toward `altDeg`: brighter toward the horizon (more air glows), dimmed by the air in front of it. */
const darkFactor = (altDeg: number, k: number) => {
  const x = airmass(altDeg);
  return 10 ** (-0.4 * k * (x - 1)) * x;
};

/** The sky's surface brightness at a target (mag/arcsec², V-ish), and the share the Moon makes of it. */
export function skyBrightness(o: { zenithSqm: number; altDeg: number; moon?: MoonGeometry | null; k?: number }): { sqm: number; darkSqm: number; moonFraction: number } {
  const k = o.k ?? K_DEFAULT;
  const dark = toNl(o.zenithSqm) * darkFactor(o.altDeg, k);
  const moon = moonNl(o.altDeg, o.moon, k);
  const total = dark + moon;
  return { sqm: toMag(total), darkSqm: toMag(dark), moonFraction: total > 0 ? moon / total : 0 };
}

/** Fraction of a target's light that reaches the scope through `k` mag/airmass at this altitude. */
export function transmission(altDeg: number, k = K_DEFAULT): number {
  return 10 ** (-0.4 * k * airmass(altDeg));
}

/**
 * The zenith, moonless sky a measured brightness implies: the inverse of `skyBrightness` for the
 * same pointing and Moon, so a cohort shot at 40° under a quarter Moon still says what the site's
 * dark zenith is. Null when the Moon makes most of the measured sky (the inversion is then noise).
 */
export function zenithFromMeasured(o: { sqmThere: number; altDeg: number; moon?: MoonGeometry | null; k?: number }): number | null {
  const k = o.k ?? K_DEFAULT;
  const measured = toNl(o.sqmThere);
  const dark = measured - moonNl(o.altDeg, o.moon, k);
  if (dark <= measured * 0.4) return null;
  return toMag(dark / darkFactor(o.altDeg, k));
}

/** The Moon as seen from the site at a moment, toward a J2000 position. */
export function moonToward(site: Site, raHours: number, decDeg: number, when: Date): MoonGeometry {
  const t = A.MakeTime(when);
  const obs = new A.Observer(site.lat, site.lon, site.elev);
  const eq = A.Equator(A.Body.Moon, t, obs, true, true);
  const hor = A.Horizon(t, obs, eq.ra, eq.dec, 'normal');
  const eqj = A.Equator(A.Body.Moon, t, obs, false, true);
  const sepDeg = A.AngleBetween(A.VectorFromSphere(new A.Spherical(eqj.dec, eqj.ra * 15, 1), t), A.VectorFromSphere(new A.Spherical(decDeg, raHours * 15, 1), t));
  return { altDeg: hor.altitude, sepDeg, phaseAngleDeg: A.Illumination(A.Body.Moon, t).phase_angle };
}
