/**
 * The acquisition planner as tools, the same for every driver:
 *
 * - acquisition_plan: the filter, gain, sub length, frame count and integration a target wants on
 *   this rig through tonight's sky (its night-plan block, or the window asked for), with the
 *   overexposure margins and the reasons; the device in use and every known model.
 * - acquisition_measure: this rig's own numbers from its raw frames — the sensor (darks), the sky,
 *   the conversion gain and the stars (lights), a running session checked against what the plan
 *   expects — kept in <data>/acquisition.json, which the plan then uses instead of the spec.
 * - sub_length: Deep Sky Detail's sub-length analysis of one light sub against a reference (a dark
 *   master of its settings fetched from the telescope, a bias the owner took, or the stored read
 *   noise): the swamp factor the sub reaches, the sub efficiency, the minimum sub for the factor
 *   wanted — stored, and from then on part of acquisition_plan's own calculation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../../config.js';
import { errMsg } from '../../log.js';
import * as sky from '../../astro/sky.js';
import * as weather from '../../astro/weather.js';
import { targetKey } from '../../astro/rest.js';
import { adviseFor, targetInfo, zenithSky, type DarkFrameRef, type FactsSource } from '../../astro/acquisition/index.js';
import { BG_MAX_FRAC, electronRate, magForRate } from '../../astro/acquisition/advise.js';
import { analyzeSubLength, efficiencyOf, efficiencyVerdict, referenceNoise, DEFAULT_SWAMP, type Channel, type SubLengthResult } from '../../astro/acquisition/sublength.js';
import { loadDevices, resolveRig, rigFilter, userDevicesDir, type Rig } from '../../astro/acquisition/devices.js';
import { cadence, clipLevel, frameStats, measureLights, measureSensor, readRaw, stampOfName, type RawFrame } from '../../astro/acquisition/measure.js';
import { moonToward, skyBrightness, zenithFromMeasured } from '../../astro/acquisition/skyglow.js';
import { deviceKey, forget, latestSubLength, recordSeeing, recordSensor, recordSky, recordSubLength, sensorProfile, siteSeeing, siteSky, storeView, subLengthSamples } from '../../astro/acquisition/store.js';
import { deviceLibrary } from '../../library/device-library.js';
import { isTransferred, parseSessionFolder, sessionLocalDir } from '../../library/sessions.js';
import { analyze, decode } from '../../media/images.js';
import { resolveLocalPath } from '../../media/image/load.js';
import { collected } from '../../night/progress.js';
import type { NightServices } from '../../night/index.js';
import { median } from '../../util/stats.js';
import { timeArg } from './night.js';
import { text, type ToolFn } from './common.js';

const DEVICE_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** frames read per measurement: each raw frame is 8–33 MB in memory */
const MAX_LIGHTS = 6;
const MAX_DARKS = 8;
/** a sky cohort stands for the site only in astronomical dark, with the Moon down and the target this high */
const TRUSTED_SUN_ALT = -18;
const TRUSTED_MOON_ALT = -3;
const TRUSTED_ALT = 35;
/** check: stars rounder than this are not trailing; larger than this × the expected FWHM are out of focus */
const ROUND_MIN = 0.7;
const SOFT_FACTOR = 1.6;
/** check: a share of clipped pixels beyond the stars' (percent of the frame's green pixels) */
const CLIPPED_PCT = 0.5;
/** check: read noise counts as paid once the sky's electrons per sub reach this many × RN² */
const SKY_LIMITED_K = 5;
/** sub_length: lights analysed at most, and reference frames fetched from the scope at most */
const MAX_SUBLENGTH_LIGHTS = 3;
const MAX_REFERENCE = 2;

