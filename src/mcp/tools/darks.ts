/** The dark-frame library: list, capture (in the background), status, stop. */
import { z } from 'zod';
import { errMsg } from '../../log.js';
import { round } from '../../drivers/dwarf/device.js';
import { dwarfModel } from '../../drivers/dwarf/controller/model.js';
import { withAstroBusyRecovery } from './astro.js';
import { listDir } from '../../drivers/dwarf/ftp.js';
import { exposureArgSeconds, text, type ToolContext, type ToolFn } from './common.js';

const DARK_DIR = '/Astronomy/CALI_FRAME/dark/cam_0';
const DEFAULT_FRAMES = 20;

/**
 * The firmware's gain code (gainIndex) for a gain, from the DWARFLAB app's table, shared by the Dwarf 3
 * and the Dwarf mini (stevejcl/dwarf_python_api AllowedGainsD3; matches this Dwarf 3's dark list:
 * gain 40 = 12, 60 = 18): 0, 2, 5 are 0, 1, 2, then 0.3 per gain step of 10 from 10 = 3 up to 240 = 72.
 */
export function darkGainIndex(gain: number): number | null {
  const low: Record<number, number> = { 0: 0, 2: 1, 5: 2 };
  if (gain in low) return low[gain];
  return Number.isInteger(gain) && gain >= 10 && gain <= 240 && gain % 10 === 0 ? (gain / 10) * 3 : null;
}

export function registerDarkTools(tool: ToolFn, { dwarf }: ToolContext): void {
  const capture = () => {
    const d = dwarf.state.darkCapture;
    if (!d) return { state: 'none' };
    const now = Date.now();
    const end = d.finishedAt ?? now;
    return {
      ...d,
      elapsedMin: d.startedAt ? round((end - d.startedAt) / 60000, 1) : undefined,
      remainingMin: d.state === 'running' && d.expectedEndAt ? Math.max(0, round((d.expectedEndAt - now) / 60000, 1)) : undefined,
    };
  };

  tool(
    'dark_frames',
    'Dark-frame library (tele camera). Actions: list (masters on the scope, firmware codes, sensor temperature), capture (runs in the background, ~frames x exposure + 1 min; you get an event when the master is saved), status, stop. Dwarf mini (telescope_status.device.name DWARF_mini_…): it closes its own built-in dark filter for each capture, so capture whenever the scope is idle; the scope may stay where it is. Dwarf 3: it has no dark filter and the owner makes its darks in the DWARFLAB app: capture only when the owner asks and says the lens is covered.',
    {
      action: z.enum(['list', 'capture', 'status', 'stop']),
      exposure_s: z.number().positive().optional(),
      gain: z.number().min(0).optional(),
      frames: z.number().int().min(5).max(20).optional().describe('frames stacked into the master (default 20, the firmware maximum)'),
    },
    async ({ action, exposure_s, gain, frames }) => {
      switch (action) {
        case 'status':
          return text({ capture: capture(), sensorNowC: dwarf.state.cmosTempC.tele });
        case 'stop':
          await dwarf.stopDarks();
          return text({ stopped: true, capture: capture() });
        case 'list': {
          const firmwareList = await dwarf.darkFrameList().catch((e) => ({ error: errMsg(e) }));
          const files = await listDir(DARK_DIR).catch((e) => {
            return { error: errMsg(e) };
          });
          const masterFiles = Array.isArray(files)
            ? files
                .filter((f) => /\.fits$/i.test(f.name))
                .map((f) => ({
                  file: f.name,
                  exposureS: Number(f.name.match(/exp_([\d.]+)/)?.[1]),
                  gain: Number(f.name.match(/gain_(\d+)/)?.[1]),
                  tempC: Number(f.name.match(/_(-?\d+)C(?:_|\.)/)?.[1]),
                  stack: Number(f.name.match(/stack_(\d+)/)?.[1] ?? 1),
                }))
            : files;
          return text({ sensorNowC: dwarf.state.cmosTempC.tele, capture: capture(), firmwareList, masterFiles });
        }
        case 'capture':
          break;
      }
      if (exposure_s === undefined || gain === undefined) throw new Error('exposure_s and gain are required. Nothing was captured.');
      const ownFilter = dwarfModel(dwarf.state.device) === 'mini';
      // refused before the mode switch: a refusal must leave the telescope as it was
      if (dwarf.state.darkCapture?.state === 'running') throw new Error('a dark capture is already running (dark_frames action=status). Nothing was captured.');
      dwarf.assertNoOperation('a dark capture');
      // the switch to DSO mode ends a stack on either camera
      for (const cam of ['tele', 'wide'] as const) dwarf.assertCameraFree(cam, 'a dark capture');
      const listed = await dwarf.darkFrameList();
      // the firmware addresses exposure and gain by its own index codes; its dark list pairs them with names
      // exposure names are "15" or "1/2" (parseFloat would read "1/2" as 1 s); within 1 %, so 1/1000 and 1/2000 stay apart
      // the codes come from the dark list when it has them; else exposure from the camera's own parameter
      // codes and gain from the app's table (a new telescope has no darks yet: the Dwarf mini, 2026-11-21)
      const listedExp = listed.find((d) => Math.abs(exposureArgSeconds(d.exposure) - exposure_s) <= exposure_s * 0.01);
      const listedGain = listed.find((d) => Math.abs(parseFloat(d.gain) - gain) < 0.01);
      const expIndex = listedExp?.expIndex ?? (await dwarf.exposureCode('tele', exposure_s));
      const gainIndex = listedGain?.gainIndex ?? darkGainIndex(gain);
      if (gainIndex === null) throw new Error(`no gain code for gain ${gain}: darks take 0, 2, 5 or a multiple of 10 from 10 to 240. Nothing was captured.`);
      if (expIndex === null) throw new Error(`the tele camera has no ${exposure_s} s exposure (camera_settings lists them). Nothing was captured.`);
      const binIndex = listedExp?.binIndex ?? listed[0]?.binIndex ?? 0;
      const binName = listedExp?.bin || listed[0]?.bin || 'bin1';
      const n = frames ?? DEFAULT_FRAMES;
      await dwarf.ensureMode('DSO');
      // -11501 with nothing running is the stuck astro service (the Dwarf mini after a stack stop, 2026-11-21): recover, start again
      await withAstroBusyRecovery(dwarf, 'a dark capture', () => dwarf.captureDarks({ expIndex, gainIndex, binIndex, frames: n, exposureS: exposure_s, gain }));
      return text(
        `dark capture running in the background: ${exposure_s} s, gain ${gain}, ${binName}, ${n} frames, ≈${Math.ceil((n * exposure_s) / 60) + 1} min, sensor ${dwarf.state.cmosTempC.tele ?? '?'} °C. The telescope never acknowledges this command; Astrocontroller detects the finished master when it appears in CALI_FRAME and wakes you with an event (dark master saved, or why it failed). End your turn now; on that event start the next master.${ownFilter ? ' The Dwarf mini shoots it behind its own dark filter.' : ' Keep the lens covered until it is saved.'}`,
      );
    },
  );
}
