/** A compact reading of everything the controller can measure, for the duty samples. */
import { config } from '../../config.js';
import type { Dwarf } from '../../drivers/dwarf/device.js';
import type { StackSupervisor } from '../../drivers/dwarf/stack-supervisor.js';
import * as library from '../../library/transfer.js';
import * as processing from '../../processing/queue.js';
import * as dhttp from '../../drivers/dwarf/http.js';
import * as sky from '../../astro/sky.js';
import { clock, fmtMin } from './time.js';

export type MeasuredDevice = Pick<Dwarf, 'state' | 'isTracking' | 'requireLocation'>;

const FINISHED = new Set(['done', 'failed', 'cancelled']);

function timeLine(dwarf: MeasuredDevice, now: number): string {
  const tz = config.observer.timezone;
  try {
    const loc = dwarf.requireLocation();
    const site = { lat: loc.lat, lon: loc.lon, elev: loc.elev };
    const at = new Date(now);
    const w = sky.nightWindow(site, at);
    const sun = sky.bodyAlt(site, 'Sun', at);
    const dawn = w.astroDawn ? w.astroDawn.getTime() : null;
    return `- time ${clock(now)}; Sun altitude ${sun.toFixed(0)}°${sun < -18 ? ' (dark)' : ''}; astronomical dawn ${sky.fmtTime(w.astroDawn, tz) ?? '?'}${dawn && dawn > now ? ` (in ${fmtMin(dawn - now)})` : ''}`;
  } catch {
    return `- time ${clock(now)}`;
  }
}

function telescopeLines(dwarf: MeasuredDevice): string[] {
  const d = dwarf.state;
  if (d.released) return ['- telescope: RELEASED by the user (Disconnect in the web UI); nothing can be sent until they press Connect'];
  if (d.link?.state === 'unresponsive') return [`- telescope: NOT RESPONDING — ${d.link.detail}`];
  if (d.link?.state === 'contended') return [`- telescope: TAKEN BY ANOTHER CLIENT — ${d.link.detail}`];
  if (!d.connected) return [`- telescope: NOT CONNECTED${d.link?.detail ? ` (${d.link.detail})` : ''}`];
  const m = d.motors;
  const tracking = dwarf.isTracking();
  const motors = m.homed ? `rotation ${m.rotationDeg}°, pitch ${m.pitchDeg}°` : tracking ? 'no reference (normal while tracking)' : 'NO REFERENCE (not tracking: motors_home before moving them)';
  const out = [
    `- telescope: connected; battery ${d.battery ?? '?'}%${d.charging ? ' (charging)' : ''}; mode ${d.shootingMode?.name ?? '?'}; ${tracking ? 'tracking' : 'not tracking'}; motors ${motors}; SD ${d.storage ? `${d.storage.availableGB.toFixed(1)} GB free` : '?'}; sensor ${d.cmosTempC?.tele ?? '?'} °C`,
  ];
  const h = dhttp.apiHealth();
  if (h.cameraService !== 'ok') out.push(`- camera service: ${h.cameraService} (${h.consecutiveTimeouts} timeouts in a row, ${h.timingOutForMin} min)`);
  return out;
}

function stackLines(dwarf: MeasuredDevice, now: number, supervisor?: StackSupervisor): string[] {
  const d = dwarf.state;
  const out: string[] = [];
  for (const cam of ['tele', 'wide'] as const) {
    const s = d.stacking[cam];
    if (s.state === 'running') {
      const rej = (s.currentCount ?? 0) - (s.stackedCount ?? 0);
      const h = s.health;
      const recent = h && h.windowTaken ? ` — last ${h.windowTaken} frames: ${h.windowTaken - h.windowStacked} REJECTED` : '';
      const verdict = !h ? '' : h.verdict === 'rejecting' ? ' — COLLECTING NOTHING (every recent frame rejected)' : h.verdict === 'stalled' ? ' — STALLED (no frames)' : h.verdict === 'degraded' ? ' — some frames rejected' : '';
      const alarm = supervisor?.alarm(cam);
      const stopAt = alarm?.stopAt ? `; Astrocontroller stops it at ${clock(alarm.stopAt)} unless frames stack again` : '';
      const lastFrame = h?.lastFrameAt ? `${Math.round((now - h.lastFrameAt) / 1000)} s ago` : 'none yet';
      out.push(
        `- ${cam} stacking: running${s.target ? ` on ${s.target}` : ''}, ${s.stackedCount ?? 0} stacked of ${s.currentCount ?? 0} taken (${rej} rejected${recent})${s.totalCount ? ` (target ${s.totalCount})` : ''}${h?.frameIntervalS ? `, a frame every ${h.frameIntervalS} s` : ''}, last frame ${lastFrame}${verdict}${stopAt}`,
      );
    } else if (cam === 'tele') {
      out.push(`- tele stacking: ${s.state}${s.stoppedAt ? ` since ${clock(s.stoppedAt)}` : ''}`);
    }
  }
  return out;
}

function backgroundLines(dwarf: MeasuredDevice, now: number): string[] {
  const d = dwarf.state;
  const out: string[] = [];
  const dc = d.darkCapture;
  if (dc?.state === 'running') out.push(`- dark capture: running (${dc.exposureS} s × ${dc.frames}, about ${dc.expectedEndAt ? fmtMin(Math.max(0, dc.expectedEndAt - now)) : '?'} left)`);
  if (d.ndLock) out.push('- ND filter fitted: motion locked');
  const jobs = library.listJobs().filter((j) => j.status === 'running' || j.status === 'queued');
  if (jobs.length) out.push(`- transfers: ${jobs.map((j) => `${j.description} ${j.status}${j.progress ? ` ${j.progress.filesDone}/${j.progress.filesTotal} files` : ''}`).join('; ')}`);
  const proc = processing.listItems(10).filter((i) => !FINISHED.has(i.state));
  if (proc.length) out.push(`- processing: ${proc.map((i) => `${i.target} ${i.state}${i.studio ? ` ${Math.round(i.studio.progress * 100)}% ${i.studio.message ?? ''}` : ''}`).join('; ')}`);
  return out;
}

export function measurements(dwarf: MeasuredDevice, now: number, supervisor?: StackSupervisor): string[] {
  return [timeLine(dwarf, now), ...telescopeLines(dwarf), ...stackLines(dwarf, now, supervisor), ...backgroundLines(dwarf, now)];
}
