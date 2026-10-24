/**
 * A target picked on the Stellarium sky map: a name as Stellarium shows it and the J2000 position
 * it was drawn at. GoTo wants the same thing the agent's goto_target would use: the solar-system
 * GoTo for a planet (it moves), the catalog object when the name is one of ours (its GoTo label
 * names the session folder, so nights shot from the map and from the app stack together), and
 * otherwise the plain position. A shot framed off the object's centre keeps the object's label but
 * goes to the framed position.
 */
import * as sky from './sky.js';
import { findObject, gotoLabel, type DsoObject } from './catalog.js';

/** Closer than this to the catalog position is the object itself: GoTo uses the catalog's coordinates. */
export const SAME_OBJECT_DEG = 0.25;
/** A frame centred up to this far from the named object is a framing of it (the tele frame is about 3° × 1.7°). */
export const FRAMED_DEG = 2;
/** The scope names the session folder after the label: keep it short and printable. */
const LABEL_MAX = 40;

export type SkyTarget =
  | { kind: 'body'; body: sky.BodyName; label: string }
  | { kind: 'catalog'; object: DsoObject; label: string; raHours: number; decDeg: number; framed: boolean }
  | { kind: 'position'; label: string; raHours: number; decDeg: number };

/** The label for a position that matched nothing: the name Stellarium gave, or the coordinates. */
function positionLabel(name: string, raHours: number, decDeg: number): string {
  const clean = name.replace(/[^\p{L}\p{N} .+\-()']/gu, '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
  return clean || `RA ${sky.hoursToHms(raHours)} Dec ${sky.degToDms(decDeg)}`;
}

export function resolveSkyTarget(name: string | undefined, raHours: number, decDeg: number): SkyTarget {
  const n = (name ?? '').trim();
  const body = n ? sky.bodyByName(n) : null;
  if (body) return { kind: 'body', body, label: body };
  const o = n ? findObject(n) : null;
  // findObject is fuzzy; a name that resolves to something elsewhere in the sky is not this pick
  const sep = o ? sky.separationDeg(o.raHours, o.decDeg, raHours, decDeg) : Infinity;
  if (o && sep <= FRAMED_DEG) {
    const framed = sep > SAME_OBJECT_DEG;
    return { kind: 'catalog', object: o, label: gotoLabel(o), raHours: framed ? raHours : o.raHours, decDeg: framed ? decDeg : o.decDeg, framed };
  }
  return { kind: 'position', label: positionLabel(n, raHours, decDeg), raHours, decDeg };
}
