/**
 * The acquisition planner as tools, the same for every driver:
 *
 * - acquisition_plan: the filter, gain, sub length, frame count and integration a target wants on
 *   this rig through tonight's sky (its night-plan block, or the window asked for), with the
 *   overexposure margins and the reasons; the device in use and every known model.
 * - acquisition_measure: this rig's own numbers from its raw frames — the sensor (darks), the sky,
 *   the conversion gain and the stars (lights), a running session checked against what the plan
 *   expects — kept in <data>/acquisition.json, which the plan then uses instead of the spec.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../../config.js';
import { errMsg } from '../../log.js';
import * as sky from '../../astro/sky.js';
import * as weather from '../../astro/weather.js';
import { targetKey } from '../../astro/rest.js';
import { adviseFor, targetInfo, zenithSky, type FactsSource } from '../../astro/acquisition/index.js';
import { BG_MAX_FRAC, magForRate } from '../../astro/acquisition/advise.js';
import { loadDevices, resolveRig, rigFilter, userDevicesDir, type Rig } from '../../astro/acquisition/devices.js';
import { cadence, clipLevel, frameStats, measureLights, measureSensor, readRaw, stampOfName, type RawFrame } from '../../astro/acquisition/measure.js';
import { moonToward, zenithFromMeasured } from '../../astro/acquisition/skyglow.js';
import { deviceKey, forget, recordSeeing, recordSensor, recordSky, sensorProfile, siteSeeing, siteSky, storeView } from '../../astro/acquisition/store.js';
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

export interface AcquisitionContext {
  site(): sky.Site;
  facts: FactsSource;
  night?: NightServices | null;
  /** a session on the scope's storage as fetchable device paths, oldest first (the Seestar's) */
  sessionSubs?(folder: string): Promise<string[]>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

const isLightName = (n: string) => /\.fits?$/i.test(n) && !/^failed_|stack|master|dark|flat|bias/i.test(n);

/** Raw frames from library paths, device paths (device:…), a library folder, or a session (local when transferred, else on the scope). */
async function loadFrames(ctx: AcquisitionContext, o: { files?: string[]; session?: string; count: number; newest: boolean }): Promise<{ frames: RawFrame[]; bytes: Buffer[]; names: string[] }> {
  const bytesOf = (p: string): Promise<Buffer> => (p.startsWith('device:') ? deviceLibrary().album.fetch(p.slice('device:'.length), DEVICE_FILE_MAX_BYTES) : fs.promises.readFile(resolveLocalPath(p)));
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
        verdict.push(`LENGTHEN to ${higher}s if the mount holds it (acquisition_plan advise says): the sky gives ${r2(skyE)} e⁻ per sub, under ${SKY_LIMITED_K}×RN² = ${r2(SKY_LIMITED_K * sensor.readNoiseE ** 2)} — read noise still costs SNR, and the background would be ${Math.round((bgFrac * higher * 100) / subS)}%`);
      }
      if (!verdict.length) verdict.push(`KEEP: background ${Math.round(bgFrac * 100)}% of the range, nothing clipping beyond stars, stars round and sharp`);
      return text({ device: devKey, verdict, measured, rules: `background ≤ ${BG_MAX_FRAC * 100}% of the range; clipped ≤ ${CLIPPED_PCT}% of the frame; roundness ≥ ${ROUND_MIN}; FWHM ≤ ${SOFT_FACTOR}× this rig's usual${baseline ? '' : ' (no baseline yet: three sky/check cohorts make one)'}` });
    },
  );
}
