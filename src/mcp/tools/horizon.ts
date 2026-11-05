/** The site's obstruction map: survey it with the scope, look at it, clear it, import or export it. */
import { evidencePathOf, listSurveys, resolveSurvey, surveyIdOf } from '../../media/horizon/solve.js';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../../config.js';
import { clearMasks, describeMask, maskFor, newMaskId, parseHorizonText, saveMask, toHorizonText, unknownSectors, type HorizonMask } from '../../astro/horizon.js';
import { stopSurvey, surveyObstructions, surveyRunning } from '../../media/horizon/survey.js';
import { text, withImage, type ToolContext, type ToolFn } from './common.js';

/** The profile every 10°, for reading at a glance ("az:alt"; ? = not observed). */
export function profileGlance(m: HorizonMask): string {
  const out: string[] = [];
  for (let k = 0; k < 360; k += 10) {
    let hi: number | null = null;
    for (let j = k; j < k + 10; j++) if (m.profile[j] !== null) hi = Math.max(hi ?? 0, m.profile[j]!);
    out.push(`${k}:${hi === null ? '?' : Math.round(hi)}`);
  }
  return out.join(' ');
}

function maskReport(m: HorizonMask) {
  return {
    summary: describeMask(m),
    id: m.id,
    createdAt: m.createdAt,
    source: m.source,
    highestPer10Deg: profileGlance(m),
    notObserved: unknownSectors(m),
    cappedDirections: m.capped?.length ?? 0,
    survey: m.survey,
    panorama: m.survey?.panorama ? `captures/${m.survey.panorama}` : undefined,
  };
}

function panoramaOf(m: HorizonMask): Buffer | undefined {
  if (!m.survey?.panorama) return undefined;
  try {
    return fs.readFileSync(path.join(config.paths.captures, m.survey.panorama));
  } catch {
    return undefined;
  }
}

/** What map_obstructions needs from a driver: the site, and its survey. */
export interface SurveyPort {
  site(): { lat: number; lon: number };
  /** run the survey to its end; the panorama when the driver makes one */
  run(o: { calibrate?: boolean; exposureS?: number }): Promise<{ mask: HorizonMask; notes: string[]; panoramaJpeg?: Buffer }>;
  stop(): Promise<boolean>;
  running(): boolean;
  progress(): unknown;
  /** how the survey works, for the tool's description */
  how: string;
}

export function registerHorizonTools(tool: ToolFn, { dwarf, hub }: ToolContext): void {
  registerMapObstructions(tool, {
    site: () => dwarf.requireLocation(),
    run: (o) => surveyObstructions({ dwarf, hub }, o),
    stop: () => stopSurvey(dwarf),
    running: () => surveyRunning(dwarf),
    progress: () => dwarf.state.horizonSurvey,
    how: "GoTos to two or three sky positions fix the pointing by the telescope's own plate solving (calibrating if a GoTo needs it), then the scope pans all round at ~10° and ~32° altitude (higher where something runs off the top) taking wide stills at night settings, and the map is built and saved for this site; night only, ~15–25 min, moves the scope (point it at clear sky first; it ends pointing at the first anchor, and the next GoTo should be one-click since the motor resets can clear the calibration)",
  });
}