export interface AcquisitionContext {
  site(): sky.Site;
  facts: FactsSource;
  night?: NightServices | null;
  /** a session on the scope's storage as fetchable device paths, oldest first (the Seestar's) */
  sessionSubs?(folder: string): Promise<string[]>;
  /** the dark and bias frames on the scope's storage (the Dwarf's CALI_FRAME, the Seestar's darklibrary) */
  darkFrames?(): Promise<DarkFrameRef[]>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

const isLightName = (n: string) => /\.fits?$/i.test(n) && !/^failed_|stack|master|dark|flat|bias/i.test(n);

const bytesOf = (p: string): Promise<Buffer> => (p.startsWith('device:') ? deviceLibrary().album.fetch(p.slice('device:'.length), DEVICE_FILE_MAX_BYTES) : fs.promises.readFile(resolveLocalPath(p)));

/**
 * The reference frames on the scope for a sub: darks of its exposure and gain — two single frames
 * when it has them (their pair difference is the read noise), else the master nearest in sensor
 * temperature — or, failing a dark of that length, a bias of its gain.
 */
function pickReference(all: DarkFrameRef[], want: { exposureS: number; gain?: number; tempC?: number }): DarkFrameRef[] {
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

/** Raw frames from library paths, device paths (device:…), a library folder, or a session (local when transferred, else on the scope). */
async function loadFrames(ctx: AcquisitionContext, o: { files?: string[]; session?: string; count: number; newest: boolean }): Promise<{ frames: RawFrame[]; bytes: Buffer[]; names: string[] }> {
  let list: string[] = [];
  if (o.files?.length) {
    for (const f of o.files) {
      if (!f.startsWith('device:')) {
        const local = resolveLocalPath(f);
        if (fs.statSync(local).isDirectory()) {
          list.push(...fs.readdirSync(local).filter(isLightName).sort().map((n) => path.join(local, n)));
          continue;
        }
      }
      list.push(f);
    }
  } else if (o.session) {
    const s = await deviceLibrary().resolveSession(o.session).catch(() => null);
    const local = s ? parseSessionFolder(s.folder) : parseSessionFolder(o.session);
    if (local && isTransferred(local)) {
      const dir = sessionLocalDir(local);
      list = fs.readdirSync(dir).filter(isLightName).sort().map((n) => path.join(dir, n));
    } else if (s && ctx.sessionSubs) {
      list = (await ctx.sessionSubs(s.folder)).map((p) => `device:${p.startsWith('/') ? p : `/SEESTAR/${p}`}`);
    } else {
      throw new Error(`session ${o.session} is not in the library: transfer it first (transfer_session), or give files`);
    }
  } else {
    throw new Error('give files (library paths, a library folder, or device:… paths) or session');
  }
  if (!list.length) throw new Error('no raw FITS frames found');
  const pick = o.newest ? list.slice(-o.count) : list.slice(0, o.count);
  const frames: RawFrame[] = [];
  const bytes: Buffer[] = [];
  for (const p of pick) {
    bytes.push(await bytesOf(p));
    frames.push(readRaw(bytes[bytes.length - 1], path.basename(p.replace(/^device:/, ''))));
  }
  // every sub's name, for the session's cadence (their stamps), not only the ones read
  return { frames, bytes, names: list.map((p) => path.basename(p.replace(/^device:/, ''))) };
}

/** The rig's numbers at one gain, in the terms an owner reads. */
function sensorLine(rig: Rig, gain: number) {
  const s = rig.sensorAt(gain);
  return {
    gain,
    ePerAdu: Math.round(s.ePerAdu * 10000) / 10000,
    readNoiseE: r2(s.readNoiseE),
    blackAdu: Math.round(s.blackAdu),
    clipAdu: Math.round(s.saturationAdu),
    fullWellE: Math.round(s.fullWellE),
    darkEPerS: r2(s.darkCurrentEPerS),
    from: s.source,
  };
}

/** The window to plan: the target's next block tonight, else what was asked, else the rest of tonight's darkness. */
async function windowFor(ctx: AcquisitionContext, name: string, from?: string, until?: string): Promise<{ from: Date; to: Date; usableMin?: number; why: string }> {
  const site = ctx.site();
  const now = new Date();
  const w = sky.nightWindow(site, now);
  const nightKey = ctx.night?.nightOf() ?? sky.localDate(now, config.observer.timezone);
  if (from || until) {
    const f = timeArg(from, nightKey) ?? Math.max(now.getTime(), w.darkStart?.getTime() ?? now.getTime());
    const t = timeArg(until, nightKey) ?? w.darkEnd?.getTime() ?? f + 4 * 3600e3;
    if (t <= f) throw new Error('until must be after from');
    return { from: new Date(f), to: new Date(t), why: 'the window asked for' };
  }
  const plan = await ctx.night?.plan.plan().catch(() => null);
  const key = targetKey(name);
  const block = plan?.blocks.find((b) => b.kind === 'target' && !b.past && b.target?.key === key && b.end > now.getTime());
  if (block) {
    const start = Math.max(block.start, now.getTime());
    return { from: new Date(start), to: new Date(block.end), usableMin: Math.max(0, (block.end - start) / 60e3 - (start === block.start ? block.overheadMin : 0)), why: `its night-plan block` };
  }
  const start = Math.max(now.getTime(), w.darkStart?.getTime() ?? now.getTime());
  const end = w.darkEnd?.getTime() ?? start + 8 * 3600e3;
  return { from: new Date(start), to: new Date(end), why: "the rest of tonight's darkness (it has no block in the night plan)" };
}

export function registerAcquisitionTools(tool: ToolFn, ctx: AcquisitionContext): void {
  const tz = config.observer.timezone;
  const hm = (d: Date) => sky.fmtTime(d, tz);

  tool(
    'acquisition_plan',
    "Capture settings worked out for a target on THIS telescope under tonight's sky, like SkyTools' exposure calculator: the filter, gain, sub length and frame count that collect the most signal-to-noise per hour of the night without overexposing (the sky background, the target's bright core), the dither interval, and how much integration the target needs (hours to a detection, a clean and a deep picture, and what tonight adds). It weighs the target's surface brightness and emission lines, the Moon's sky glow along the window, airmass and the forecast's transparency, seeing and wind, the mount's trailing limit (alt-az field rotation from the actual pointing, unguided EQ drift), what sub lengths and gains the device offers, and this unit's measured sensor and sky (acquisition_measure). The window is the target's block in the night plan, else from/until, else the rest of tonight. Owner-given settings: pass them (filter, gain, sub_s) and the answer predicts those instead of choosing. advise: for a target. device: the model in use, its sensor at each gain and where every number comes from, and what measurements are missing. devices: every model known (and how to add one).",
    {
      action: z.enum(['advise', 'device', 'devices']),
      target: z.string().optional().describe('advise: catalog name, or any name with ra_hours/dec_deg'),
      ra_hours: z.number().min(0).lt(24).optional(),
      dec_deg: z.number().min(-90).max(90).optional(),
      emission: z.enum(['broadband', 'Ha_dominant', 'OIII_dominant']).optional().describe('advise, custom position: what carries its light'),
      from: z.string().optional().describe('local HH:MM tonight or a date-time'),
      until: z.string().optional(),
      filter: z.string().optional().describe("hold this filter (the owner's); omit to let the plan choose"),
      gain: z.number().optional().describe('hold this gain'),
      sub_s: z.number().positive().optional().describe('hold this sub length'),
    },
    async (a) => {
      const facts = await ctx.facts();
      if (a.action === 'devices') {
        const { specs, errors } = loadDevices(true);
        const picked = (() => {
          try {
            return resolveRig(facts).spec.id;
          } catch {
            return null;
          }
        })();
        return text({
          inUse: picked,
          devices: specs.map((s) => ({ id: s.id, name: s.name, driver: s.driver, aperture: `${s.optics.apertureMm} mm`, focalLength: `${s.optics.focalLengthMm} mm`, sensor: `${s.sensor.name} ${s.sensor.widthPx}×${s.sensor.heightPx} ${s.sensor.pixelUm} µm`, filters: s.filters.map((f) => f.name), file: s.file, ownersFile: s.user })),
          invalidFiles: errors.length ? errors : undefined,
          addOne: `copy a file from ${config.paths.devices} into ${userDevicesDir()}, give it a new "id" and the model's numbers (a file there with a shipped id replaces that model); PLAN_DEVICE=<id> forces one`,
        });
      }
      const rig = resolveRig(facts);
      if (a.action === 'device') {
        const p = sensorProfile(rig.spec.id, rig.serial);
        const seeing = siteSeeing(deviceKey(rig.spec.id, rig.serial));
        return text({
          device: `${rig.spec.name} (${rig.spec.id})`,
          picked: rig.why,
          serial: rig.serial,
          file: (rig.spec as { file?: string }).file,
          optics: `${rig.apertureMm} mm aperture, ${rig.focalLengthMm} mm, f/${r2(rig.focalLengthMm / rig.apertureMm)}, ${r2(rig.plateScale)}″/px, field ${r2(rig.fovDeg.w)}°×${r2(rig.fovDeg.h)}°`,
          mount: `${rig.mount}${rig.guided ? ', guided' : ''}`,
          subsS: rig.subsS,
          gains: rig.gains,
          gainSettable: rig.gainSettable,
          filters: rig.filters.map((f) => ({ name: f.name, band: f.band, skyFraction: f.skyFraction, passband: f.passband })),
          sensor: rig.gains.map((g) => sensorLine(rig, g)),
          sources: rig.sources,
          siteSky: { ...zenithSky(), measured: siteSky() },
          siteSeeing: seeing,
          measured: p ?? null,
          missing: rig.missing,
          specSources: rig.spec.sources,
          notes: rig.spec.notes,
        });
      }
      if (!a.target) throw new Error('advise needs target');
      const target = targetInfo(a.target, a.ra_hours !== undefined && a.dec_deg !== undefined ? { raHours: a.ra_hours, decDeg: a.dec_deg, emission: a.emission } : undefined);
      const win = await windowFor(ctx, a.target, a.from, a.until);
      const site = ctx.site();
      // with a filter held, what was collected through it (an Astro night does not shorten a Duo-Band goal)
      const got = ctx.night ? collected(ctx.night.journal, { filterOf: () => a.filter }).get(targetKey(a.target))?.totalMin : undefined;
      const { rec } = adviseFor({
        facts,
        site,
        target,
        from: win.from,
        to: win.to,
        usableMin: win.usableMin,
        conditions: await weather.conditionsAt(site, tz),
        fixed: { filter: a.filter, gain: a.gain, subS: a.sub_s },
        collectedMin: got ? Math.round(got) : 0,
        journal: ctx.night?.journal,
      });
      return text({ window: `${hm(win.from)}–${hm(win.to)} (${win.why})`, ...rec });
    },
  );

  tool(
    'acquisition_measure',
    "Measure THIS telescope and site from its own raw frames, so acquisition_plan stops relying on spec-sheet guesses. Deterministic statistics on one green phase of the Bayer mosaic with star-robust estimators; results are stored and used from then on. sensor: dark frames of ONE gain with the light path closed (≥2 single frames of the same short exposure give the read noise; a second exposure length or the camera's BIAS card separates offset from dark current; masters give levels only). sky: clear-sky light subs of a session (newest `count`): the sky background (ADU/s → e⁻/s → mag/arcsec² where the scope pointed, and the zenith moonless sky it implies; a cohort with the Moon down, the target above 35° in astronomical dark counts toward the site's sky), the conversion gain e⁻/ADU by photon transfer, the clip level, the stars' FWHM and roundness, and the session's sub cadence and dither cost. check: the same on the newest subs of a RUNNING session, plus a verdict against the overexposure and trailing limits: keep, shorten (background over the limit, clipping, trailing), lengthen (read-noise limited with headroom) or refocus. show: what is stored. forget: drop a measurement (device id [+ gain], or sky / seeing).",
    {
      action: z.enum(['sensor', 'sky', 'check', 'show', 'forget']),
      session: z.string().optional().describe("a session folder (SEESTAR_RAW_…/DWARF_RAW_…) or 'latest': the library copy when transferred, else on the scope (Seestar)"),
      files: z.array(z.string()).optional().describe('library paths, a library folder, or device:/… paths of raw FITS'),
      count: z.number().int().min(1).max(MAX_DARKS).optional().describe(`frames to read (newest; default ${MAX_LIGHTS - 2} lights, all darks up to ${MAX_DARKS})`),
      forget: z.enum(['gain', 'device', 'sky', 'seeing']).optional(),
      gain: z.number().optional().describe('forget=gain: which gain'),
    },
    async (a) => {
      const facts = await ctx.facts();
      const rig = resolveRig(facts);
      const devKey = deviceKey(rig.spec.id, rig.serial);
      if (a.action === 'show') {
        const s = storeView();
        return text({ device: devKey, sensors: s.sensors, siteSky: siteSky(), lastSky: s.sky.slice(-10), seeing: siteSeeing(devKey), lastSeeing: s.seeing.slice(-10) });
      }
      if (a.action === 'forget') {
        if (!a.forget) throw new Error('forget needs forget=gain|device|sky|seeing');
        const done = forget({ device: a.forget === 'gain' || a.forget === 'device' ? devKey : undefined, gain: a.forget === 'gain' ? a.gain : undefined, sky: a.forget === 'sky', seeing: a.forget === 'seeing' });
        return text({ forgot: done });
      }

      if (a.action === 'sensor') {
        const { frames } = await loadFrames(ctx, { files: a.files, session: a.session, count: a.count ?? MAX_DARKS, newest: false });
        const r = measureSensor(frames);
        const gain = Number.isFinite(r.gain) ? r.gain : (a.gain ?? rig.gains[0]);
        const k = rig.sensorAt(gain).ePerAdu;
        recordSensor(rig.spec.id, rig.serial, {
          gain,
          readNoiseAdu: r.readNoiseAdu ?? undefined,
          blackAdu: r.biasAdu,
          blackAtS: r.biasAtS,
          darkEPerS: r.darkAduPerS !== null ? r.darkAduPerS * k : undefined,
          at: Date.now(),
          frames: r.frames,
          how: r.how.join('; '),
        }, { blackAdu: r.biasAdu });
        const after = resolveRig(facts);
        return text({ device: devKey, measured: { ...r, readNoiseE: r.readNoiseAdu !== null ? r2(r.readNoiseAdu * k) : null, darkEPerS: r.darkAduPerS !== null ? r2(r.darkAduPerS * k) : null }, nowUsed: sensorLine(after, gain) });
      }

      // sky / check: light subs
      const { frames, bytes, names } = await loadFrames(ctx, { files: a.files, session: a.session, count: Math.min(a.count ?? MAX_LIGHTS - 2, MAX_LIGHTS), newest: true });
      const gains = new Set(frames.map((f) => f.gain));
      if (gains.size > 1) throw new Error(`the subs are of several gains (${[...gains].join(', ')}): measure one cohort at a time`);
      const gain = frames[0].gain ?? rig.gains[0];
      const sensor = rig.sensorAt(gain);
      const rnAdu = sensor.readNoiseE / sensor.ePerAdu;
      const stats = frames.map((f) => frameStats(f));
      const clip = clipLevel(stats);
      // the black at a sub's length: an offset (the camera's BIAS card, else a measured one) plus the
      // dark current over the sub; without either, the spec's level, which is a dark's at a typical sub
      const darkAduPerS = sensor.darkCurrentEPerS / sensor.ePerAdu;
      const profile = sensorProfile(rig.spec.id, rig.serial);
      const measuredBias = profile?.gains[String(gain)]?.blackAdu ?? profile?.blackAdu;
      const measuredAtS = profile?.gains[String(gain)]?.blackAtS ?? 0;
      const blackAt = (t: number, f: RawFrame) => {
        if (f.biasAdu !== undefined) return f.biasAdu + darkAduPerS * t;
        // a measured black read at some exposure already holds that much dark current
        return measuredBias !== undefined ? measuredBias + darkAduPerS * Math.max(0, t - measuredAtS) : sensor.blackAdu;
      };
      const all = measureLights(frames, { blackAt, readNoiseAdu: rnAdu, clipAdu: clip });
      const lights = all.filter((l) => !l.outlier);
      if (!lights.length) throw new Error('every sub of the cohort is dark: the light path was shut or clouded');
      // photon transfer is only as good as the black under it: the camera's offset card or a measured one
      const blackKnown = frames.every((f) => f.biasAdu !== undefined) || measuredBias !== undefined;
      const ks = lights.map((l) => l.ePerAdu).filter((k): k is number => k !== null);
      const kNew = ks.length >= 2 && blackKnown ? median(ks) : null;
      const k = kNew ?? sensor.ePerAdu;
      const subS = frames[0].exposureS ?? 0;
      const skyAdu = median(lights.map((l) => l.skyAdu));
      const rateAdu = skyAdu / Math.max(1e-6, subS);
      const filter = rigFilter(rig, frames[0].filter);
      const eSky = Math.max(1e-9, rateAdu * k - sensor.darkCurrentEPerS);
      const sqmThere = magForRate(rig, eSky, filter.skyFraction);
      // the newest sub that saw the sky stands for the pointing and the stars
      const lastIdx = all.map((l, i) => (l.outlier ? -1 : i)).filter((i) => i >= 0).pop()!;
      const last = frames[lastIdx];
      const site = ctx.site();
      const at = last.at !== undefined ? new Date(last.at) : new Date();
      const pos = last.raHours !== undefined && last.decDeg !== undefined ? sky.altAz(site, last.raHours, last.decDeg, at) : null;
      const moon = last.raHours !== undefined && last.decDeg !== undefined ? moonToward(site, last.raHours, last.decDeg, at) : null;
      const sunAlt = sky.bodyAlt(site, 'Sun', at);
      const cond = (await weather.conditionsAt(site, tz))?.(at);
      // the zenith moonless sky only from a moonless cohort: the moonlight model is not good enough to subtract
      const moonDown = (moon?.altDeg ?? -90) < TRUSTED_MOON_ALT;
      const zenith = pos && moonDown ? zenithFromMeasured({ sqmThere, altDeg: pos.altitude, moon }) : null;
      const trusted = !!pos && zenith !== null && sunAlt < TRUSTED_SUN_ALT && moonDown && pos.altitude >= TRUSTED_ALT;

      // the stars of the newest sub, on its own pixel scale (a debayered frame may be half size)
      let stars: { fwhmArcsec?: number; roundness?: number; count: number; error?: string } = { count: 0 };
      try {
        const img = await decode(bytes[lastIdx], last.name);
        const scale = rig.plateScale * (Math.max(last.width, last.height) / Math.max(img.width, img.height));
        const an = analyze(img, 'tele', scale);
        stars = { fwhmArcsec: an.stars.medianFwhmArcsec, roundness: an.stars.medianRoundness, count: an.stars.count };
      } catch (err) {
        stars = { count: 0, error: errMsg(err) };
      }

      // what is learned is kept (a cohort that measures nothing keeps nothing)
      if (kNew !== null || clip !== undefined) recordSensor(rig.spec.id, rig.serial, { gain, ePerAdu: kNew ?? undefined, at: Date.now(), frames: frames.length, how: `photon transfer on ${ks.length} light subs (${subS}s, ${filter.name})` }, { saturationAdu: clip });
      if (pos && Number.isFinite(sqmThere)) recordSky({ at: at.getTime(), device: devKey, filter: filter.name, gain, subS, rateAduPerS: r2(rateAdu), sqmThere: r2(sqmThere), zenithSqm: zenith !== null ? r2(zenith) : NaN, altDeg: Math.round(pos.altitude), moonAltDeg: Math.round(moon?.altDeg ?? -90), trusted });
      if (stars.fwhmArcsec && stars.count >= 10) recordSeeing({ at: at.getTime(), device: devKey, fwhmArcsec: stars.fwhmArcsec, roundness: stars.roundness, seeingIdx: cond?.seeingIdx, altDeg: pos ? Math.round(pos.altitude) : undefined });

      const range = sensor.saturationAdu - sensor.blackAdu;
      const bgFrac = median(all.map((l, i) => ({ l, i })).filter(({ l }) => !l.outlier).map(({ l, i }) => (stats[i].median - blackAt(l.exposureS, frames[i])) / range));
      const skyE = eSky * subS;
      // the sub against the read noise, from the frames' own scatter (total noise² − RN²): sub_length's swamp factor
      const totalSigmaAdu = median(stats.filter((_, i) => !all[i].outlier).map((s) => s.sigma));
      const skyNoiseAdu = Math.sqrt(Math.max(0, totalSigmaAdu ** 2 - rnAdu ** 2));
      const swamp = rnAdu > 1e-9 ? skyNoiseAdu ** 2 / rnAdu ** 2 : Infinity;
      const swampWanted = config.plan.swampFactor;
      const eff = efficiencyOf(skyNoiseAdu, rnAdu);
      const subLength = {
        swamp: r2(swamp),
        wanted: swampWanted,
        efficiencyPct: Math.round(eff.efficiency * 1000) / 10,
        extraIntegration: r2(eff.extraIntegration),
        minSubForWantedS: swamp > 1e-9 && Number.isFinite(swamp) ? Math.round((swampWanted / swamp) * subS) : null,
        readNoise: `${r2(rnAdu)} ADU (${sensor.source.readNoise})`,
        verdict: efficiencyVerdict(eff.efficiency),
        note: 'from the frames\' own scatter against the stored read noise; sub_length fits the background properly against a reference frame',
        stored: latestSubLength(devKey, filter.name, gain) ? 'a sub_length analysis of this filter and gain is stored and in the plan' : 'no sub_length analysis of this filter and gain yet',
      };
      const measured = {
        frames: frames.map((f) => f.name),
        subS,
        gain,
        filter: filter.name,
        skyAduPerSub: Math.round(skyAdu),
        skyElectronsPerSub: r2(skyE),
        backgroundPctOfRange: Math.round(bgFrac * 1000) / 10,
        clippedPctOfFrame: r2(median(stats.map((s) => s.saturatedPct))),
        clipAdu: clip ?? null,
        ePerAdu: kNew !== null ? Math.round(kNew * 10000) / 10000 : null,
        ePerAduPerSub: ks.map((x) => Math.round(x * 10000) / 10000),
        ePerAduNote: kNew !== null ? 'stored' : !blackKnown ? 'not stored: the black level is the spec\'s guess (no BIAS card, nothing measured): run action=sensor on darks first' : ks.length < 2 ? 'not stored: the sky is too faint against the read noise for photon transfer (longer subs or a brighter sky)' : undefined,
        leftOut: all.filter((l) => l.outlier).map((l) => `${l.name} (sky ${Math.round(l.skyAdu)} ADU: clouded or shut)`),
        skyThere: `${r2(sqmThere)} mag/arcsec² at ${pos ? `${Math.round(pos.altitude)}° alt` : 'an unknown pointing (no RA/DEC in the header)'}`,
        zenithMoonless: zenith !== null ? r2(zenith) : moonDown ? null : 'the Moon is up: not converted (only moonless cohorts measure the site)',
        countsForSite: trusted,
        moon: moon ? `${Math.round(moon.altDeg)}° alt, ${Math.round(moon.sepDeg)}° away` : null,
        stars,
        cadence: cadence(names.map((n) => ({ at: stampOfName(n), exposureS: subS }))),
        subLength,
      };
      if (a.action === 'sky') return text({ device: devKey, measured, siteSky: zenithSky(), nowUsed: sensorLine(resolveRig(facts), gain) });

      // check: against the limits, for the sub length running now
      const verdict: string[] = [];
      // soft stars are judged against what this rig usually gets here (measured), never a model
      const baseline = siteSeeing(devKey);
      const offer = rig.subsS;
      const lower = offer.filter((s) => s < subS).pop();
      const higher = offer.filter((s) => s > subS)[0];
      if (bgFrac > BG_MAX_FRAC) {
        const fit = offer.filter((s) => (bgFrac * s) / subS <= BG_MAX_FRAC).pop();
        verdict.push(`SHORTEN: the sky fills ${Math.round(bgFrac * 100)}% of the range (limit ${BG_MAX_FRAC * 100}%)${fit ? `; ${fit}s keeps it to ${Math.round((bgFrac * fit * 100) / subS)}%` : ''}${filter.band === 'broadband' && rig.filters.some((f) => f.band !== 'broadband') ? ', or the line filter for an emission target' : ''}`);
      }
      if (median(stats.map((s) => s.saturatedPct)) > CLIPPED_PCT) verdict.push(`SHORTEN: ${r2(median(stats.map((s) => s.saturatedPct)))}% of the frame is clipped — more than stars: the target's core or the sky${lower ? `; try ${lower}s` : ''}`);
      if (stars.roundness !== undefined && stars.count >= 10 && stars.roundness < ROUND_MIN) verdict.push(`SHORTEN or check tracking: stars are elongated (roundness ${r2(stars.roundness)}) — ${rig.mount === 'alt-az' ? 'field rotation or wind' : 'drift, balance or wind'}${lower ? `; ${lower}s` : ''}`);
      if (baseline && stars.fwhmArcsec !== undefined && stars.count >= 10 && stars.fwhmArcsec > SOFT_FACTOR * baseline.fwhmArcsec) verdict.push(`REFOCUS: stars are ${r2(stars.fwhmArcsec)}″ against ${r2(baseline.fwhmArcsec)}″ usual for this rig (${baseline.samples} samples)`);
      if (!verdict.length && higher && skyE < SKY_LIMITED_K * sensor.readNoiseE ** 2 && (bgFrac * higher) / subS <= BG_MAX_FRAC) {
        verdict.push(`LENGTHEN to ${higher}s if the mount holds it (acquisition_plan advise says): the sky gives ${r2(skyE)} e⁻ per sub, under ${SKY_LIMITED_K}×RN² = ${r2(SKY_LIMITED_K * sensor.readNoiseE ** 2)} — read noise still costs SNR (swamp ${r2(swamp)}× of ${swampWanted} wanted, sub efficiency ${subLength.efficiencyPct}%), and the background would be ${Math.round((bgFrac * higher * 100) / subS)}%`);
      }
      if (!verdict.length) verdict.push(`KEEP: background ${Math.round(bgFrac * 100)}% of the range, nothing clipping beyond stars, stars round and sharp`);
      return text({ device: devKey, verdict, measured, rules: `background ≤ ${BG_MAX_FRAC * 100}% of the range; clipped ≤ ${CLIPPED_PCT}% of the frame; roundness ≥ ${ROUND_MIN}; FWHM ≤ ${SOFT_FACTOR}× this rig's usual${baseline ? '' : ' (no baseline yet: three sky/check cohorts make one)'}` });
    },
  );

  tool(
    'sub_length',
    "Deep Sky Detail's Sub Length Calculator (the method of its Shiny app, Windows build and Siril script) run on THIS telescope's own raw sub, deterministically: fits the sub's sky background with an exponentially modified Gaussian (sigma = the sky's noise, tau = the skew of nebulosity and gradients), reads the read noise and offset off a reference frame, and reports the swamp factor the sub reaches (sky noise² / read noise²; 10 is DSD's recommendation, PLAN_SWAMP_FACTOR is what the plan wants), the sub efficiency (sky noise / total noise; ≥ 95% is excellent) and the extra integration a lower one costs, the minimum sub for the wanted factor and the device's offered sub that reaches it, plus the sky's electrons per second and the Poisson cross-check through e⁻/ADU. analyze: the newest sub of a session (or given files). The reference: `reference` files (bias frames, or ≥2 single darks of the sub's own length — their scatter is the read noise), else the matching dark master fetched FROM THE SCOPE (the Dwarf's CALI_FRAME, the Seestar's darklibrary: its level is the offset; the read noise is then this rig's measured one, else the spec's — said so), else the sub's own BIAS card. The result is stored per filter and gain, and acquisition_plan from then on scales its sky-noise term by it and quotes the swamp factor of its recommendation. show: the stored analyses. forget: drop them for this device.",
    {
      action: z.enum(['analyze', 'show', 'forget']),
      session: z.string().optional().describe("a session folder or 'latest': the library copy when transferred, else on the scope"),
      files: z.array(z.string()).optional().describe('light subs: library paths, a library folder, or device:/… paths'),
      count: z.number().int().min(1).max(MAX_SUBLENGTH_LIGHTS).optional().describe('newest subs to analyse (default 1; the median of several is stored)'),
      reference: z.array(z.string()).optional().describe('bias or dark frames to read the offset and read noise from (library or device:/… paths); omit to fetch the matching dark from the scope'),
      swamp: z.number().min(1).max(100).optional().describe(`swamp factor wanted (default PLAN_SWAMP_FACTOR ${config.plan.swampFactor}; DSD's slider runs 2–10)`),
      channel: z.enum(['auto', 'L', 'R', 'G', 'B']).optional().describe('the colour channel analysed: auto = a green phase of the mosaic (default), L = every pixel, R/G/B by the Bayer pattern'),
      narrowband: z.boolean().optional().describe("DSD's narrowband mode (the background is the nebula, so the skew counts as signal): default true through a line/duo-band filter"),
      duration_s: z.number().positive().optional().describe("the sub's exposure when its header lacks EXPTIME"),
    },
    async (a) => {
      const facts = await ctx.facts();
      const rig = resolveRig(facts);
      const devKey = deviceKey(rig.spec.id, rig.serial);
      if (a.action === 'show') return text({ device: devKey, wanted: config.plan.swampFactor, analyses: subLengthSamples(devKey).slice(0, 20), inPlan: rig.filters.map((f) => rig.gains.map((g) => ({ filter: f.name, gain: g, sample: latestSubLength(devKey, f.name, g) ?? null }))).flat().filter((x) => x.sample) });
      if (a.action === 'forget') return text({ forgot: forget({ device: devKey, subLength: true }) });

      const wanted = a.swamp ?? config.plan.swampFactor ?? DEFAULT_SWAMP;
      const channel: Channel = a.channel ?? 'auto';
      const { frames } = await loadFrames(ctx, { files: a.files, session: a.session, count: a.count ?? 1, newest: true });
      const light = frames[frames.length - 1];
      const gains = new Set(frames.map((f) => f.gain));
      if (gains.size > 1) throw new Error(`the subs are of several gains (${[...gains].join(', ')}): analyse one cohort at a time`);
      const gain = light.gain ?? rig.gains[0];
      const sensor = rig.sensorAt(gain);
      const filter = rigFilter(rig, light.filter);
      const subS = a.duration_s ?? light.exposureS;
      if (!subS) throw new Error(`${light.name} has no EXPTIME: give duration_s`);
      const narrowband = a.narrowband ?? filter.band !== 'broadband';

      // the reference: the owner's frames, else the scope's matching dark, else the sub's own offset card
      const notes: string[] = [];
      let refFrames: RawFrame[] = [];
      let refFrom = '';
      if (a.reference?.length) {
        refFrames = await Promise.all(a.reference.slice(0, MAX_REFERENCE + 2).map(async (p) => readRaw(await bytesOf(p), path.basename(p.replace(/^device:/, '')))));
        refFrom = 'the reference files given';
      } else if (ctx.darkFrames) {
        const listed = await ctx.darkFrames().catch((err) => {
          notes.push(`the scope's dark frames could not be listed: ${errMsg(err)}`);
          return [] as DarkFrameRef[];
        });
        const picked = pickReference(listed, { exposureS: subS, gain: light.gain, tempC: light.tempC });
        if (picked.length) {
          refFrames = await Promise.all(picked.map(async (d) => readRaw(await bytesOf(`device:${d.path}`), path.basename(d.path))));
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

      const results: SubLengthResult[] = frames.map((f) => analyzeSubLength({ light: f, readNoiseAdu, levelAdu, ePerAdu: sensor.ePerAdu, swamp: wanted, durationS: subS, channel, narrowband }));
      // the frame of the median swamp stands for the cohort
      const bySwamp = [...results].sort((x, y) => x.swamp - y.swamp);
      const res = bySwamp[bySwamp.length >> 1];
      const pick = frames[results.indexOf(res)];
      notes.push(...res.notes);

      // the planner's calibration: the measured sky variance rate against its model sky at this pointing and time
      const site = ctx.site();
      const at = pick.at !== undefined ? new Date(pick.at) : new Date();
      const pos = pick.raHours !== undefined && pick.decDeg !== undefined ? sky.altAz(site, pick.raHours, pick.decDeg, at) : null;
      let skyNoiseScale: number | null = null;
      let model: { sqm: number; ePerS: number } | null = null;
      if (pos && pos.altitude > 0) {
        const zen = zenithSky();
        const moon = moonToward(site, pick.raHours!, pick.decDeg!, at);
        const sb = skyBrightness({ zenithSqm: zen.sqm, altDeg: pos.altitude, moon });
        const eSkyModel = electronRate(rig, sb.sqm, filter.skyFraction) + sensor.darkCurrentEPerS;
        const measuredVarE = (res.skyNoiseAdu * sensor.ePerAdu) ** 2 / subS;
        skyNoiseScale = eSkyModel > 0 ? measuredVarE / eSkyModel : null;
        model = { sqm: r2(sb.sqm), ePerS: r2(eSkyModel) };
      } else notes.push('no pointing in the header (RA/DEC): the plan gets the swamp numbers but not the sky-noise scale');

      recordSubLength({
        at: at.getTime(),
        device: devKey,
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
      });
      // a bias frame's scatter is the read noise itself: the sensor profile learns it
      if (ref?.readNoiseHow === 'bias frame (DSD rule)' && Number.isFinite(ref.readNoiseAdu!)) recordSensor(rig.spec.id, rig.serial, { gain, readNoiseAdu: r2(ref.readNoiseAdu!), at: Date.now(), frames: ref.frames.length, how: `sub_length: ${ref.frames.length} bias frame(s), DSD rule (${ref.how})` });

      const offered = res.minSubS !== null ? (rig.subsS.find((t) => t >= res.minSubS! - 1e-9) ?? null) : null;
      const longest = rig.subsS[rig.subsS.length - 1];
      const fmtS = (x: number | null) => (x === null ? null : x > 1e6 ? 'never' : Math.round(x));
      const recommendation =
        res.minSubS === null
          ? 'the sky adds no measurable noise at this sub: longer subs, or check that the reference is this gain\'s'
          : res.minSubS <= subS
            ? `${subS}s already reaches a swamp factor of ${wanted}: longer subs gain little beyond fewer frames`
            : offered !== null
              ? `${offered}s is the shortest offered sub that reaches ${wanted} (~${Math.round(res.minSubS)}s): acquisition_plan weighs it against trailing and the background`
              : `no offered sub reaches ${wanted} (~${Math.round(res.minSubS)}s needed, ${longest}s the longest): take the longest the mount holds and accept ×${r2(efficiencyOf(Math.sqrt(res.swamp * (longest / subS)), 1).extraIntegration)} integration`;
      return text({
        device: devKey,
        method: 'Deep Sky Detail Sub Length Calculator v1.2.0 (ex-Gaussian MLE of the background, E1/E2 sky noise)',
        frames: frames.map((f) => f.name),
        settings: { filter: filter.name, gain, subS, narrowband, channel: res.channel, swampWanted: wanted },
        reference: {
          frames: ref?.frames ?? [],
          from: refFrom || null,
          levelAdu: r2(levelAdu),
          levelFrom: levelSource,
          scatterAdu: ref ? r2(ref.scatterAdu) : null,
          stackCount: ref?.stackCount ?? null,
          readNoiseAdu: r2(readNoiseAdu),
          readNoiseE: r2(readNoiseAdu * sensor.ePerAdu),
          readNoiseFrom: readNoiseSource,
        },
        background: {
          levelAdu: r2(res.background.levelAdu),
          aboveReferenceAdu: r2(res.background.aboveReferenceAdu),
          aduPerS: Math.round(res.background.aduPerS * 1000) / 1000,
          ePerS: Math.round(res.background.ePerS * 1000) / 1000,
          pixels: res.background.pixels,
          fit: { mu: r2(res.fit.mu), sigma: r2(res.fit.sigma), tau: r2(res.fit.tau), totalSd: r2(res.fit.totalSd), converged: res.fit.converged, iterations: res.fit.iterations, fallback: res.fit.fallback },
        },
        skyNoise: { e1Adu: r2(res.skyNoiseAdu), e1OtherReadingAdu: r2(res.skyNoiseOtherReadingAdu), e2PoissonAdu: r2(res.skyNoisePoissonAdu), note: 'E1 from the fitted scatter (gain-independent); E2 the Poisson noise the level implies through e⁻/ADU — far apart means the gain, the reference or the fit is off' },
        swamp: { measured: r2(res.swamp), byLevel: r2(res.swampPoisson), wanted, minSubS: fmtS(res.minSubS), minSubByLevelS: fmtS(res.minSubPoissonS), offeredSubS: offered },
        efficiency: { pct: Math.round(res.efficiency * 1000) / 10, extraIntegration: r2(res.extraIntegration), verdict: efficiencyVerdict(res.efficiency), gapFactor: r2(res.gapFactor) },
        perFrame: results.length > 1 ? results.map((r) => ({ frame: r.frame, swamp: r2(r.swamp), efficiencyPct: Math.round(r.efficiency * 1000) / 10, skyNoiseAdu: r2(r.skyNoiseAdu) })) : undefined,
        recommendation,
        plan: {
          stored: `the plan scales its sky-noise term for ${filter.name} at gain ${gain}${skyNoiseScale !== null ? ` by ×${r2(skyNoiseScale)}` : ''} and quotes the swamp factor of its recommendation`,
          skyNoiseScale: skyNoiseScale !== null ? r2(skyNoiseScale) : null,
          modelSkyThere: model ? `${model.sqm} mag/arcsec² (${model.ePerS} e⁻/s with dark current) at ${Math.round(pos!.altitude)}° alt` : null,
          readNoiseLearned: ref?.readNoiseHow === 'bias frame (DSD rule)' ? `read noise ${r2(readNoiseAdu)} ADU stored for gain ${gain}` : null,
        },
        notes,
      });
    },
  );
}
