/**
 * Target memory: what has already been shown, and what has already been photographed.
 *
 * Without this the Tonight tab proposes the same handful of bright objects every clear night,
 * because geometry repeats. Clear Night Coach keeps a log of what it suggested and what the
 * user actually captured and applies a decaying penalty to each (its `history.py`). The
 * controller has an advantage it never had: the library folder names *are* the capture record,
 * so a target's rest does not depend on the user ever telling the app they shot it.
 *
 * Parameters are deliberately gentler than the source engine's. It is a desktop planner for a
 * subscriber with a 600 mm scope and a long target list; this is a 135 mm smart scope whose
 * realistic shortlist is a few dozen objects, and a 60-point penalty for 60 days after a
 * capture would lock out the sky after a user's first three clear nights. A capture therefore
 * holds a target hard for two weeks and fades out over two months; an explicit snooze is
 * stronger, and "don't suggest this again" is permanent until lifted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { errMsg, logger } from '../log.js';
import { findObject } from './catalog.js';
import { captureLog } from '../library/sessions.js';

const log = logger('rest');

export type RestRole = 'hero' | 'shortlist' | 'shot' | 'snoozed' | 'done';

export interface RestRecord {
  name: string;
  /** local calendar date (YYYY-MM-DD) the rest is anchored on */
  date: string;
  role: RestRole;
}

/** [strongest penalty, days to full recovery]; a capture holds at full strength until `hold`. */
const ROLE: Record<RestRole, { penalty: number; recoveryDays: number; holdDays: number }> = {
  hero: { penalty: 10, recoveryDays: 14, holdDays: 0 },
  shortlist: { penalty: 6, recoveryDays: 14, holdDays: 0 },
  shot: { penalty: 25, recoveryDays: 60, holdDays: 14 },
  snoozed: { penalty: 40, recoveryDays: 60, holdDays: 30 },
  done: { penalty: 100, recoveryDays: 0, holdDays: 0 },
};

const restFile = () => path.join(config.paths.data, 'rest.json');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IMMEDIATE: readonly RestRole[] = ['shot', 'snoozed', 'done'];

/**
 * The rest log. A corrupt or missing file is an empty memory, never a failure: planning must
 * work with nothing remembered, and a bad line must not take the Tonight tab down.
 */
export function loadRest(): RestRecord[] {
  try {
    const data = JSON.parse(fs.readFileSync(restFile(), 'utf8'));
    if (!Array.isArray(data)) return [];
    // Keys are canonicalised on the way in, not trusted from the file: a log restored from a
    // backup or hand-edited with display names ("M 31" for the row the plan calls NGC 224) still
    // has to rest the same object the writers file it under.
    return data
      .filter((r): r is RestRecord => !!r && typeof r.name === 'string' && DATE.test(r.date) && typeof r.role === 'string' && r.role in ROLE)
      .map((r) => ({ ...r, name: targetKey(r.name) }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`ignoring unreadable ${restFile()}: ${errMsg(err)}`);
    return [];
  }
}

function saveRest(records: RestRecord[]): void {
  const file = restFile();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    log.error(`could not write ${file}: ${errMsg(err)}`);
  }
}

/**
 * The key a target's rest is filed under: its catalog id when the name resolves to a catalog
 * object (so a library folder called "C 33" and a plan row called "NGC 253" rest together),
 * otherwise the trimmed name as given.
 */
export function targetKey(name: string): string {
  const o = findObject(name);
  return (o ? o.id : name).trim().toLowerCase();
}

const daysSince = (date: string, today: string): number => {
  const then = Date.parse(`${date}T12:00:00Z`);
  const now = Date.parse(`${today}T12:00:00Z`);
  if (Number.isNaN(then) || Number.isNaN(now)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.round((now - then) / 86_400e3));
};

/** Fraction of a role's penalty still in force after `days` (a permanent role never decays). */
function decay(role: RestRole, days: number): number {
  const { recoveryDays, holdDays } = ROLE[role];
  if (recoveryDays <= 0) return 1;
  if (days <= holdDays) return 1;
  return Math.max(0, (recoveryDays - days) / (recoveryDays - holdDays));
}

