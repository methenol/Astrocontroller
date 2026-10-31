/**
 * The obstruction survey with a Seestar. The Dwarf's survey stitches wide frames into a panorama
 * from its motor model; a Seestar on an EQ wedge turns each frame by the field angle of where it
 * points, which only the sky can calibrate. So this survey judges the centre of the wide frame
 * only, where that turn does not matter: it slews (scope_goto, no plate solve) to each azimuth at
 * rising altitudes and asks whether the centre is sky or obstruction (media/horizon/mask.ts's own
 * evidence), stopping in each direction at the first clear sky. The obstruction top is taken half
 * way to that altitude, and the map is saved for the site like the Dwarf's.
 *
 * The sky reference is a frame at high altitude that must show stars (it is refused otherwise): a
 * survey under a closed roof or cloud would otherwise map everything as sky or everything as wall.
 */
import { errMsg, logger } from '../../log.js';
import * as sky from '../../astro/sky.js';
import { describeMask, newMaskId, saveMask, unknownSectors, type HorizonMask } from '../../astro/horizon.js';
import { analyze, crop, type FloatImage } from '../../media/images.js';
import { frameEvidence, skyLevelOf } from '../../media/horizon/mask.js';
import type { Seestar } from './device.js';
import type { SeestarMedia } from './web.js';
import { seestarImage } from './mcp-media.js';

const log = logger('horizon');

const AZ_STEP_DEG = 20;
const ALTITUDES = [8, 16, 25, 35, 50];
const ANCHOR_ALT = 70;
/** the share of the frame, around its centre, that is judged */
const CENTRE = 0.2;
/** mean evidence above this is an obstruction (+1 obstruction … −1 sky) */
const OBSTRUCTION_EVIDENCE = 0.2;
/** stars the anchor frame needs to count as clear sky */
const ANCHOR_MIN_STARS = 15;
const MARGIN_DEG = 1;
const SUN_DOWN_DEG = -12;
const DEADLINE_MS = 45 * 60_000;

export interface SeestarSurveyState {
  running: boolean;
  phase: string;
  startedAt: number;
  finishedAt?: number;
  index?: number;
  total?: number;
  message?: string;
  error?: string;
  maskId?: string;
}

export interface SurveyOutcome {
  mask: HorizonMask;
  summary: string;
  notes: string[];
}

const centreOf = (img: FloatImage) => crop(img, { x: 0.5 - CENTRE / 2, y: 0.5 - CENTRE / 2, width: CENTRE, height: CENTRE });

export class SeestarSurvey {
  private stopping = false;
  private running = false;

