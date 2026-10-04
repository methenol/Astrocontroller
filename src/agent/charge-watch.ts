/**
 * PROMPT_TRANSFER_ON_CHARGE: when the telescope is plugged in to charge (brought back inside at the
 * end of a night) and its SD card holds sessions that are not in the library yet, wake the agent
 * with the end-of-session routine: park, transfer (processing queues itself), shut down when the
 * transfers are done.
 *
 * Fires on the change not charging → charging (the last known value survives a dropped connection,
 * so carrying the scope inside and reconnecting counts). Never while it is imaging: a power bank
 * plugged in during a field session must not end it.
 */
import { config } from '../config.js';
import { logger, errMsg } from '../log.js';
import type { Dwarf } from '../dwarf/device.js';
import type { AgentBridge } from './omp.js';
import * as library from '../library/transfer.js';

const log = logger('charge');
const SETTLE_MS = 20000; // let a wobbly connector settle, and the state refresh
const COOLDOWN_MS = 30 * 60000;

export function watchCharging(dwarf: Dwarf, agent: AgentBridge): void {
  if (!config.agent.promptOnCharge) return;
  let last: boolean | undefined;
  let lastFired = 0;
  let timer: NodeJS.Timeout | null = null;
  dwarf.on('state', () => {
    const now = dwarf.state.charging;
    if (now === undefined || !dwarf.state.connected) return;
    const prev = last;
    last = now;
    if (prev === false && now === true && !timer) {
      timer = setTimeout(() => {
        timer = null;
        void check(dwarf, agent).then((fired) => {
          if (fired) lastFired = Date.now();
        });
      }, SETTLE_MS);
    }
  });

  async function check(d: Dwarf, a: AgentBridge): Promise<boolean> {
    if (!d.state.charging) return false;
    if (Date.now() - lastFired < COOLDOWN_MS) return false;
    const busy = d.isBusy();
    if (busy) {
      log.info(`plugged in to charge while ${busy}: not starting the end-of-session routine`);
      return false;
    }
    let pending: string[];
    try {
      pending = (await library.listDeviceSessions(true)).sessions.filter((s) => !s.transferred && (s.fitsCount ?? 0) > 0).map((s) => s.folder);
    } catch (e) {
      log.warn(`plugged in to charge, but listing the SD card failed: ${errMsg(e)}`);
      return false;
    }
    if (!pending.length) {
      log.info('plugged in to charge; every session is already in the library');
      return false;
    }
    const text = [
      '[Automatic event from Astrocontroller, not typed by the user]',
      `The telescope was just plugged in to charge (battery ${d.state.battery ?? '?'}%). The user enabled PROMPT_TRANSFER_ON_CHARGE, which means: run the end-of-session routine now, without asking.`,
      `Sessions on the SD card that are not in the library yet: ${pending.join(', ')}.`,
      '1. Park the scope: move_motors pitch_deg=2.5 (motors_home first if it is not homed).',
      '2. transfer_session for each of those sessions. Processing in AstroPhoto Studio queues itself after each transfer.',
      '3. Follow the transfers with jobs until all are done. If one fails, retry it once; if it fails again, do NOT shut down: report it and stop.',
      '4. Check processing_status that the sessions are queued or processing.',
      '5. Shut the telescope down: power action=shutdown (approved by this setting).',
      '6. Write a short summary: what was transferred, processing profile and ETA.',
    ].join('\n');
    try {
      a.note('info', `Telescope plugged in to charge: ${pending.length} session(s) to transfer, starting the end-of-session routine`);
      await a.prompt(text);
      log.info(`plugged in to charge: agent woken for ${pending.length} session(s)`);
      return true;
    } catch (e) {
      log.warn(`could not wake the agent: ${errMsg(e)}`);
      return false;
    }
  }
}
