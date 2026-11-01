/**
 * The acquisition planner as the rest of the app uses it: one call that takes a target and a time
 * window and returns the settings (advise.ts), with the inputs gathered the same way for the agent's
 * tool and the night plan:
 *
 * - the rig: the device spec picked from what the scope reports, its live facts and this unit's
 *   measurements (devices.ts, store.ts);
 * - the site's zenith sky: PLAN_SKY_SQM (a sky meter, the owner's number) > this rig's trusted sky
 *   measurements > PLAN_BORTLE;
 * - the window sampled every SLICE_MIN: altitude and azimuth, the Moon, the forecast hour;
 * - the target from the catalog: surface brightness and what carries its light;
 * - what the journal learned: the share of subs the stacker keeps at each sub length.
 */
import { config } from '../../config.js';
import { findObject, displayName } from '../catalog.js';
import { emissionOf, sqmFor, surfaceBrightness, type Emission } from '../detect.js';
import * as sky from '../sky.js';
import type { HourConditions } from '../weather.js';
import type { Journal } from '../../night/journal.js';
import { advise, type Recommendation, type SkySlice, type TargetInfo } from './advise.js';
import { resolveRig, type LiveFacts, type Rig } from './devices.js';
import { moonToward } from './skyglow.js';
import { deviceKey, siteSeeing, siteSky } from './store.js';

export { type Recommendation } from './advise.js';
export { type LiveFacts, type Rig } from './devices.js';

/** The window is sampled this often. */
const SLICE_MIN = 15;
/** Samples below this altitude are not imaged. */
const MIN_ALT_DEG = 10;
/** A sub length's keep rate is learned from at least this many frames. */
const KEEP_MIN_FRAMES = 40;

export type FactsSource = () => Promise<Partial<LiveFacts> & { driver: LiveFacts['driver'] }>;

/** The zenith, moonless sky of the site and where the number comes from. */
export function zenithSky(): { sqm: number; source: string } {
  if (config.plan.skySqm !== null) return { sqm: config.plan.skySqm, source: 'PLAN_SKY_SQM (sky meter)' };
  const m = siteSky();
  if (m) return { sqm: m.sqm, source: `measured by this rig (${m.samples} clear moonless cohorts, ±${m.spread.toFixed(2)})` };
  return { sqm: sqmFor(config.plan.bortle), source: `PLAN_BORTLE ${config.plan.bortle} (not measured yet)` };
}

/** A target by catalog name, with what the planner needs of it. */
export function targetInfo(name: string, custom?: { raHours: number; decDeg: number; emission?: Emission }): TargetInfo {
  const o = findObject(name);
  if (!o) {
    if (!custom) throw new Error(`"${name}" is not in the catalog: give ra_hours and dec_deg`);
    return { name, raHours: custom.raHours, decDeg: custom.decDeg, sb: null, emission: custom.emission ?? 'broadband' };
  }
  let sb = surfaceBrightness(o);
  // a planetary nebula's magnitude is integrated photometry: its mean over its disc is a fair surface brightness
  if (!sb && o.type === 'PN' && o.mag !== undefined && o.majorArcmin) {
    const area = (Math.PI / 4) * o.majorArcmin * (o.minorArcmin ?? o.majorArcmin) * 3600;
    sb = { sb: o.mag + 2.5 * Math.log10(area), estimated: true };
  }
  return { name: o.id, displayName: displayName(o), raHours: o.raHours, decDeg: o.decDeg, type: o.type, sb: sb?.sb ?? null, sbEstimated: sb?.estimated, emission: emissionOf(o) };
}

/** The window sampled: where the target is, where the Moon is, and the forecast hour. */
export function slicesFor(site: sky.Site, t: Pick<TargetInfo, 'raHours' | 'decDeg'>, from: Date, to: Date, conditions?: ((at: Date) => HourConditions | undefined) | null): SkySlice[] {
  const out: SkySlice[] = [];
  const span = Math.max(0, to.getTime() - from.getTime());
  const n = Math.max(1, Math.round(span / (SLICE_MIN * 60e3)));
  for (let i = 0; i < n; i++) {
    // the middle of each step stands for it
    const at = new Date(from.getTime() + ((i + 0.5) * span) / n);
    const pos = sky.altAz(site, t.raHours, t.decDeg, at);
    if (pos.altitude < MIN_ALT_DEG) continue;
    const c = conditions?.(at);
    out.push({
      at: at.getTime(),
      altDeg: pos.altitude,
      azDeg: pos.azimuth,
      moon: moonToward(site, t.raHours, t.decDeg, at),
      seeingIdx: c?.seeingIdx,
      transparencyIdx: c?.transparencyIdx,
      windKmh: c?.windKmh,
      observability: c?.observability,
    });
  }
  return out;
}

/** The share of subs the stacker kept at each sub length, from the journal (only lengths with enough frames). */
export function keepBySub(journal: Pick<Journal, 'recentSessions'> | null | undefined): Record<string, number> {
  const acc = new Map<number, { taken: number; kept: number }>();
  for (const s of journal?.recentSessions(60) ?? []) {
    const st = s.stats;
    if (!st?.subS || !st.framesTaken || st.stacked === undefined) continue;
    const a = acc.get(st.subS) ?? { taken: 0, kept: 0 };
    a.taken += st.framesTaken;
    a.kept += Math.min(st.framesTaken, st.stacked);
    acc.set(st.subS, a);
  }
  const out: Record<string, number> = {};
  for (const [subS, a] of acc) if (a.taken >= KEEP_MIN_FRAMES) out[String(subS)] = Math.round((a.kept / a.taken) * 1000) / 1000;
  return out;
}

export interface AdviseRequest {
  facts: Awaited<ReturnType<FactsSource>>;
  site: sky.Site;
  target: TargetInfo;
  from: Date;
  to: Date;
  /** wall minutes on target in the window (default: its whole length) */
  usableMin?: number;
  conditions?: ((at: Date) => HourConditions | undefined) | null;
  fixed?: { filter?: string; gain?: number; subS?: number };
  collectedMin?: number;
  journal?: Pick<Journal, 'recentSessions'> | null;
}

/** Settings for one target over one window, everything gathered. */
export function adviseFor(r: AdviseRequest): { rig: Rig; rec: Recommendation } {
  const rig = resolveRig(r.facts);
  const slices = slicesFor(r.site, r.target, r.from, r.to, r.conditions);
  if (!slices.length) throw new Error(`${r.target.displayName ?? r.target.name} is not above ${MIN_ALT_DEG}° between ${r.from.toISOString()} and ${r.to.toISOString()}`);
  const zen = zenithSky();
  const seeing = siteSeeing(deviceKey(rig.spec.id, rig.serial));
  const rec = advise({
    rig,
    target: r.target,
    site: r.site,
    slices,
    zenithSqm: zen.sqm,
    sqmSource: zen.source,
    measuredFwhmArcsec: seeing?.fwhmArcsec,
    fixed: r.fixed,
    // without a block's figure: the part of the window the target is up for
    usableMin: r.usableMin ?? (slices.length / Math.max(1, Math.round((r.to.getTime() - r.from.getTime()) / (SLICE_MIN * 60e3)))) * ((r.to.getTime() - r.from.getTime()) / 60e3),
    collectedMin: r.collectedMin,
    keepBySubS: keepBySub(r.journal),
  });
  return { rig, rec };
}