export function registerMapObstructions(tool: ToolFn, port: SurveyPort): void {
  const site = () => port.site();

  tool(
    'map_obstructions',
    `The site's obstruction map (horizon mask): how high trees, houses and roofs reach in each compass direction, in true azimuth (0 = N, 90 = E) and altitude, so plan_targets only offers what is actually visible from where the scope stands. action=run surveys it: ${port.how}. action=status (default) says whether this site has a map and what it holds; show adds the panorama with the skyline (red) and the limit the planner uses (yellow); clear forgets this site's map (the planner then uses the minimum altitude alone); import takes 'azimuth altitude' lines (N.I.N.A./Stellarium/Clear Night Coach/Telescopius horizon files); export gives them; stop ends a running survey; resolve solves the newest kept survey (or survey_id) again from its saved frames with the current judgement, without moving the telescope (surveys keep their frames from 2026-11-04 on); evidence shows what the last solve judged (red obstruction, blue sky, green verified stars) to find a missed tree or a false block. Maps are kept per site (300 m): a new location needs its own.`,
    {
      action: z.enum(['status', 'run', 'show', 'evidence', 'resolve', 'clear', 'import', 'export', 'stop']).optional().describe('default status'),
      survey_id: z.string().regex(/^[\w.-]+$/).optional().describe('resolve: the kept survey to solve again (default: the one this site\'s map came from, else the newest)'),
      calibrate: z.boolean().optional().describe('run: plate-solve calibrate first at the current pointing (otherwise only if a GoTo needs it)'),
      exposure_s: z.number().min(0.3).max(15).optional().describe('run: still exposure (default 2.5 s, rescaled once if the sky reads far too dark or bright)'),
      horizon_text: z.string().optional().describe('import: "azimuth altitude" lines, # comments'),
    },
    async (a) => {
      const action = a.action ?? 'status';
      switch (action) {
        case 'run': {
          const r = await port.run({ calibrate: a.calibrate, exposureS: a.exposure_s });
          return withImage(r.panoramaJpeg, JSON.stringify({ result: 'obstruction map saved for this site; plan_targets uses it from now on', ...maskReport(r.mask), notes: r.notes }, null, 1));
        }
        case 'stop':
          return text((await port.stop()) ? 'stopping the obstruction survey' : 'no obstruction survey is running');
        case 'resolve': {
          const here = maskFor(site());
          const id = a.survey_id ?? (here ? surveyIdOf(here) : null) ?? listSurveys()[0]?.id;
          if (!id) throw new Error('no survey has kept its frames yet (surveys from 2026-11-04 on do): run one');
          const r = await resolveSurvey(id);
          return withImage(r.panoramaJpeg, JSON.stringify({ result: `solved again from survey ${id}'s kept frames; plan_targets uses this map from now on`, ...maskReport(r.mask), notes: r.notes }, null, 1));
        }
        case 'evidence': {
          const m = maskFor(site());
          const p = m ? evidencePathOf(m) : null;
          if (!m || !p) return text('this site\'s map has no evidence picture (only surveys from 2026-11-04 on make one)');
          return withImage(fs.readFileSync(path.join(config.paths.captures, p)), JSON.stringify({ legend: 'north at the left edge; red = judged obstruction, blue = judged sky, green = verified stars; red line = skyline, yellow = the planner\'s limit', ...maskReport(m) }, null, 1));
        }
        case 'clear': {
          const n = clearMasks(site());
          return text(n ? `cleared ${n} obstruction map(s) for this site: the planner now uses the minimum altitude alone` : 'this site had no obstruction map');
        }
        case 'import': {
          if (!a.horizon_text) throw new Error('import needs horizon_text ("azimuth altitude" lines)');
          const s = site();
          const mask = saveMask({ id: newMaskId(), site: { lat: s.lat, lon: s.lon }, createdAt: new Date().toISOString(), source: 'import', profile: parseHorizonText(a.horizon_text) });
          return text({ result: 'imported as this site\'s obstruction map', ...maskReport(mask) });
        }
        case 'export': {
          const m = maskFor(site());
          return text(m ? toHorizonText(m) : 'this site has no obstruction map');
        }
        default: {
          const m = maskFor(site());
          const progress = port.progress();
          const body = {
            map: m ? maskReport(m) : 'none for this site: plan_targets uses the minimum altitude alone (run action=run at night to map it)',
            survey: port.running() ? progress : progress ? { last: progress } : undefined,
          };
          if (action === 'show' && m) return withImage(panoramaOf(m), JSON.stringify(body, null, 1));
          return text(body);
        }
      }
    },
  );
}
