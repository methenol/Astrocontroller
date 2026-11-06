/** Night planning: sky and weather, a clear-sky check, target ranking and the object catalog. */
import { z } from 'zod';
import { config, planDefaults } from '../../config.js';
import { errMsg } from '../../log.js';
import { round } from '../../drivers/dwarf/device.js';
import { analyze, autoStretch, loadImage, toJpeg, type FloatImage } from '../../media/images.js';
import { describe as describeObject, findObject, gotoLabel, searchObjects } from '../../astro/catalog.js';
import { queryCatalog } from '../../astro/catalog-search.js';
import { planNight } from '../../astro/planner.js';
import { horizonFor } from '../../astro/horizon.js';
import * as rest from '../../astro/rest.js';
import * as sky from '../../astro/sky.js';
import * as weather from '../../astro/weather.js';
import type { Dwarf } from '../../drivers/dwarf/device.js';
import type { StreamHub } from '../../media/streams.js';
import { capturedLine, except, localTime, saveCapture, text, withImage, type ToolFn } from './common.js';

const PLANETS = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'] as const;
export const DEFAULT_TELE_FOV = { h: 2.95, v: 1.66 };
/** Astronomical darkness: the Sun this far below the horizon. */
const DARK_SUN_ALT = -18;
/** sky_check's still: night settings on the wide camera. */
const SKY_CHECK_EXPOSURE_S = 2.5;
const SKY_CHECK_GAIN = 60;
/** sky_check's verdict: a background median above this is a bright sky; stars from these counts are clear / partly clear. */
const BRIGHT_BACKGROUND = 0.6;
const CLEAR_STARS = 40;
const PARTLY_CLEAR_STARS = 10;
/** Motor pitch of the horizon in Alt-Az (altitude ≈ pitch − 90), and below this pitch the pointing is low. */
const HORIZON_PITCH_DEG = 90;
const LOW_POINTING_PITCH_DEG = 120;

/** Sun altitude above which the sky is too bright for a star count to say anything (civil twilight). */
const TWILIGHT_SUN_ALT = -6;

/**
 * sky_check's verdict. No stars says "cloudy" only when the sky could show stars: with the Sun up
 * or the scope pointing below the horizon (parked) it says why the check could not tell.
 */
export function skyVerdict(o: { blank: boolean; background: number; stars: number; sunAltDeg?: number; altitudeDeg?: number }): string {
  if (o.blank) return 'invalid frame (blank)';
  if (o.altitudeDeg !== undefined && o.altitudeDeg < 0) return `unknown: the scope points below the horizon (altitude ${Math.round(o.altitudeDeg)}°); raise it (pitch > 150) and check again`;
  // in daylight the detector counts edges, noise and glare as "stars": no star count is a sky reading then
  // in twilight, though, a full field of stars is real: only a short count is no reading
  if (o.sunAltDeg !== undefined && o.sunAltDeg > TWILIGHT_SUN_ALT && (o.sunAltDeg > 0 || o.stars < CLEAR_STARS)) return `unknown: the Sun is ${o.sunAltDeg > 0 ? 'up' : 'only just set'} (${Math.round(o.sunAltDeg)}°), too bright for stars; check after dusk`;
  if (o.background > BRIGHT_BACKGROUND) return 'too bright (twilight, Moon glow or a lit cloud deck)';
  if (o.stars >= CLEAR_STARS) return 'clear';
  if (o.stars >= PARTLY_CLEAR_STARS) return 'partly clear / thin cloud';
  return 'cloudy (no usable stars)';
}

export interface PlanningContext {
  site(): { lat: number; lon: number; elev: number };
  /** the tele field in degrees, or null for the nominal Dwarf 3 one */
  teleFov(): { h: number; v: number } | null;
  /** the Dwarf, for sky_check (it photographs with the wide camera); without it sky_check is not registered */
  dwarf?: Dwarf;
  hub?: StreamHub;
  /** tools the driver has its own of */
  skip?: string[];
  /** the target memory changed (rest_target): the night plan is solved again */
  restChanged?: () => void;
}

