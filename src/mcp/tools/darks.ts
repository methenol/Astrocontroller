/** The dark-frame library: an ND session (lock, masters, unlock). */
import { z } from 'zod';
import { errMsg } from '../../log.js';
import { round } from '../../drivers/dwarf/device.js';
import { listDir } from '../../drivers/dwarf/ftp.js';
import { exposureArgSeconds, text, type ToolContext, type ToolFn } from './common.js';

const DARK_DIR = '/Astronomy/CALI_FRAME/dark/cam_0';
const DEFAULT_FRAMES = 20;

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
    'Dark-frame library (tele camera). An ND session: the operator fits the magnetic ND filter over the lenses (they tilt the scope by hand) -> nd_fitted (locks every motion and light capture: moving or parking would knock the filter off) -> capture each master (runs in the background, ~frames x exposure + 1 min; you get an event when it is saved) -> the operator removes the filter -> nd_removed. Actions: list (masters on the scope, firmware codes, sensor temperature), nd_fitted, capture, status, stop, nd_removed. NEVER move, park or home the scope during an ND session.',
    {
      action: z.enum(['list', 'nd_fitted', 'capture', 'status', 'stop', 'nd_removed']),
      exposure_s: z.number().positive().optional(),
      gain: z.number().min(0).optional(),
      frames: z.number().int().min(5).max(20).optional().describe('frames stacked into the master (default 20, the firmware maximum)'),
      operator_confirmed: z.boolean().optional().describe('nd_fitted / nd_removed: the operator told you the ND filter is on / off'),
      nd_filter_confirmed: z.boolean().optional().describe('capture: same as calling nd_fitted first'),
    },
    async ({ action, exposure_s, gain, frames, operator_confirmed, nd_filter_confirmed }) => {
      switch (action) {
        case 'status':
          return text({ capture: capture(), ndLock: dwarf.state.ndLock ?? null, sensorNowC: dwarf.state.cmosTempC.tele });
        case 'stop':
          await dwarf.stopDarks();
          return text({ stopped: true, capture: capture() });
        case 'nd_fitted':
          if (operator_confirmed !== true) throw new Error('Only after the operator has said the ND filter is on: call again with operator_confirmed=true.');
          dwarf.setNdLock(true, 'operator confirmed the ND filter');
          return text('ND session started: motion, homing, GoTo, calibration, stacking and tracking are locked until nd_removed. Do not move or park the scope.');
        case 'nd_removed':
          if (operator_confirmed !== true) throw new Error('Only after the operator has said the ND filter is off: call again with operator_confirmed=true.');
          if (dwarf.state.darkCapture?.state === 'running') throw new Error('a dark capture is still running; wait for it (status) or stop it first');
          dwarf.setNdLock(false);
          return text('ND session ended, motion unlocked. The scope was tilted by hand, so its motor position is unknown: run motors_home before any pointing.');
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
          return text({ sensorNowC: dwarf.state.cmosTempC.tele, ndLock: dwarf.state.ndLock ?? null, capture: capture(), firmwareList, masterFiles });
        }
        case 'capture':
          break;
      }
      if (exposure_s === undefined || gain === undefined) throw new Error('exposure_s and gain are required. Nothing was captured.');
      if (!dwarf.state.ndLock && nd_filter_confirmed !== true) {
        throw new Error(
          'Ask the operator to fit the ND filter (no parking: they tilt the scope by hand), wait for their confirmation, then dark_frames action=nd_fitted operator_confirmed=true. Nothing was captured.',
        );
      }
      // refused before the lock and the mode switch: a refusal must leave the telescope as it was
      if (dwarf.state.darkCapture?.state === 'running') throw new Error('a dark capture is already running (dark_frames action=status). Nothing was captured.');
      dwarf.assertNoOperation('a dark capture');
      // the switch to DSO mode ends a stack on either camera
      for (const cam of ['tele', 'wide'] as const) dwarf.assertCameraFree(cam, 'a dark capture');
      const listed = await dwarf.darkFrameList();
      // the firmware addresses exposure and gain by its own index codes; its dark list pairs them with names
      // exposure names are "15" or "1/2" (parseFloat would read "1/2" as 1 s); within 1 %, so 1/1000 and 1/2000 stay apart
      const expHit = listed.find((d) => Math.abs(exposureArgSeconds(d.exposure) - exposure_s) <= exposure_s * 0.01);
      const gainHit = listed.find((d) => Math.abs(parseFloat(d.gain) - gain) < 0.01);
      if (!gainHit) {
        throw new Error(
          `no known gain code for gain ${gain}: the firmware's dark list only covers gains ${[...new Set(listed.map((d) => d.gain))].join(', ') || 'none'}. Capture a dark at that gain once with the DWARFLAB app, then this tool can repeat it.`,
        );
      }
      if (!expHit) {
        throw new Error(
          `no known exposure code for ${exposure_s} s: the firmware's dark list covers ${[...new Set(listed.map((d) => d.exposure))].join(', ') || 'none'}. Capture that exposure once with the DWARFLAB app, then this tool can repeat it.`,
        );
      }
      // the lock only once the request is known to be valid
      if (!dwarf.state.ndLock) dwarf.setNdLock(true, 'confirmed with the first capture');
      const n = frames ?? DEFAULT_FRAMES;
      await dwarf.ensureMode('DSO');
      await dwarf.captureDarks({ expIndex: expHit.expIndex, gainIndex: gainHit.gainIndex, binIndex: expHit.binIndex, frames: n, exposureS: exposure_s, gain });
      return text(
        `dark capture running in the background: ${exposure_s} s, gain ${gain}, ${expHit.bin || 'bin1'}, ${n} frames, ≈${Math.ceil((n * exposure_s) / 60) + 1} min, sensor ${dwarf.state.cmosTempC.tele ?? '?'} °C. The telescope never acknowledges this command; Astrocontroller detects the finished master when it appears in CALI_FRAME and wakes you with an event (dark master saved, or why it failed). End your turn now; on that event start the next master. The scope must not move until the operator has removed the ND filter.`,
      );
    },
  );
}
