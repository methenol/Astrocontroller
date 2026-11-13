/**
 * Device profiles: one telescope each (a Dwarf, or a Seestar on the LAN or over ZWO Telescope
 * Network), with its own address, site, credentials and data folder. The hub (src/hub/main.ts) runs
 * every active profile as its own Astrocontroller process; this file is what a profile is, where the
 * list is kept, and the environment a profile's process is started with.
 *
 * Kept in <DATA_DIR>/profiles.json (mode 0600: it holds ZWO account passwords, like .env does).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { validHost } from '../config/host.js';
import { writeFileAtomic } from '../util/fs.js';
import { DRIVER_IDS, type DriverId } from '../drivers/types.js';
import { SETTINGS, settingProblems, type Setting } from '../config/settings.js';

/** Slot n: the child's web port is portBase + n, its ZWO tunnel ports are the device's + n*1000. */
export const MAX_SLOT = 33;
export const TUNNEL_SLOT_STRIDE = 1000;

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Environment variable names a profile may set for its own process. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

const validTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const Host = z
  .string()
  .trim()
  .refine((h) => h === '' || validHost(h), 'an IP address or host name');

const Location = z.object({
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  elevationM: z.number().min(-500).max(9000).default(0),
  timezone: z.string().trim().default('UTC').refine(validTimezone, 'an IANA time zone such as America/Chicago'),
});

const Seestar = z.object({
  /** over ZWO Telescope Network (the seestar-portfwd tunnel) rather than on the local network */
  zwo: z.boolean().default(false),
  user: z.string().trim().max(200).default(''),
  password: z.string().max(200).default(''),
  /** the telescope's serial, when the account holds several */
  serial: z.string().trim().max(64).default(''),
  country: z.string().trim().max(8).default('US'),
  /** Starfront Observatories' autonomous nights (zwo only) */
  starfront: z.boolean().default(false),
  /** the Starfront building the scope is in; 0 = unknown (any roof, confirmed by the telescope) */
  building: z.number().int().min(0).max(100).default(0),
});

