import type { Rig } from './astro/exposure.js';
import { plateScaleArcsecPerPx } from './media/image/types.js';
import path from 'node:path';
import { Env } from './config/env.js';
import { HostOverride } from './config/host.js';

export { validHost } from './config/host.js';

export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
const THINKING_FORMATS = ['', 'openai', 'qwen', 'qwen-chat-template', 'zai', 'openrouter'] as const;
const DATA_ACCESS = ['auto', 'shared', 'upload'] as const;

const env = new Env();
const dataDir = path.resolve(env.str('DATA_DIR', './data'));

export const config = {
  dwarf: {
    host: env.host('DWARF_HOST', '192.168.88.1'),
    wsPort: env.port('DWARF_WS_PORT', 9900),
    httpPort: env.port('DWARF_HTTP_PORT', 8082),
    rtspPort: env.port('DWARF_RTSP_PORT', 554),
    stackPort: env.port('DWARF_STACK_PORT', 8092),
    ftpPort: env.port('DWARF_FTP_PORT', 21),
    autoSyncTimeLocation: env.bool('DWARF_AUTO_SYNC_TIME_LOCATION', true),
    /**
     * The `majorVersion`/`minorVersion` pair on every request packet. `app` (2.3) is what the official
     * DWARFLAB app writes (`rw4.d()`), so it is the default: we speak the device's own protocol.
     * `sdk` (1.20) is what `@alikh/dwarflab-sdk` writes and what this app sent before the wire layer was
     * reconstructed — keep it as the fallback if a firmware refuses 2.3. See src/dwarf/wire/transport.ts.
     */
    protocolHeader: env.oneOf<'sdk' | 'app'>('DWARF_PROTOCOL_HEADER', ['sdk', 'app'] as const, 'app'),
    /** stop a live stack that has rejected every frame (or taken none) for this many minutes; 0 = only notify */
    stackAutoStopMin: env.num('STACK_AUTOSTOP_MIN', 10, { min: 0 }),
  },
  observer: {
    latitude: env.optNum('OBSERVER_LATITUDE', { min: -90, max: 90 }),
    longitude: env.optNum('OBSERVER_LONGITUDE', { min: -180, max: 180 }),
    elevationM: env.num('OBSERVER_ELEVATION_M', 0, { min: -500, max: 9000 }),
    timezone: env.timezone('OBSERVER_TIMEZONE', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    minAltitudeDeg: env.num('PLAN_MIN_ALTITUDE_DEG', 25, { min: 0, max: 90 }),
 },
 /** What every planning surface judges a night against (see planDefaults). */
 plan: {
  /** site sky class: Bortle 1 (dark) … 9 (inner city); the whole ladder of thresholds moves with it */
  bortle: env.num('PLAN_BORTLE', 5, { min: 1, max: 9, int: true }),
  /** one fixed glass for every target ('none', 'astro', 'duo-band', 'ha 7nm'…); empty = the scope's own filters, best per target */
  filter: env.str('PLAN_FILTER', ''),
  /** the filters the scope switches between itself (the Dwarf 3's Astro and Duo-Band): each target is planned through the best of them */
  filters: env
   .str('PLAN_FILTERS', 'Astro,Duo-Band')
   .split(',')
   .map((f) => f.trim())
   .filter(Boolean),
  /** clear aperture of the tele in mm — the optics number the scope cannot report, and the sky-limited sub needs */
  apertureMm: env.optNum('PLAN_APERTURE_MM', { min: 1, max: 2000 }),
  /** read noise in electrons; without it the sub advice is an honest range, not one number */
  readNoiseE: env.optNum('PLAN_READ_NOISE_E', { min: 0.1, max: 50 }),
  /** the Dwarf head is alt-az; a wedge or a pier-mounted rig changes the trailing ceiling */
  mount: env.oneOf<'alt-az' | 'eq'>('PLAN_MOUNT', ['alt-az', 'eq'] as const, 'alt-az'),
  guided: env.bool('PLAN_GUIDED', false),
  /** arcsec per pixel; the app's own tele plate scale when unset */
  plateScaleArcsecPerPx: env.optNum('PLAN_PLATE_SCALE_ARCSEC', { min: 0.05, max: 60 }),
  },
  llm: {
    baseUrl: env.url('LLM_BASE_URL', 'http://localhost:8000/v1'),
    model: env.str('LLM_MODEL', 'qwen'),
    apiKey: env.str('LLM_API_KEY', 'none'),
    contextWindow: env.num('LLM_CONTEXT_WINDOW', 131072, { min: 1024, int: true }),
    maxTokens: env.num('LLM_MAX_TOKENS', 16384, { min: 1, int: true }),
    reasoningEffort: env.oneOf<ReasoningEffort>('REASONING_EFFORT', REASONING_EFFORTS, 'medium'),
    thinkingFormat: env.oneOf('LLM_THINKING_FORMAT', THINKING_FORMATS, ''),
    vision: env.bool('LLM_VISION', true),
  },
  web: {
    port: env.port('WEB_PORT', 8080),
    liveFps: env.num('LIVE_STREAM_FPS', 8, { min: 1, max: 30 }),
    liveWidth: env.num('LIVE_STREAM_WIDTH', 1280, { min: 160, max: 3840, int: true }),
  },
  paths: {
    data: dataDir,
    library: path.resolve(env.str('LIBRARY_DIR', path.join(dataDir, 'library'))),
    workspace: path.join(dataDir, 'workspace'),
    sessions: path.join(dataDir, 'sessions'),
    home: path.resolve(env.str('AGENT_HOME', path.join(dataDir, 'home'))),
    captures: path.join(dataDir, 'captures'),
    catalog: path.resolve(env.str('CATALOG_DIR', './catalog')),
    agentTemplate: path.resolve(env.str('AGENT_TEMPLATE_DIR', './agent')),
    public: path.resolve(env.str('PUBLIC_DIR', './public')),
  },
  studio: {
    /** AstroPhoto Studio server, e.g. http://gpu-box.tailnet:8000 (empty = processing off). */
    url: env.url('ASTROPHOTO_URL', ''),
    /** Restoration profile name from the server's /api/v1/profiles ("default" = the server's defaults). */
    profile: env.str('ASTROPHOTO_PROFILE', 'default'),
    /** Processing preset of the Studio UI (optional). */
    preset: env.str('ASTROPHOTO_PRESET', ''),
    /** JSON overrides passed through as stack_params / params (optional). */
    stackParams: env.json('ASTROPHOTO_STACK_PARAMS'),
    params: env.json('ASTROPHOTO_PARAMS'),
    /** Queue processing automatically after every session transfer. */
    autoProcess: env.bool('ASTROPHOTO_AUTO_PROCESS', true),
    /** Auto-processing pools the new session with every earlier library session of the same target (multi-night stack). */
    poolSessions: env.bool('ASTROPHOTO_POOL_SESSIONS', false),
    /** auto: use the server's own copy of the library when it has the session, else upload. shared | upload force one. */
    dataAccess: env.oneOf('ASTROPHOTO_DATA_ACCESS', DATA_ACCESS, 'auto'),
    /** Where the library is as the server sees it: relative to its images folder ("" = the same folder), or absolute. */
    libraryPath: env.str('ASTROPHOTO_LIBRARY_PATH', ''),
    /** Copy the finished JPEG/TIFF back into the session folder of the library. */
    fetchOutputs: env.bool('ASTROPHOTO_FETCH_OUTPUTS', true),
    pollS: env.num('ASTROPHOTO_POLL_S', 60, { min: 5 }),
  },
  agent: {
    enabled: env.bool('AGENT_ENABLED', true),
    /** Wake the agent to park, transfer and shut down when the telescope is plugged in to charge with sessions still on its SD card. */
    promptOnCharge: env.bool('PROMPT_TRANSFER_ON_CHARGE', false),
    /** Duty loop: default time between automatic wakes while on duty (the agent can pick 30 s–15 min per wake). */
    dutyIntervalS: env.num('DUTY_INTERVAL_S', 300, { min: 30, max: 900 }),
    command: env.str('OMP_COMMAND', 'omp'),
    mcpUrl: env.url('MCP_URL', ''),
  },
};

if ((config.observer.latitude === null) !== (config.observer.longitude === null)) {
  env.report('OBSERVER_LATITUDE and OBSERVER_LONGITUDE must be set together (only one is set)');
}
env.check();

export type Config = typeof config;

// The telescope address set from the web UI wins over DWARF_HOST.
const hostOverride = new HostOverride(path.join(dataDir, 'telescope.json'), config.dwarf.host);
config.dwarf.host = hostOverride.load() ?? config.dwarf.host;

/** Where the telescope address comes from: the web UI override, or .env (DWARF_HOST). */
export function telescopeHostInfo(): {
 host: string;
 source: 'ui' | 'env';
 envHost: string;
} {
 return {
  host: config.dwarf.host,
  source: hostOverride.load() !== null ? 'ui' : 'env',
  envHost: hostOverride.envHost,
 };
}

/**
 * Change the telescope address and remember it across restarts. An empty value drops the
 * override and goes back to DWARF_HOST. Returns the address now in use.
 */
export function setTelescopeHost(input: string): string {
  config.dwarf.host = hostOverride.set(input);
  return config.dwarf.host;
}

export interface ObserverLocation {
  lat: number;
  lon: number;
  elev: number;
}

export function observerLocation(): ObserverLocation | null {
  const { latitude, longitude, elevationM } = config.observer;
  if (latitude === null || longitude === null) return null;
  return { lat: latitude, lon: longitude, elev: elevationM };
}

export function requireObserverLocation(): ObserverLocation {
  const loc = observerLocation();
  if (!loc) {
    throw new Error('Observer location is not configured. Set OBSERVER_LATITUDE and OBSERVER_LONGITUDE in .env (or pass lat/lon explicitly).');
  }
  return loc;
}

/** Native width of the tele sensor, which is what the documented field of view is measured over. */
const TELE_SENSOR_WIDTH_PX = 3840;

/**
 * The sky and the glass every planning surface scores a night against. The plate scale comes from
 * the app's own lens table; the aperture and the read noise are the two optics numbers the scope
 * cannot report, so they come from `.env` and the sub-exposure advice narrows to the mount's
 * ceiling without them.
 */
export function planDefaults(): {
 bortle: number;
 filter: string;
 filters: string[];
 rig: Omit<Rig, 'band'>;
} {
 return {
  bortle: config.plan.bortle,
  filter: config.plan.filter,
  filters: config.plan.filters,
  rig: {
   plateScaleArcsecPerPx: config.plan.plateScaleArcsecPerPx ?? plateScaleArcsecPerPx('tele', TELE_SENSOR_WIDTH_PX),
   apertureMm: config.plan.apertureMm ?? undefined,
   readNoise: config.plan.readNoiseE ?? undefined,
   mount: config.plan.mount,
   guided: config.plan.guided,
  },
 };
}
