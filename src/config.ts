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
export function telescopeHostInfo(): { host: string; source: 'ui' | 'env'; envHost: string } {
  return { host: config.dwarf.host, source: hostOverride.load() !== null ? 'ui' : 'env', envHost: hostOverride.envHost };
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