export const ProfileSchema = z.object({
  id: z.string().regex(ID),
  name: z.string().trim().min(1).max(60),
  driver: z.enum(DRIVER_IDS),
  /** inactive: no process at all, so nothing ticks, nothing connects and the agent never wakes */
  active: z.boolean().default(false),
  slot: z.number().int().min(0).max(MAX_SLOT),
  /** the telescope's address ('' = the driver's default: 192.168.88.1 for the Dwarf, seestar.local) */
  host: Host.default(''),
  location: Location.default({ latitude: null, longitude: null, elevationM: 0, timezone: 'UTC' }),
  seestar: Seestar.default({ zwo: false, user: '', password: '', serial: '', country: 'US', starfront: false, building: 0 }),
  /** further variables for this profile's process (PLAN_BORTLE, PLAN_DEVICE, LLM_MODEL ...) */
  env: z.record(z.string(), z.string()).default({}),
  /** absolute; default <DATA_DIR>/profiles/<id> */
  dataDir: z.string().optional(),
  /** absolute; default <LIBRARY_DIR>/<id> */
  libraryDir: z.string().optional(),
  /** migrated from the single-telescope setup: its data, library and tunnel state stay where they were */
  legacy: z.boolean().optional(),
  createdAt: z.number().default(() => Date.now()),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** What the web UI sends to create or change a profile (the id and slot are the hub's). */
export const ProfileInput = z.object({
  name: z.string().trim().min(1, 'give the profile a name').max(60),
  driver: z.enum(DRIVER_IDS),
  host: Host.default(''),
  location: Location,
  seestar: Seestar.extend({
    /** blank on an edit = keep the saved password */
    password: z.string().max(200).optional(),
  }).optional(),
  env: z
    .record(z.string(), z.string())
    .default({})
    .refine((e) => Object.keys(e).every((k) => ENV_NAME.test(k)), 'variable names are A-Z, 0-9 and _')
    // a value the profile's process would refuse at start-up is refused here instead
    .superRefine((e, ctx) => {
      for (const message of settingProblems(e)) ctx.addIssue({ code: 'custom', message });
    }),
});
export type ProfileInput = z.infer<typeof ProfileInput>;

export interface HubPaths {
  /** the hub's own folder: profiles.json, and profiles/<id>/ for each profile's data */
  data: string;
  /** where each profile's library folder goes (<library>/<id>) */
  library: string;
}

export const profileDataDir = (p: Profile, paths: HubPaths): string => p.dataDir ?? path.join(paths.data, 'profiles', p.id);
export const profileLibraryDir = (p: Profile, paths: HubPaths): string => p.libraryDir ?? path.join(paths.library, p.id);

/** A profile as the web UI sees it: never the password, only whether one is saved. */
export function publicProfile(p: Profile, paths: HubPaths): Omit<Profile, 'seestar'> & { seestar: Omit<Profile['seestar'], 'password'> & { hasPassword: boolean }; dataPath: string; libraryPath: string } {
  const { password, ...seestar } = p.seestar;
  return { ...p, seestar: { ...seestar, hasPassword: password !== '' }, dataPath: profileDataDir(p, paths), libraryPath: profileLibraryDir(p, paths) };
}

/** A short, unique, URL-safe id from the name. */
export function slugFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'scope';
  let id = /^[a-z0-9]/.test(base) ? base : `p-${base}`;
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 28)}-${n}`;
  return id;
}

export class ProfileStore {
  private list: Profile[] = [];
  readonly file: string;

  constructor(readonly paths: HubPaths) {
    this.file = path.join(paths.data, 'profiles.json');
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  /** Read the saved list; a profile that does not parse is reported and skipped, never lost on disk until the next save. */
  load(onBad: (msg: string) => void = () => undefined): Profile[] {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') onBad(`${this.file} is unreadable: ${(e as Error).message}`);
      this.list = [];
      return this.all();
    }
    const items = Array.isArray((raw as { profiles?: unknown })?.profiles) ? (raw as { profiles: unknown[] }).profiles : [];
    this.list = [];
    for (const item of items) {
      const r = ProfileSchema.safeParse(item);
      if (r.success && !this.list.some((p) => p.id === r.data.id || p.slot === r.data.slot)) this.list.push(r.data);
      else onBad(`a saved profile was skipped: ${r.success ? 'duplicate id or slot' : (r.error.issues[0]?.message ?? 'invalid')}`);
    }
    return this.all();
  }

  save(): void {
    writeFileAtomic(this.file, JSON.stringify({ version: 1, profiles: this.list }, null, 2));
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* a filesystem without modes (a Windows bind mount) */
    }
  }

  all(): Profile[] {
    return this.list.map((p) => structuredClone(p));
  }

  get(id: string): Profile | undefined {
    const p = this.list.find((x) => x.id === id);
    return p ? structuredClone(p) : undefined;
  }

  /** The lowest free slot (slot 0 is kept for the migrated single-telescope setup). */
  private freeSlot(): number {
    const used = new Set(this.list.map((p) => p.slot));
    for (let s = 1; s <= MAX_SLOT; s++) if (!used.has(s)) return s;
    throw new Error(`at most ${MAX_SLOT} profiles`);
  }

  create(input: ProfileInput): Profile {
    const id = slugFor(input.name, new Set(this.list.map((p) => p.id)));
    const p = ProfileSchema.parse({ ...merge(undefined, input), id, slot: this.freeSlot(), active: false, createdAt: Date.now() });
    validate(p);
    this.list.push(p);
    this.save();
    return structuredClone(p);
  }

  /** Add a profile as is (the migration); its slot and id must be free. */
  adopt(p: Profile): Profile {
    if (this.list.some((x) => x.id === p.id || x.slot === p.slot)) throw new Error(`profile ${p.id} or slot ${p.slot} is taken`);
    this.list.push(ProfileSchema.parse(p));
    this.save();
    return structuredClone(p);
  }

  update(id: string, input: ProfileInput): Profile {
    const i = this.list.findIndex((p) => p.id === id);
    if (i < 0) throw new Error(`no profile ${id}`);
    const next = ProfileSchema.parse({ ...this.list[i], ...merge(this.list[i], input) });
    validate(next);
    this.list[i] = next;
    this.save();
    return structuredClone(next);
  }

  setActive(id: string, active: boolean): Profile {
    const p = this.list.find((x) => x.id === id);
    if (!p) throw new Error(`no profile ${id}`);
    if (active) validate(p);
    p.active = active;
    this.save();
    return structuredClone(p);
  }

  remove(id: string): Profile {
    const i = this.list.findIndex((p) => p.id === id);
    if (i < 0) throw new Error(`no profile ${id}`);
    const [p] = this.list.splice(i, 1);
    this.save();
    return p;
  }
}

/** The fields of an input over the saved profile; a blank password keeps the saved one. */
function merge(prev: Profile | undefined, input: ProfileInput): Omit<Profile, 'id' | 'slot' | 'active' | 'createdAt'> {
  const s = input.seestar;
  const seestar: Profile['seestar'] = {
    zwo: s?.zwo ?? prev?.seestar.zwo ?? false,
    user: s?.user ?? prev?.seestar.user ?? '',
    password: s?.password ? s.password : (prev?.seestar.password ?? ''),
    serial: s?.serial ?? prev?.seestar.serial ?? '',
    country: s?.country || prev?.seestar.country || 'US',
    starfront: s?.starfront ?? prev?.seestar.starfront ?? false,
    building: s?.building ?? prev?.seestar.building ?? 0,
  };
  // Starfront needs ZWO; ZWO needs the Seestar: switching one off switches what depends on it off
  if (input.driver !== 'seestar') seestar.zwo = false;
  if (!seestar.zwo) seestar.starfront = false;
  return { name: input.name, driver: input.driver, host: input.host, location: input.location, seestar, env: input.env, dataDir: prev?.dataDir, libraryDir: prev?.libraryDir, legacy: prev?.legacy };
}

/** What a profile needs before it can run. */
export function validate(p: Profile): void {
  if ((p.location.latitude === null) !== (p.location.longitude === null)) throw new Error('set both latitude and longitude, or neither');
  if (p.driver === 'seestar' && p.seestar.zwo && (!p.seestar.user || !p.seestar.password)) throw new Error('ZWO Telescope Network needs the account e-mail and password');
}

/**
 * The settings the profile editor shows as fields, each with what a profile that leaves it empty
 * runs with (`inherited`): the hub's own .env value for a shared variable (LLM_MODEL), the built-in
 * default for a telescope's own one (PLAN_*: the hub never hands its .env value of those to a
 * profile). `fromEnv` is the hub's .env value of a telescope's own variable, which a new profile is
 * filled out with.
 */
export function editorSettings(base: NodeJS.ProcessEnv): Array<Setting & { inherited: string; fromEnv: string | null }> {
  const val = (k: string): string | null => {
    const v = base[k]?.trim();
    return v ? v : null;
  };
  const str = (d: Setting['default']): string => (d === null ? '' : String(d));
  return SETTINGS.map((s) => {
    const owned = ownedVar(s.key);
    return { ...s, inherited: owned ? str(s.default) : (val(s.key) ?? str(s.default)), fromEnv: owned ? val(s.key) : null };
  });
}

// ---- the profile's process ----------------------------------------------------------------------

/**
 * Variables that belong to one telescope: the hub never hands its own (.env) values of these to a
 * profile's process, which gets the profile's instead. Everything else (LLM_*, ASTROPHOTO_*, UNITS,
 * STELLARIUM_*, the tunnel's host and token ...) is shared by every profile; SEESTAR_KEY_PATH (the one
 * ZWO handshake key) goes to every ZWO profile.
 */
const OWNED = new Set([
  'TELESCOPE_DRIVER',
  'DATA_DIR',
  'LIBRARY_DIR',
  'AGENT_HOME',
  'WEB_PORT',
  'WEB_BIND',
  'MCP_URL',
  'TZ',
  'DWARF_HOST',
  'SEESTAR_HOST',
  'SEESTAR_CONNECTION',
  'SEESTAR_USER',
  'SEESTAR_PASSWORD',
  'SEESTAR_SN',
  'SEESTAR_COUNTRY',
  'SEESTAR_RPC_PORT',
  'SEESTAR_IMAGE_PORT',
  'SEESTAR_WIDE_IMAGE_PORT',
  'SEESTAR_RTSP_PORT',
  'SEESTAR_WIDE_RTSP_PORT',
  'SEESTAR_HTTP_PORT',
  'SEESTAR_HTTP_ALT_PORT',
  'SEESTAR_TUNNEL_CONTROL_PORT',
  'SEESTAR_TUNNEL_COMMAND',
  'SEESTAR_TUNNEL_CWD',
  'STARFRONT_REMOTE_ZWO',
  'STARFRONT_BUILDING',
]);
const OWNED_PREFIX = ['OBSERVER_', 'PLAN_', 'ASTRO_PROFILE_'];

export const ownedVar = (k: string): boolean => OWNED.has(k) || OWNED_PREFIX.some((p) => k.startsWith(p));

/** The device ports a Seestar's tunnel forwards, and their variables (see seestar-portfwd/src/tunnel.c). */
const SEESTAR_PORTS: ReadonlyArray<[string, number]> = [
  ['SEESTAR_RPC_PORT', 4700],
  ['SEESTAR_IMAGE_PORT', 4800],
  ['SEESTAR_WIDE_IMAGE_PORT', 4804],
  ['SEESTAR_RTSP_PORT', 4554],
  ['SEESTAR_WIDE_RTSP_PORT', 4555],
  ['SEESTAR_HTTP_PORT', 80],
  ['SEESTAR_HTTP_ALT_PORT', 81],
  ['SEESTAR_TUNNEL_CONTROL_PORT', 4710],
];

export interface ChildEnvOptions {
  paths: HubPaths;
  /** the child's web port */
  port: number;
  /** where the tunnel container is (zwo) */
  tunnelHost: string;
  /** relative paths in a profile (its key) resolve against this: the hub's working directory */
  cwd?: string;
}

/**
 * The Seestar handshake key: the official app's key, extracted from the APK. Only connections over
 * ZWO Telescope Network use it (a Seestar on the LAN does not), and it is the same for every one, so
 * every ZWO profile gets the shared SEESTAR_KEY_PATH from .env, made absolute so it means the same
 * file whatever the process's working directory.
 */
export function seestarKeyPath(base: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  const raw = (base.SEESTAR_KEY_PATH ?? '').trim();
  return raw ? path.resolve(cwd, raw) : '';
}

/** Whether the profile connects over ZWO Telescope Network, the only connection that uses the key. */
export const usesSeestarKey = (p: Profile): boolean => p.driver === 'seestar' && p.seestar.zwo;

/** Why the ZWO handshake key cannot be used, or null when it can (or the profile does not need it). */
export function seestarKeyProblem(p: Profile, base: NodeJS.ProcessEnv, cwd = process.cwd()): string | null {
  if (!usesSeestarKey(p)) return null;
  const file = seestarKeyPath(base, cwd);
  if (!file) return 'no ZWO handshake key: the scope refuses every request over ZWO Telescope Network until SEESTAR_KEY_PATH is set in .env';
  let pem: string;
  try {
    pem = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return `the handshake key ${file} cannot be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`;
  }
  return /-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem) ? null : `${file} is not a PEM private key`;
}

/** The environment a profile's Astrocontroller process runs with. */
export function childEnv(p: Profile, base: NodeJS.ProcessEnv, o: ChildEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !ownedVar(k)) env[k] = v;
  const { location: loc, seestar: s } = p;
  Object.assign(env, {
    TELESCOPE_DRIVER: p.driver,
    DATA_DIR: profileDataDir(p, o.paths),
    LIBRARY_DIR: profileLibraryDir(p, o.paths),
    WEB_PORT: String(o.port),
    // only the hub is reached from outside; it proxies /p/<id>/ to this port
    WEB_BIND: '127.0.0.1',
    TZ: loc.timezone,
    OBSERVER_TIMEZONE: loc.timezone,
    OBSERVER_ELEVATION_M: String(loc.elevationM),
    ASTRO_PROFILE_ID: p.id,
    ASTRO_PROFILE_NAME: p.name,
  });
  if (loc.latitude !== null && loc.longitude !== null) {
    env.OBSERVER_LATITUDE = String(loc.latitude);
    env.OBSERVER_LONGITUDE = String(loc.longitude);
  }
  if (p.driver === 'dwarf') {
    if (p.host) env.DWARF_HOST = p.host;
  } else if (s.zwo) {
    const off = p.slot * TUNNEL_SLOT_STRIDE;
    env.SEESTAR_CONNECTION = 'zwo';
    env.SEESTAR_TUNNEL_HOST = o.tunnelHost;
    for (const [k, port] of SEESTAR_PORTS) env[k] = String(port + off);
    env.SEESTAR_USER = s.user;
    env.SEESTAR_PASSWORD = s.password;
    if (s.serial) env.SEESTAR_SN = s.serial;
    env.SEESTAR_COUNTRY = s.country || 'US';
    if (s.starfront) {
      env.STARFRONT_REMOTE_ZWO = 'true';
      env.STARFRONT_BUILDING = String(s.building);
    }
  } else {
    env.SEESTAR_CONNECTION = 'local';
    if (p.host) env.SEESTAR_HOST = p.host;
  }
  // the profile's own variables have the last word
  for (const [k, v] of Object.entries(p.env)) if (ENV_NAME.test(k)) env[k] = v;
  // the one ZWO handshake key: only ZWO profiles get it, and it is not a profile's to change
  const key = usesSeestarKey(p) ? seestarKeyPath(base, o.cwd) : '';
  if (key) env.SEESTAR_KEY_PATH = key;
  else delete env.SEESTAR_KEY_PATH;
  return env;
}

/**
 * The single-telescope setup as a profile, the first time the hub starts: the same driver,
 * address, site and account as .env, and the same data and library folders, so the agent keeps its
 * notes, skills and history. It runs in slot 0, where its ZWO tunnel has the ports and the state
 * it always had.
 */
export function legacyProfile(env: NodeJS.ProcessEnv, paths: HubPaths): Profile {
  const v = (k: string) => (env[k] ?? '').trim();
  const num = (k: string): number | null => (v(k) === '' || !Number.isFinite(Number(v(k))) ? null : Number(v(k)));
  const driver: DriverId = (DRIVER_IDS as readonly string[]).includes(v('TELESCOPE_DRIVER')) ? (v('TELESCOPE_DRIVER') as DriverId) : 'dwarf';
  const zwo = driver === 'seestar' && v('SEESTAR_CONNECTION') === 'zwo';
  const tz = v('OBSERVER_TIMEZONE') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const extra: Record<string, string> = {};
  for (const [k, val] of Object.entries(env)) if (k.startsWith('PLAN_') && val !== undefined && val.trim() !== '') extra[k] = val;
  // a tunnel this setup ran itself, or ports it had remapped, carry over as they were
  for (const k of ['SEESTAR_TUNNEL_COMMAND', 'SEESTAR_TUNNEL_CWD', ...SEESTAR_PORTS.map(([name]) => name)]) if (v(k)) extra[k] = v(k);
  const dataDir = path.resolve(v('DATA_DIR') || (driver === 'dwarf' ? './data' : `./data-${driver}`));
  const libraryDir = path.resolve(v('LIBRARY_DIR') || path.join(dataDir, 'library'));
  const lat = num('OBSERVER_LATITUDE');
  const lon = num('OBSERVER_LONGITUDE');
  return ProfileSchema.parse({
    id: driver,
    name: driver === 'dwarf' ? 'Dwarf' : zwo ? 'Seestar (ZWO)' : 'Seestar',
    driver,
    active: true,
    slot: 0,
    host: zwo ? '' : validHost(v(driver === 'dwarf' ? 'DWARF_HOST' : 'SEESTAR_HOST')) ? v(driver === 'dwarf' ? 'DWARF_HOST' : 'SEESTAR_HOST') : '',
    location: {
      latitude: lat !== null && lon !== null && Math.abs(lat) <= 90 ? lat : null,
      longitude: lat !== null && lon !== null && Math.abs(lon) <= 180 ? lon : null,
      elevationM: Math.min(9000, Math.max(-500, num('OBSERVER_ELEVATION_M') ?? 0)),
      timezone: validTimezone(tz) ? tz : 'UTC',
    },
    seestar: {
      zwo,
      user: v('SEESTAR_USER'),
      password: env.SEESTAR_PASSWORD ?? '',
      serial: v('SEESTAR_SN'),
      country: v('SEESTAR_COUNTRY') || 'US',
      starfront: zwo && ['1', 'true', 'yes', 'on'].includes(v('STARFRONT_REMOTE_ZWO').toLowerCase()),
      building: Math.min(100, Math.max(0, Math.trunc(num('STARFRONT_BUILDING') ?? 0))),
    },
    env: extra,
    dataDir: dataDir === path.resolve(paths.data, 'profiles', driver) ? undefined : dataDir,
    libraryDir: libraryDir === path.resolve(paths.library, driver) ? undefined : libraryDir,
    legacy: true,
    createdAt: Date.now(),
  });
}
