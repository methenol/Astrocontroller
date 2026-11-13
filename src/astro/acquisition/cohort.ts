/**
 * One cohort of raw light subs (the same filter, gain and sub length) analysed the way sub_length
 * does it, for the sub_length tool and the collection quality engine (quality.ts) alike:
 *
 * - the reference: the frames given, else the scope's dark (or bias) frames of the sub's settings,
 *   else the sub's own BIAS card, else the measured black level, else the spec's;
 * - Deep Sky Detail's analysis of each sub (sublength.ts) against it, the median one standing for
 *   the cohort, and the planner's calibration (the measured sky noise over the model's at that
 *   pointing and time);
 * - what a sub shows of the limits: its background as a share of the range, the share clipped,
 *   and the stars' count, FWHM and roundness (trailing, focus and cloud all show there).
 */
import path from 'node:path';
import { errMsg } from '../../log.js';
import * as sky from '../sky.js';
import { analyze, decode } from '../../media/images.js';
import { median } from '../../util/stats.js';
import { electronRate } from './advise.js';
import { rigFilter, type Rig } from './devices.js';
import { zenithSky, type DarkFrameRef } from './index.js';
import { frameStats, readRaw, type RawFrame } from './measure.js';
import { moonToward, skyBrightness, type MoonGeometry } from './skyglow.js';
import { analyzeSubLength, referenceNoise, type Channel, type ReferenceNoise, type SubLengthResult } from './sublength.js';
import type { SubLengthSample } from './store.js';
import { sensorProfile } from './store.js';

/** reference frames fetched from the scope at most */
export const MAX_REFERENCE = 2;

/**
 * The reference frames on the scope for a sub: darks of its exposure and gain — two single frames
 * when it has them (their pair difference is the read noise), else the master nearest in sensor
 * temperature — or, failing a dark of that length, a bias of its gain.
 */
export function pickReference(all: DarkFrameRef[], want: { exposureS: number; gain?: number; tempC?: number }): DarkFrameRef[] {
  const gainOk = (d: DarkFrameRef) => want.gain === undefined || d.gain === undefined || d.gain === want.gain;
  const byTemp = (a: DarkFrameRef, b: DarkFrameRef) => Math.abs((a.tempC ?? 0) - (want.tempC ?? a.tempC ?? 0)) - Math.abs((b.tempC ?? 0) - (want.tempC ?? b.tempC ?? 0));
  const sameExp = all.filter((d) => d.kind === 'dark' && gainOk(d) && d.exposureS !== undefined && Math.abs(d.exposureS - want.exposureS) <= 0.01 * want.exposureS);
  const singles = sameExp.filter((d) => d.stackCount === 1).sort(byTemp);
  if (singles.length >= 2) return singles.slice(0, MAX_REFERENCE);
  const masters = sameExp.filter((d) => d.stackCount !== 1).sort(byTemp);
  if (masters.length) return [masters[0]];
  if (singles.length) return singles;
  const bias = all.filter((d) => d.kind === 'bias' && gainOk(d) && (d.gain !== undefined || want.gain === undefined)).sort(byTemp);
  return bias.slice(0, MAX_REFERENCE);
}

export interface CohortSource {
  site: sky.Site;
  rig: Rig;
  devKey: string;
  /** the scope's dark and bias frames (the reference when none is given) */
  darkFrames?: () => Promise<DarkFrameRef[]>;
  /** a device path's bytes */
  fetchDevice: (devicePath: string) => Promise<Buffer>;
  /** reference frames already read, by device path (a quality run reads each dark once) */
  refCache?: Map<string, RawFrame>;
}

export interface CohortOptions {
  /** the owner's reference frames (bias, or darks of the sub's length) */
  reference?: RawFrame[];
  referenceFrom?: string;
  swamp: number;
  channel?: Channel;
  narrowband?: boolean;
  durationS?: number;
  /** read the stars of the median sub (FWHM, roundness, count): a decode of the frame */
  stars?: boolean;
}

export interface CohortStars {
  count: number;
  fwhmArcsec?: number;
  roundness?: number;
  error?: string;
}