  constructor(
    private readonly scope: Seestar,
    private readonly media: SeestarMedia,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  private publish(s: SeestarSurveyState): void {
    this.scope.state.horizonSurvey = s;
    this.scope.changed();
  }

  assertAllowed(): void {
    if (this.running) throw new Error('the obstruction survey is already running');
    const busy = this.scope.isBusy();
    if (busy) throw new Error(`refused: ${busy} is running`);
    if (!this.scope.state.connected) throw new Error('the Seestar is not connected');
    const site = this.scope.requireLocation();
    const sun = sky.bodyAlt(site, 'Sun');
    if (sun > SUN_DOWN_DEG) throw new Error(`the obstruction survey needs a dark sky (the Sun is at ${sun.toFixed(0)}°; it must be below ${SUN_DOWN_DEG}°)`);
  }

  stop(): boolean {
    if (!this.running) return false;
    this.stopping = true;
    return true;
  }

  async run(): Promise<SurveyOutcome> {
    this.assertAllowed();
    this.running = true;
    this.stopping = false;
    const startedAt = Date.now();
    const deadline = startedAt + DEADLINE_MS;
    const notes: string[] = [];
    const site = this.scope.requireLocation();
    let phase = 'anchor';
    const progress = (patch: Partial<SeestarSurveyState> = {}) => this.publish({ running: true, phase, startedAt, ...patch });
    const checkStop = () => {
      if (this.stopping) throw new Error('the obstruction survey was stopped');
    };
    try {
      // ---- the sky reference: high up, where the sky is open, with stars in it
      progress({ message: `pointing up at ${ANCHOR_ALT}° for the sky reference` });
      const azNow = this.scope.state.mount.azDeg ?? 180;
      await this.scope.slewAltAz(azNow, ANCHOR_ALT);
      const anchorImg = (await seestarImage('wide', this.scope, this.media)).img;
      const stars = analyze(anchorImg).stars.count;
      if (stars < ANCHOR_MIN_STARS) {
        throw new Error(`the sky reference at ${ANCHOR_ALT}° shows ${stars} stars (at least ${ANCHOR_MIN_STARS} are needed): the roof is closed, it is cloudy, or the wide camera is not seeing the sky. Nothing was mapped.`);
      }
      const skyLevel = skyLevelOf(centreOf(anchorImg));
      log.info(`survey sky reference: ${stars} stars, level ${(skyLevel * 255).toFixed(1)}/255`);

      // ---- each direction, upward until the centre is sky
      phase = 'sweep';
      const azimuths: number[] = [];
      for (let az = 0; az < 360; az += AZ_STEP_DEG) azimuths.push(az);
      const top = new Map<number, { alt: number | null; capped: boolean }>();
      let frames = 1;
      for (const [i, az] of azimuths.entries()) {
        checkStop();
        if (Date.now() > deadline) {
          notes.push(`time limit: ${i} of ${azimuths.length} directions surveyed`);
          break;
        }
        progress({ index: i + 1, total: azimuths.length, message: `azimuth ${az}° (${i + 1} of ${azimuths.length})` });
        let lastBlocked: number | null = null;
        let clearAt: number | null = null;
        for (const alt of ALTITUDES) {
          checkStop();
          try {
            await this.scope.slewAltAz(az, alt);
          } catch (e) {
            notes.push(`az ${az}° alt ${alt}°: ${errMsg(e)}`);
            continue;
          }
          const img = (await seestarImage('wide', this.scope, this.media)).img;
          frames++;
          const ev = frameEvidence(centreOf(img), skyLevel);
          const mean = ev.data.reduce((a, b) => a + b, 0) / ev.data.length;
          if (mean > OBSTRUCTION_EVIDENCE) lastBlocked = alt;
          else {
            clearAt = alt;
            break;
          }
        }
        // the top lies between the last blocked altitude and the first clear one
        const alt = lastBlocked === null ? 0 : clearAt === null ? lastBlocked : (lastBlocked + clearAt) / 2;
        top.set(az, { alt, capped: lastBlocked !== null && clearAt === null });
      }
      if (!top.size) throw new Error(`no direction could be surveyed. ${notes.join('; ')}`);

      // ---- the mask: each 1° bin from the nearest surveyed direction
      phase = 'build';
      progress({ message: 'building the horizon mask' });
      const profile: Array<number | null> = [];
      const capped: number[] = [];
      for (let k = 0; k < 360; k++) {
        const near = Math.round((k + 0.5) / AZ_STEP_DEG) * AZ_STEP_DEG % 360;
        const t = top.get(near);
        if (!t || t.alt === null) {
          profile.push(null);
          continue;
        }
        profile.push(t.alt > 0 ? Math.min(90, t.alt + MARGIN_DEG) : 0);
        if (t.capped) capped.push(k);
      }
      if (capped.length) notes.push(`${capped.length} directions are blocked up to ${ALTITUDES[ALTITUDES.length - 1]}°, the highest altitude probed: taller than the mask says there`);
      const mask: HorizonMask = {
        id: newMaskId(),
        site: { lat: site.lat, lon: site.lon },
        createdAt: new Date().toISOString(),
        source: 'survey',
        profile,
        capped,
        survey: { mode: 'seestar-centre', frames, pointingResidualDeg: 0, marginDeg: MARGIN_DEG, panorama: '', notes },
      };
      const unknown = unknownSectors(mask);
      if (unknown.length) notes.push(`not observed (no limit applied there): ${unknown.join(', ')}`);
      saveMask(mask);
      const summary = describeMask(mask);
      this.publish({ running: false, phase: 'done', startedAt, finishedAt: Date.now(), message: summary, maskId: mask.id });
      return { mask, summary, notes };
    } catch (e) {
      this.publish({ running: false, phase, startedAt, finishedAt: Date.now(), error: errMsg(e) });
      throw e;
    } finally {
      this.running = false;
      this.stopping = false;
    }
  }
}
