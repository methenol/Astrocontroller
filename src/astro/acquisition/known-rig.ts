/**
 * The rig as it last described itself, kept across restarts and disconnects.
 *
 * A scope says what it is (model, serial, optics, chip, wheel) only while it is connected. Without
 * that, pickDevice falls back to the driver's first spec and the device key loses the serial, so
 * every measurement filed under the real device (the quality engine's cohorts, the focus offsets,
 * the sensor profile, the sub lengths) is out of sight: after a restart before dusk a Seestar S50
 * Pro was planned as an S30 Pro and asked for cohorts and a focus calibration it already had
 * (2026-11-23). What the scope reports wins; what it does not report now is filled in from here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import { writeFileAtomic } from '../../util/fs.js';
import type { LiveFacts } from './devices.js';

const log = logger('known-rig');

type Facts = Partial<LiveFacts> & { driver: LiveFacts['driver'] };

/** What describes the rig itself, not the moment (gain, darks): worth carrying over. */
const KEPT = ['model', 'serial', 'focalLengthMm', 'apertureMm', 'pixelUm', 'chip', 'eqMode', 'gainRange', 'gainOptions', 'exposureOptionsS', 'moreExposure', 'filterSlots'] as const;

const file = () => path.join(config.paths.data, 'known-rig.json');
let memo: { file: string; facts: Facts | null } | null = null;

function load(): Facts | null {
  const f = file();
  if (memo?.file === f) return memo.facts;
  let facts: Facts | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (raw && (raw.driver === 'seestar' || raw.driver === 'dwarf')) facts = raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`ignoring unreadable ${f}: ${errMsg(err)}`);
  }
  memo = { file: f, facts };
  return facts;
}

function save(facts: Facts): void {
  const f = file();
  try {
    writeFileAtomic(f, `${JSON.stringify(facts, null, 2)}\n`);
    memo = { file: f, facts };
  } catch (err) {
    log.warn(`could not write ${f}: ${errMsg(err)}`);
  }
}

/**
 * The facts the scope gives now, with the rig's identity filled in from when it last gave it; a scope
 * that names itself updates the record. A record of another driver, or of another unit (a serial
 * that differs), is not used.
 */
export function withKnownRig(live: Facts): Facts {
  const known = load();
  if (live.model || live.serial) {
    const keep: Facts = { ...(known?.driver === live.driver && (!known.serial || !live.serial || known.serial === live.serial) ? known : {}), driver: live.driver };
    for (const k of KEPT) if (live[k] !== undefined) (keep as Record<string, unknown>)[k] = live[k];
    if (JSON.stringify(keep) !== JSON.stringify(known)) save(keep);
    return { ...keep, ...defined(live) };
  }
  if (!known || known.driver !== live.driver) return live;
  return { ...known, ...defined(live) };
}

const defined = (f: Facts): Facts => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as Facts;

/** For tests: forget the memo. */
export function resetKnownRig(): void {
  memo = null;
}