/** Library captures as rest records: the folder name is the target, the stamp is the date. */
export function captureRecords(today: string): RestRecord[] {
  const out: RestRecord[] = [];
  for (const c of captureLog()) {
    const date = (c.startedAt ?? '').slice(0, 10);
    if (!DATE.test(date) || date > today) continue;
    out.push({ name: targetKey(c.target), date, role: 'shot' });
  }
  return out;
}

/**
 * The strongest live rest on a target, as a number of points to take off its plan score.
 * Rows from `today` only bite when the user asserted them (a capture, a snooze, a done flag):
 * re-running the plan tonight must not demote tonight's own hero out of the list.
 */
export function restPenalty(name: string, today: string, records: RestRecord[]): number {
  const key = targetKey(name);
  let pen = 0;
  for (const r of records) {
    if (r.name !== key) continue;
    const days = daysSince(r.date, today);
    if (days === 0 && !IMMEDIATE.includes(r.role)) continue;
    pen = Math.max(pen, ROLE[r.role].penalty * decay(r.role, days));
  }
  return Math.round(pen * 10) / 10;
}

export interface RestState {
  kind: RestRole;
  /** when the rest stops biting entirely (null for a permanent "don't suggest again") */
  until: string | null;
  daysAgo: number;
}

/** Why a target is being held back, in the terms the UI and the agent should say. */
export function restState(name: string, today: string, records: RestRecord[]): RestState | null {
  const key = targetKey(name);
  let best: { rec: RestRecord; live: number } | null = null;
  for (const r of records) {
    if (r.name !== key) continue;
    const live = ROLE[r.role].penalty * decay(r.role, daysSince(r.date, today));
    if (live > 0 && (!best || live > best.live)) best = { rec: r, live };
  }
  if (!best) return null;
  const { recoveryDays, holdDays } = ROLE[best.rec.role];
  const daysAgo = daysSince(best.rec.date, today);
  const until = recoveryDays <= 0 ? null : addDays(best.rec.date, Math.max(recoveryDays, holdDays + 1));
  return { kind: best.rec.role, until, daysAgo };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Put a target on the user's own rest list: `done` is permanent until cleared, `snoozed` rests it
 * for the strength of a capture and then decays. Re-setting a role replaces it.
 */
export function setRest(name: string, role: 'snoozed' | 'done', today: string): RestRecord[] {
  const key = targetKey(name);
  const kept = loadRest().filter((r) => !(r.name === key && r.role === role));
  kept.push({ name: key, date: today, role });
  saveRest(kept);
  return kept;
}

/**
 * Lift whatever the user asked for on a target. Logged captures are never touched — those are
 * facts about the library, not preferences, and re-shooting something is allowed regardless.
 */
export function liftRest(name: string): RestRecord[] {
  const key = targetKey(name);
  const kept = loadRest().filter((r) => !(r.name === key && (r.role === 'snoozed' || r.role === 'done')));
  saveRest(kept);
  return kept;
}

/**
 * Remember what a plan put in front of the user, so the next plan rotates. Idempotent per
 * night and role, so polling the Tonight tab does not stack penalties.
 */
export function recordShown(names: Array<{ name: string; role: 'hero' | 'shortlist' }>, today: string): void {
  const records = loadRest();
  const have = new Set(records.filter((r) => r.date === today && (r.role === 'hero' || r.role === 'shortlist')).map((r) => `${r.name}|${r.role}`));
  let changed = false;
  for (const n of names) {
    const key = targetKey(n.name);
    if (!key) continue; // no hero (every row gated) must not file a record under an empty name
    const id = `${key}|${n.role}`;
    if (have.has(id)) continue;
    have.add(id);
    records.push({ name: key, date: today, role: n.role });
    changed = true;
  }
  if (!changed) return;
  // keep the log bounded: two recovery windows of history is more than the model reads
  const floor = addDays(today, -90);
  saveRest(records.filter((r) => r.date >= floor || r.role === 'done'));
}