export function registerPlanningTools(all: ToolFn, o: PlanningContext): void {
  const tz = config.observer.timezone;
  const tool = except(all, [...(o.skip ?? []), ...(o.dwarf && o.hub ? [] : ['sky_check'])]);
  // only sky_check uses these, and it is registered only when they are given
  const dwarf = o.dwarf as Dwarf;
  const hub = o.hub as StreamHub;
  const site = () => o.site();
  const teleFov = () => o.teleFov() ?? DEFAULT_TELE_FOV;
  const restChanged = o.restChanged;

  tool(
    'sky_conditions',
    "Tonight's observing window at the observer location: sunset, twilights, astronomical darkness start/end, Sun and Moon altitude, Moon phase/illumination/rise/set, and planet visibility.",
    { date: z.string().optional().describe('local date (YYYY-MM-DD = that night) or local date-time; default now') },
    async ({ date }) => {
      const s = site();
      const when = date ? sky.parseLocal(date, tz) : new Date();
      const w = sky.nightWindow(s, when);
      const f = (d: Date | null) => sky.fmtTime(d, tz);
      const at = (v: unknown) => (v ? new Date(String(v)) : null);
      const sunAlt = sky.bodyAlt(s, 'Sun', when);
      return text({
        localTime: localTime(when),
        sunAltitude: round(sunAlt, 1),
        isDark: sunAlt < DARK_SUN_ALT,
        night: { sunset: f(w.sunset), civilDusk: f(w.civilDusk), nauticalDusk: f(w.nauticalDusk), astronomicalDusk: f(w.astroDusk), astronomicalDawn: f(w.astroDawn), sunrise: f(w.sunrise) },
        darkHours: w.darkStart && w.darkEnd ? round((w.darkEnd.getTime() - w.darkStart.getTime()) / 3600e3, 1) : 0,
        moon: sky.moonState(s, when),
        planets: PLANETS.map((b) => sky.bodyInfo(s, b, when)).map((p) => ({
          body: p.body,
          altitudeNow: p.altitude,
          magnitude: p.magnitude,
          transit: f(at(p.nextTransit)),
          transitAltitude: p.transitAltitude,
          rise: f(at(p.nextRise)),
          set: f(at(p.nextSet)),
        })),
      });
    },
  );

  tool(
    'weather_forecast',
    'Local weather & observability for the observer location: current conditions, and an hourly forecast with cloud cover (low/mid/high), rain chance, wind/gusts, humidity, dew-point spread (dew risk), visibility, astronomical seeing & transparency (7Timer), and a 0–100 observability score. period "tonight" (default) gives the darkness window with a verdict and the best clear window; "next24"/"next72" give raw hours.',
    { period: z.enum(['tonight', 'next24', 'next72']).optional() },
    async ({ period }) => {
      const s = site();
      if (!period || period === 'tonight') {
        const t = await weather.tonight(s, tz);
        return text({ ...t, hours: t.hours.map(compactHour), ...forecastStaleness(t) });
      }
      const f = await weather.forecast(s, tz);
      const from = Date.now() - 3600e3;
      const n = period === 'next24' ? 24 : 72;
      return text({
        fetchedAt: f.fetchedAt,
        ageMin: f.ageMin,
        stale: f.stale,
        current: f.current,
        hours: f.hours.filter((h) => new Date(h.time).getTime() >= from).slice(0, n).map(compactHour),
        ...forecastStaleness(f),
      });
    },
  );

  tool(
    'sky_check',
    "One-call clear-sky check: points nowhere (uses the current pointing), takes a single wide-camera still at night settings (default 2.5 s, gain 60), restores the camera's previous exposure/gain, and returns the star count, background level, a verdict (clear / partly clear / cloudy / bright, or unknown with the reason when the Sun is up or the scope points below the horizon) and the image. Raise the scope above ~60° altitude first (pitch > 150). Use this instead of hand-setting exposure/gain + take_photo + analyze_image.",
    {
      exposure_s: z.number().min(0.2).max(15).optional().describe('default 2.5'),
      gain: z.number().min(0).max(240).optional().describe('default 60'),
    },
    async ({ exposure_s, gain }) => {
      const exp = exposure_s ?? SKY_CHECK_EXPOSURE_S;
      const g = gain ?? SKY_CHECK_GAIN;
      // refused before the gain changes: the still inside would refuse only after it
      dwarf.assertNoNdLock('a sky check');
      dwarf.assertCameraFree('wide', 'a sky check');
      // one operation: nothing else may change the wide camera between the gain change and its restore
      const { img, pos, restoredTo } = await dwarf.exclusive('checking the sky', async () => {
        const pos = await dwarf.readMotorPositions().catch(() => null);
        const settings = await dwarf.cameraSettings('wide');
        const prevGain = (settings.settings.gain as { current?: unknown } | undefined)?.current;
        // exposure goes back to the previous known value below 1 s, else auto: a long manual
        // exposure left on the wide camera stops its live video entirely
        const prevExpRaw = (settings.settings.exposure as { current?: unknown } | undefined)?.current;
        const prevExp = typeof prevExpRaw === 'string' && !prevExpRaw.startsWith('unknown') && !(Number(prevExpRaw) >= 1) ? prevExpRaw : 'auto';
        let img: FloatImage;
        // a restore that fails is reported: the result must not claim settings the camera does not have
        const restoreErrors: string[] = [];
        await dwarf.setSetting('wide', 'gain', g);
        try {
          ({ img } = await loadImage('wide', hub, { exposureS: exp }));
        } catch (err) {
          throw new Error(`sky_check could not take its still, so the sky is UNKNOWN (not cloudy): ${errMsg(err)}`);
        } finally {
          if (typeof prevGain === 'number') await dwarf.setSetting('wide', 'gain', prevGain).catch((e) => restoreErrors.push(`gain: ${errMsg(e)}`));
          await dwarf.setSetting('wide', 'exposure', prevExp).catch((e) => restoreErrors.push(`exposure: ${errMsg(e)}`));
        }
        const restoredTo = restoreErrors.length
          ? `NOT restored (${restoreErrors.join('; ')}): set the wide exposure back to ${prevExp} and gain to ${typeof prevGain === 'number' ? prevGain : 'its previous value'} with set_camera_setting`
          : `${prevExp} / gain ${typeof prevGain === 'number' ? prevGain : '?'}`;
        return { img, pos, restoredTo };
      });
      const a = analyze(img, 'wide');
      const stars = a.stars.count;
      const bg = a.stats.median;
      // pitch is altitude only on the alt-az head: tilted onto a wedge (EQ) it is a polar-axis angle,
      // and a "below the horizon" verdict from it is false (2026-10-19: EQ pointing at 43° read as -15°)
      const altAz = dwarf.state.bodyMode !== 'eq';
      const altitudeDeg = altAz && pos?.pitchDeg !== undefined ? pos.pitchDeg - HORIZON_PITCH_DEG : undefined;
      const sunAlt = (() => {
        try {
          return sky.bodyAlt(site(), 'Sun', new Date());
        } catch {
          return undefined;
        }
      })();
      const verdict = skyVerdict({ blank: a.assessment.some((x) => x.startsWith('FLAT')), background: bg, stars, sunAltDeg: sunAlt, altitudeDeg });
      const jpeg = await toJpeg(autoStretch(img), 1024);
      const saved = saveCapture(jpeg, 'sky_check');
      const summary = {
        verdict,
        stars,
        backgroundMedian: bg,
        medianHfrPx: a.stars.medianHfrPx,
        pointing: pos ? { rotationDeg: pos.rotationDeg, pitchDeg: pos.pitchDeg, altitudeDeg: altitudeDeg !== undefined ? Math.round(altitudeDeg) : undefined } : undefined,
        settingsUsed: `${exp}s, gain ${g} (camera ${restoredTo.startsWith('NOT') ? restoredTo : `restored to ${restoredTo}`})`,
        captured: capturedLine(img),
        image: `captures/${saved}`,
        notes: altAz && pos?.pitchDeg !== undefined && pos.pitchDeg < LOW_POINTING_PITCH_DEG ? 'pointing is low (< 30° altitude): trees, houses and haze will reduce the star count' : undefined,
      };
      return withImage(jpeg, JSON.stringify(summary, null, 1));
    },
  );

  tool(
    'plan_targets',
    "Rank deep-sky targets for tonight (or a given window) for the Dwarf 3 tele camera. Each target is scored on five things — framing (fits the tele frame), reach (fraction of tonight it is up), integration (minutes actually worth pointing at, after the Moon by target class, alt-az field rotation near the zenith, and a real session's duty cycle), detectability (its surface brightness against tonight's sky through the filter in config) and appeal — then scaled by weatherAlignment (how good the forecast is during that target's own best hours, weighted toward its peak) and reduced by the app's memory of what it suggested recently and what the library already holds. Quote the numbers, do not re-derive them: `detectReason` says whether the sky and glass can bring it up at all, `usableMinutes` is the time that counts, `subSeconds`/`subs`/`integrationMinutes`/`exposureAdvice` are the exposure answer, `bestClearFrom`/`bestClearUntil` is the longest run that is up, forecast-clear and moon-workable (the go/no-go window), and `restReason` why something is being held back. `hero` is what to start with, `season` what tonight's sky is about. Plan against a sky with PLAN_BORTLE and, per target, the best of the scope's own filters (PLAN_FILTERS: Astro / Duo-Band); `suggestedFilter` starts with the filter to pass to live_stacking. Override per call with bortle, or filter to force one glass. When this site has an obstruction map (map_obstructions), a target counts as up only above the mapped trees and buildings in its direction: `horizon` names the map in use (null = none, minimum altitude only), `obstructedNow` marks a target that is above the minimum altitude but behind an obstruction right now (the map, or a view found blocked tonight by tele_visibility/mark_blocked, filed as that patch of sky at that time) and `clearsAt` when the turning sky brings it clear (null = not tonight); ignore_horizon plans without it.",
    {
      types: z.array(z.string()).optional().describe('galaxy, nebula, emission, planetary, cluster, globular, open_cluster, supernova_remnant, reflection, dark, galaxy_cluster'),
      min_altitude: z.number().min(0).lt(90).optional(),
      max_magnitude: z.number().optional().describe('default 11'),
      min_size_arcmin: z.number().optional().describe('default 4'),
      max_size_arcmin: z.number().optional(),
      min_fov_percent: z.number().min(0).max(100).optional().describe('only targets whose major axis covers at least this percent of the tele frame width (e.g. 25 = fills a quarter of the frame)'),
      start: z.string().optional().describe('local time YYYY-MM-DDTHH:MM; default astronomical dusk (or now)'),
      end: z.string().optional().describe('local time; default astronomical dawn'),
      limit: z.number().int().min(1).max(50).optional(),
      bortle: z.number().int().min(1).max(9).optional().describe('judge against this sky class instead of PLAN_BORTLE (1 dark … 9 inner city)'),
      filter: z.string().optional().describe('plan every target through this one glass instead of the scope\'s own filters ("none", "astro", "duo-band", "ha 7nm", "oiii"); omit to have each target planned through the best of PLAN_FILTERS (the Dwarf 3\'s Astro / Duo-Band), named in suggestedFilter'),
      ignore_rest: z.boolean().optional().describe('true to rank on the sky alone, ignoring captures and recent suggestions (answers "what is up tonight", not "what should I shoot")'),
      ignore_horizon: z.boolean().optional().describe("true to plan against the minimum altitude alone, ignoring this site's mapped obstructions (map_obstructions)"),
    },
    async (a) => {
      const s = site();
      const horizon = a.ignore_horizon ? undefined : horizonFor(s);
      const fov = teleFov();
      const conditions = (await weather.conditionsAt(s, tz)) ?? undefined;
      const defaults = planDefaults();
      const plan = planNight(s, {
        conditions,
        types: a.types,
        minAltitude: a.min_altitude ?? config.observer.minAltitudeDeg,
        maxMagnitude: a.max_magnitude,
        minSizeArcmin: a.min_size_arcmin,
        maxSizeArcmin: a.max_size_arcmin,
        minFovPercent: a.min_fov_percent,
        start: a.start ? sky.parseLocal(a.start, tz) : undefined,
        end: a.end ? sky.parseLocal(a.end, tz) : undefined,
        limit: a.limit,
        fovArcmin: { w: fov.h * 60, h: fov.v * 60 },
        timezone: tz,
        bortle: a.bortle ?? defaults.bortle,
        filter: a.filter ?? (defaults.filter || undefined),
        filters: defaults.filters,
        rig: defaults.rig,
        applyRest: a.ignore_rest ? false : undefined,
        horizon,
      });
      if (!a.ignore_rest) rest.recordShown([{ name: plan.hero ?? '', role: 'hero' }, ...plan.targets.slice(0, 5).map((t) => ({ name: t.name, role: 'shortlist' as const }))], sky.localDate(new Date(), tz));
      return text(plan);
    },
  );

  tool(
    'rest_target',
    "Tell the planner to hold a target back, or to stop holding it back: role=snooze parks it like a recent capture and lets it decay back; role=done never suggests it again until cleared; role=clear lifts both. Targets the library already holds are rested by themselves — this is the user's own say on top of that. It does not stop the user from shooting it, and it does not affect find_target or search_catalog.",
    {
      name: z.string().describe('target as people call it: M 31, NGC 7000, Sh2-155…'),
      role: z.enum(['snooze', 'done', 'clear']),
    },
    async ({ name, role }) => {
      const o = findObject(name);
      if (!o) throw new Error(`"${name}" is not in the catalog`);
      const today = sky.localDate(new Date(), tz);
      const records = role === 'clear' ? rest.liftRest(name) : rest.setRest(name, role === 'done' ? 'done' : 'snoozed', today);
      restChanged?.();
      const state = rest.restState(name, today, records);
      return text({
        action: role,
        resting: state ? { kind: state.kind, until: state.until, daysAgo: state.daysAgo } : null,
        note: role === 'done' ? 'it will not appear in plan_targets until you clear it' : state ? 'it will fade back into the plan as the rest decays' : 'it is back in the pool',
        target: gotoLabel(o),
      });
    },
  );

  tool(
    'find_target',
    'Look up a target by name (M31, NGC 7000, IC 1396, C 33, Sh2-155, LBN 437, vdB 142, B 33, Abell 39, UGC 12889, HCG 92, Vega, "alpha Lyr", "Orion Nebula", Jupiter, Moon…): J2000 coordinates, type, size, magnitude, other designations, current altitude/azimuth and tonight\'s visibility. goto_name is the name to give goto_target.',
    { name: z.string() },
    async ({ name }) => {
      const s = site();
      const body = sky.bodyByName(name);
      if (body) return text(sky.bodyInfo(s, body));
      const o = findObject(name);
      if (!o) {
        const alts = searchObjects(name, 8).map(describeObject);
        throw new Error(`"${name}" not found in the catalog${alts.length ? `. Similar: ${alts.join('; ')}` : ''}`);
      }
      const now = sky.altAz(s, o.raHours, o.decDeg);
      const w = sky.nightWindow(s);
      const vis = w.darkStart && w.darkEnd ? sky.visibility(s, o.raHours, o.decDeg, w.darkStart, w.darkEnd, config.observer.minAltitudeDeg) : null;
      const fov = teleFov();
      return text({
        summary: describeObject(o),
        goto_name: gotoLabel(o),
        designations: o.aliases.slice(0, 12),
        brightnessClass: o.brightClass,
        catalogs: o.sources,
        raHoursJ2000: round(o.raHours, 5),
        decDegJ2000: round(o.decDeg, 4),
        ra: sky.hoursToHms(o.raHours),
        dec: sky.degToDms(o.decDeg),
        altitudeNow: round(now.altitude, 1),
        azimuthNow: round(now.azimuth, 1),
        tonight: vis ? { maxAltitude: vis.maxAlt, at: sky.fmtTime(vis.maxAltAt, tz), hoursAboveMinAlt: vis.hoursAboveMin, from: sky.fmtTime(vis.firstAbove, tz), until: sky.fmtTime(vis.lastAbove, tz) } : null,
        fitsTeleFov: o.majorArcmin ? `${round((o.majorArcmin / (fov.h * 60)) * 100, 0)}% of frame width` : 'unknown size',
      });
    },
  );

  tool(
    'search_catalog',
    "Search and filter the object database (~45,000 objects: NGC/IC/Messier/Caldwell, Sharpless, LBN/LDN, Barnard, vdB, Cederblad, RCW, planetary nebulae, supernova remnants, open/globular clusters, RC3 galaxies, Arp, Hickson, Abell clusters, bright stars with IAU names). Use it to find candidates plan_targets does not rank (dark nebulae, faint Sharpless regions, a constellation's galaxies, what is up right now). Each result has its altitude now, peak altitude, hours above min_altitude and best time tonight.",
    {
      query: z.string().optional().describe('name or designation, substring match ("veil", "sh2-1", "arp")'),
      types: z
        .array(z.string())
        .optional()
        .describe('groups: galaxy, galaxy_cluster, nebula, emission, planetary, cluster, globular, open_cluster, supernova_remnant, reflection, dark, star; or type codes (G, HII, RfN, DrkN, PN, OCl, GCl, SNR…)'),
      constellation: z.string().optional().describe('IAU abbreviation, e.g. Cyg'),
      catalog: z.string().optional().describe('messier, caldwell, or a source: openngc, sh2, lbn, ldn, barnard, vdb, ced, rcw, pn, green, dias, harris, rc3, arp, hcg, aco, bsc, iau'),
      max_magnitude: z.number().optional(),
      min_size_arcmin: z.number().optional(),
      max_size_arcmin: z.number().optional(),
      min_fov_percent: z.number().min(0).max(100).optional().describe('only objects whose major axis covers at least this percent of the tele frame width (e.g. 25 = spans a quarter of the frame)'),
      named: z.boolean().optional().describe('only objects with a common name'),
      up: z.enum(['now', 'tonight']).optional().describe('now: above min_altitude now; tonight: at least min_hours above it during darkness'),
      min_altitude: z.number().min(-90).max(90).optional(),
      min_hours: z.number().optional().describe('with up=tonight; default 1'),
      sort: z.enum(['relevance', 'name', 'mag', 'size', 'altitude', 'hours', 'transit', 'ra']).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('default 25'),
      offset: z.number().int().min(0).optional(),
    },
    async (a) =>
      text(
        queryCatalog(
          {
            q: a.query,
            types: a.types,
            constellation: a.constellation,
            catalog: a.catalog,
            maxMag: a.max_magnitude,
            minSize: a.min_size_arcmin,
            maxSize: a.max_size_arcmin,
            minFovPercent: a.min_fov_percent,
            named: a.named,
            up: a.up,
            minAlt: a.min_altitude ?? config.observer.minAltitudeDeg,
            minHours: a.min_hours,
            sort: a.sort,
            offset: a.offset,
            limit: a.limit ?? 25,
          },
          site(),
          tz,
          { teleFovWidthArcmin: teleFov().h * 60 },
        ),
      ),
  );
}

