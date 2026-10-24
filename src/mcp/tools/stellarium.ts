/** Showing the owner a target on the web UI's Stellarium tab. */
import { z } from 'zod';
import { config } from '../../config.js';
import * as sky from '../../astro/sky.js';
import { findObject, gotoLabel } from '../../astro/catalog.js';
import { text, toolEvents, type ToolFn } from './common.js';

export function registerStellariumTools(tool: ToolFn): void {
  tool(
    'show_in_stellarium',
    "Show the owner a target on the web UI's Stellarium planetarium (the Stellarium tab, observer at the site in .env): it opens the tab, selects and centres the target, at an optional time and field of view. For explaining where something is, or what the sky will look like; nothing on the telescope moves. Give a name (catalog object, planet, star) or ra_hours + dec_deg (J2000).",
    {
      name: z.string().trim().min(1).max(120).optional(),
      ra_hours: z.number().min(0).lt(24).optional(),
      dec_deg: z.number().min(-90).max(90).optional(),
      time: z.string().optional().describe(`when to show the sky: YYYY-MM-DDTHH:MM in the observer's zone (${config.observer.timezone}) or ISO with a zone; default now`),
      fov_deg: z.number().min(0.1).max(180).optional().describe('field of view in degrees (default: framed to the target)'),
    },
    async ({ name, ra_hours, dec_deg, time, fov_deg }) => {
      if ((ra_hours === undefined) !== (dec_deg === undefined)) throw new Error('give both ra_hours and dec_deg, or a name');
      if (!name && ra_hours === undefined) throw new Error('give a target name or ra_hours + dec_deg');
      const at = time ? sky.parseLocal(time, config.observer.timezone) : undefined;
      // A catalog name goes with its position, so the map finds it even when the engine's own catalog does not.
      const o = name && ra_hours === undefined && !sky.bodyByName(name) ? findObject(name) : null;
      const target = {
        name: o ? gotoLabel(o) : name,
        raHours: o ? o.raHours : ra_hours,
        decDeg: o ? o.decDeg : dec_deg,
        time: at?.toISOString(),
        fovDeg: fov_deg,
      };
      toolEvents.emit('stellarium', { ...target, at: Date.now() });
      const where = target.name ?? `RA ${sky.hoursToHms(target.raHours!)} Dec ${sky.degToDms(target.decDeg!)}`;
      return text(`Shown on the Stellarium tab: ${where}${at ? ` at ${sky.fmtTime(at, config.observer.timezone)}` : ''}. It opens on every web UI that is connected.`);
    },
  );
}
