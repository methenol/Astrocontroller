/** Night planning: sky and weather, a clear-sky check, target ranking and the object catalog. */
import { z } from 'zod';
import { config } from '../../config.js';
import { errMsg } from '../../log.js';
import { round } from '../../dwarf/device.js';
import { analyze, autoStretch, loadImage, toJpeg, type FloatImage } from '../../media/images.js';
import { describe as describeObject, findObject, gotoLabel, searchObjects } from '../../astro/catalog.js';
import { queryCatalog } from '../../astro/catalog-search.js';
import { planNight } from '../../astro/planner.js';
import * as sky from '../../astro/sky.js';
import * as weather from '../../astro/weather.js';
import { capturedLine, localTime, saveCapture, text, withImage, type ToolContext, type ToolFn } from './common.js';

const PLANETS = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'] as const;
const DEFAULT_TELE_FOV = { h: 2.95, v: 1.66 };
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
  if (o.sunAltDeg !== undefined && o.sunAltDeg > TWILIGHT_SUN_ALT && o.stars < CLEAR_STARS) return `unknown: the Sun is ${o.sunAltDeg > 0 ? 'up' : 'only just set'} (${Math.round(o.sunAltDeg)}°), too bright for stars; check after dusk`;
  if (o.background > BRIGHT_BACKGROUND) return 'too bright (twilight, Moon glow or a lit cloud deck)';
  if (o.stars >= CLEAR_STARS) return 'clear';
  if (o.stars >= PARTLY_CLEAR_STARS) return 'partly clear / thin cloud';
  return 'cloudy (no usable stars)';
}

export function registerPlanningTools(tool: ToolFn, { dwarf, hub }: ToolContext): void {
  const tz = config.observer.timezone;
  const site = () => dwarf.requireLocation();
  const teleFov = () => dwarf.state.fov.tele ?? DEFAULT_TELE_FOV;

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
      const altitudeDeg = pos?.pitchDeg !== undefined ? pos.pitchDeg - HORIZON_PITCH_DEG : undefined;
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
        notes: pos?.pitchDeg !== undefined && pos.pitchDeg < LOW_POINTING_PITCH_DEG ? 'pointing is low (< 30° altitude): trees, houses and haze will reduce the star count' : undefined,
      };
      return withImage(jpeg, JSON.stringify(summary, null, 1));
    },
  );

  tool(
    'plan_targets',
    "Rank deep-sky targets for tonight (or a given window) for the Dwarf 3 tele camera. Each target gets a visibility score (hours above the minimum altitude, peak altitude, size vs field of view, brightness, Moon separation), scaled by weatherAlignment: how good the hourly forecast (clouds, rain, wind, dew, seeing, transparency) is during that target's own best hours, weighted toward its peak. The best targets are those whose optimal time coincides with good weather. bestTime is the target's own peak; skyAtBest is the forecast then; clearHours are its forecast-weighted hours up. Use before choosing what to image, and schedule each target around its bestTime.",
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
    },
    async (a) => {
      const s = site();
      const fov = teleFov();
      const observability = (await weather.observabilityAt(s, tz)) ?? undefined;
      return text(
        planNight(s, {
          observability,
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
        }),
      );
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