function compactHour(h: weather.HourForecast) {
  return {
    t: h.local,
    score: h.score,
    rating: h.rating,
    dark: h.dark,
    cloud: `${h.cloudTotal}% (L${h.cloudLow}/M${h.cloudMid}/H${h.cloudHigh})`,
    rain: `${h.precipProbability}%${h.precipMm >= 0.1 ? ` (${h.precipMm.toFixed(1)} mm)` : ''}`,
    wind: `${Math.round(h.windKmh)}/${Math.round(h.gustKmh)} km/h`,
    tempC: h.temperatureC,
    dewSpreadC: h.dewSpreadC,
    seeing: h.seeing,
    transparency: h.transparency,
    issues: h.issues.length ? h.issues : undefined,
  };
}

/**
 * Weather is cached and the last good forecast is kept when a refresh fails (see astro/weather.ts),
 * so the numbers can be minutes or hours old. Say so: the agent must not report a cached forecast
 * as if it had just asked the providers.
 */
function forecastStaleness(f: { stale: boolean; ageMin: number; staleError?: string }) {
  if (!f.stale) return {};
  return {
    forecastWarning: `this forecast is ${f.ageMin} min old${f.staleError ? `; every refresh since has failed (${f.staleError})` : ''}. Say it is ${f.ageMin} min old rather than current, and call weather_forecast again before acting on it.`,
  };
}