export interface CohortAnalysis {
  frames: string[];
  filter: Rig['filters'][number];
  gain: number;
  subS: number;
  narrowband: boolean;
  channel: Channel;
  sensor: ReturnType<Rig['sensorAt']>;
  ref: ReferenceNoise | null;
  refFrom: string;
  levelAdu: number;
  levelSource: string;
  readNoiseAdu: number;
  readNoiseSource: string;
  results: SubLengthResult[];
  /** the median sub's analysis, and that sub */
  res: SubLengthResult;
  pick: RawFrame;
  at: Date;
  pos: { altitude: number; azimuth: number } | null;
  moon: MoonGeometry | null;
  sunAltDeg: number | null;
  skyNoiseScale: number | null;
  model: { sqm: number; ePerS: number } | null;
  /** the background above the offset in the median sub, % of the range above black */
  backgroundPct: number;
  /** pixels at the clip level beyond the stars', % of the frame (median of the cohort) */
  clippedPct: number;
  stars: CohortStars | null;
  notes: string[];
  /** ready for store.recordSubLength */
  sample: SubLengthSample;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Analyse a cohort of light subs (same filter, gain and length) against their reference. */
export async function analyzeCohort(src: CohortSource, frames: RawFrame[], bytes: Array<Buffer | undefined>, o: CohortOptions): Promise<CohortAnalysis> {
  if (!frames.length) throw new Error('no frames to analyse');
  const { rig } = src;
  const light = frames[frames.length - 1];
  const gains = new Set(frames.map((f) => f.gain));
  if (gains.size > 1) throw new Error(`the subs are of several gains (${[...gains].join(', ')}): analyse one cohort at a time`);
  const gain = light.gain ?? rig.gains[0];
  const sensor = rig.sensorAt(gain);
  const filter = rigFilter(rig, light.filter);
  const subS = o.durationS ?? light.exposureS;
  if (!subS) throw new Error(`${light.name} has no EXPTIME: give duration_s`);
  const narrowband = o.narrowband ?? filter.band !== 'broadband';
  const channel: Channel = o.channel ?? 'auto';
  const notes: string[] = [];

  // the reference: the owner's frames, else the scope's matching dark, else the sub's own offset card
  let refFrames: RawFrame[] = o.reference ?? [];
  let refFrom = o.reference?.length ? (o.referenceFrom ?? 'the reference files given') : '';
  if (!refFrames.length && src.darkFrames) {
    const listed = await src.darkFrames().catch((err) => {
      notes.push(`the scope's dark frames could not be listed: ${errMsg(err)}`);
      return [] as DarkFrameRef[];
    });
    const picked = pickReference(listed, { exposureS: subS, gain: light.gain, tempC: light.tempC });
    if (picked.length) {
      refFrames = await Promise.all(
        picked.map(async (d) => {
          const hit = src.refCache?.get(d.path);
          if (hit) return hit;
          const fr = readRaw(await src.fetchDevice(d.path), path.basename(d.path));
          src.refCache?.set(d.path, fr);
          return fr;
        }),
      );
      refFrom = `fetched from the scope: ${picked.map((d) => path.basename(d.path)).join(', ')}`;
    } else if (listed.length) notes.push(`the scope holds ${listed.length} dark/bias frames but none of ${subS}s${light.gain !== undefined ? ` at gain ${light.gain}` : ''}`);
  }
  for (const r of refFrames) if (r.width !== light.width || r.height !== light.height) throw new Error(`${r.name} is ${r.width}×${r.height}, the sub ${light.width}×${light.height}: not a reference for it`);
  const ref = refFrames.length ? referenceNoise(refFrames, channel) : null;
  if (ref) notes.push(...ref.warnings);
  if (ref?.gain !== undefined && light.gain !== undefined && ref.gain !== light.gain) notes.push(`the reference is gain ${ref.gain}, the sub gain ${light.gain}: its level is not this sub's offset`);

  // the offset: the reference's level (a dark of the sub's length holds its dark current too), else the sub's card, else what is measured, else the spec
  const darkAduPerS = sensor.darkCurrentEPerS / sensor.ePerAdu;
  const profile = sensorProfile(rig.spec.id, rig.serial);
  const measuredBias = profile?.gains[String(gain)]?.blackAdu ?? profile?.blackAdu;
  const measuredAtS = profile?.gains[String(gain)]?.blackAtS ?? 0;
  let levelAdu: number;
  let levelSource: string;
  if (ref) {
    levelAdu = ref.levelAdu;
    levelSource = `${ref.frames.length > 1 ? 'the reference frames' : 'the reference frame'} (${refFrom})${ref.exposureS !== undefined && ref.exposureS > 0 && Math.abs(ref.exposureS - subS) > 0.01 * subS ? `, a ${ref.exposureS}s dark: its dark current differs from the sub's` : ''}`;
  } else if (light.biasAdu !== undefined) {
    levelAdu = light.biasAdu + darkAduPerS * subS;
    levelSource = `the sub's BIAS card (${light.biasAdu}) plus ${r2(darkAduPerS * subS)} ADU of dark current from the spec`;
  } else if (measuredBias !== undefined) {
    levelAdu = measuredBias + darkAduPerS * Math.max(0, subS - measuredAtS);
    levelSource = 'the measured black level (acquisition_measure sensor) plus the dark current over the sub';
  } else {
    levelAdu = sensor.blackAdu;
    levelSource = `the spec's black level (${sensor.source.black}): take a dark of this length first`;
  }
  // the read noise: the reference's when it can vouch for one, else the rig's measured, else the spec's
  let readNoiseAdu: number;
  let readNoiseSource: string;
  if (ref?.readNoiseAdu !== null && ref?.readNoiseAdu !== undefined) {
    readNoiseAdu = ref.readNoiseAdu;
    readNoiseSource = ref.readNoiseHow!;
  } else {
    readNoiseAdu = sensor.readNoiseE / sensor.ePerAdu;
    readNoiseSource = sensor.source.readNoise === 'measured' ? 'measured on this rig (acquisition_measure sensor)' : `${sensor.source.readNoise} (${r2(sensor.readNoiseE)} e⁻ through ${Math.round(sensor.ePerAdu * 10000) / 10000} e⁻/ADU)`;
  }

  const results: SubLengthResult[] = frames.map((f) => analyzeSubLength({ light: f, readNoiseAdu, levelAdu, ePerAdu: sensor.ePerAdu, swamp: o.swamp, durationS: subS, channel, narrowband }));
  // the frame of the median swamp stands for the cohort
  const bySwamp = [...results].sort((x, y) => x.swamp - y.swamp);
  const res = bySwamp[bySwamp.length >> 1];
  const pickIdx = results.indexOf(res);
  const pick = frames[pickIdx];
  notes.push(...res.notes);

  // the planner's calibration: the measured sky variance rate against its model sky at this pointing and time
  const at = pick.at !== undefined ? new Date(pick.at) : new Date();
  const pos = pick.raHours !== undefined && pick.decDeg !== undefined ? sky.altAz(src.site, pick.raHours, pick.decDeg, at) : null;
  const moon = pos ? moonToward(src.site, pick.raHours!, pick.decDeg!, at) : null;
  let skyNoiseScale: number | null = null;
  let model: { sqm: number; ePerS: number } | null = null;
  if (pos && pos.altitude > 0) {
    const sb = skyBrightness({ zenithSqm: zenithSky().sqm, altDeg: pos.altitude, moon });
    const eSkyModel = electronRate(rig, sb.sqm, filter.skyFraction) + sensor.darkCurrentEPerS;
    const measuredVarE = (res.skyNoiseAdu * sensor.ePerAdu) ** 2 / subS;
    skyNoiseScale = eSkyModel > 0 ? measuredVarE / eSkyModel : null;
    model = { sqm: r2(sb.sqm), ePerS: r2(eSkyModel) };
  } else notes.push('no pointing in the header (RA/DEC): the plan gets the swamp numbers but not the sky-noise scale');
  let sunAltDeg: number | null = null;
  try {
    sunAltDeg = sky.bodyAlt(src.site, 'Sun', at);
  } catch {
    sunAltDeg = null;
  }

  // the limits as the subs show them
  const range = Math.max(1, sensor.saturationAdu - levelAdu);
  const backgroundPct = Math.round((Math.max(0, res.background.aboveReferenceAdu) / range) * 1000) / 10;
  const clippedPct = r2(median(frames.map((f) => frameStats(f).saturatedPct)));
  let stars: CohortStars | null = null;
  if (o.stars) {
    const buf = bytes[pickIdx];
    if (!buf) stars = { count: 0, error: 'the frame bytes were not kept' };
    else {
      try {
        const img = await decode(buf, pick.name);
        const scale = rig.plateScale * (Math.max(pick.width, pick.height) / Math.max(img.width, img.height));
        const an = analyze(img, 'tele', scale);
        stars = { count: an.stars.count, fwhmArcsec: an.stars.medianFwhmArcsec, roundness: an.stars.medianRoundness };
      } catch (err) {
        stars = { count: 0, error: errMsg(err) };
      }
    }
  }

  const sample: SubLengthSample = {
    at: at.getTime(),
    device: src.devKey,
    filter: filter.name,
    gain,
    subS,
    frame: pick.name,
    narrowband,
    readNoiseAdu: r2(readNoiseAdu),
    readNoiseSource,
    skyNoiseAdu: r2(res.skyNoiseAdu),
    skyVarAduPerS: Math.round((res.skyNoiseAdu ** 2 / subS) * 10000) / 10000,
    skyAduPerS: Math.round(res.background.aduPerS * 10000) / 10000,
    swamp: r2(res.swamp),
    efficiency: Math.round(res.efficiency * 10000) / 10000,
    skyNoiseScale: skyNoiseScale !== null && Number.isFinite(skyNoiseScale) ? r2(skyNoiseScale) : null,
  };

  return {
    frames: frames.map((f) => f.name),
    filter,
    gain,
    subS,
    narrowband,
    channel: res.channel,
    sensor,
    ref,
    refFrom,
    levelAdu,
    levelSource,
    readNoiseAdu,
    readNoiseSource,
    results,
    res,
    pick,
    at,
    pos,
    moon,
    sunAltDeg,
    skyNoiseScale,
    model,
    backgroundPct,
    clippedPct,
    stars,
    notes,
    sample,
  };
}
