import fs from 'node:fs';
import path from 'node:path';

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got "${v}")`);
  return n;
}

function optNum(name: string): number | null {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got "${v}")`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function json(name: string): Record<string, unknown> {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return {};
  try {
    const o = JSON.parse(v);
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch {
    /* reported below */
  }
  throw new Error(`${name} must be a JSON object (got "${v}")`);
}

const dataDir =path.resolve(str('DATA_DIR', './data'));

export const config = {
  dwarf: {
    host: str('DWARF_HOST', '192.168.88.1'),
    wsPort: num('DWARF_WS_PORT', 9900),
    httpPort: num('DWARF_HTTP_PORT', 8082),
    rtspPort: num('DWARF_RTSP_PORT', 554),
    stackPort: num('DWARF_STACK_PORT', 8092),
    autoSyncTimeLocation: bool('DWARF_AUTO_SYNC_TIME_LOCATION', true),
  },
  observer: {
    latitude: optNum('OBSERVER_LATITUDE'),
    longitude: optNum('OBSERVER_LONGITUDE'),
    elevationM: num('OBSERVER_ELEVATION_M', 0),
    timezone: str('OBSERVER_TIMEZONE', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    minAltitudeDeg: num('PLAN_MIN_ALTITUDE_DEG', 25),
  },
  llm: {
    baseUrl: str('LLM_BASE_URL', 'http://localhost:8000/v1'),
    model: str('LLM_MODEL', 'qwen'),
    apiKey: str('LLM_API_KEY', 'none'),
    contextWindow: num('LLM_CONTEXT_WINDOW', 131072),
    maxTokens: num('LLM_MAX_TOKENS', 16384),
    reasoningEffort: str('REASONING_EFFORT', 'medium'),
    thinkingFormat: str('LLM_THINKING_FORMAT', ''),
    vision: bool('LLM_VISION', true),
  },
  web: {
    port: num('WEB_PORT', 8080),
    liveFps: num('LIVE_STREAM_FPS', 8),
    liveWidth: num('LIVE_STREAM_WIDTH', 1280),
  },
  paths: {
    data: dataDir,
    library: path.resolve(str('LIBRARY_DIR', path.join(dataDir, 'library'))),
    workspace: path.join(dataDir, 'workspace'),
    sessions: path.join(dataDir, 'sessions'),
    home: path.resolve(str('AGENT_HOME', path.join(dataDir, 'home'))),
    captures: path.join(dataDir, 'captures'),
    catalog: path.resolve(str('CATALOG_DIR', './catalog')),
    agentTemplate: path.resolve(str('AGENT_TEMPLATE_DIR', './agent')),
    public: path.resolve(str('PUBLIC_DIR', './public')),
  },
  studio: {
    /** AstroPhoto Studio server, e.g. http://gpu-box.tailnet:8000 (empty = processing off). */
    url: str('ASTROPHOTO_URL', '').replace(/\/+$/, ''),
    /** Restoration profile name from the server's /api/v1/profiles ("default" = the server's defaults). */
    profile: str('ASTROPHOTO_PROFILE', 'default'),
    /** Processing preset of the Studio UI (optional). */
    preset: str('ASTROPHOTO_PRESET', ''),
    /** JSON overrides passed through as stack_params / params (optional). */
    stackParams: json('ASTROPHOTO_STACK_PARAMS'),
    params: json('ASTROPHOTO_PARAMS'),
    /** Queue processing automatically after every session transfer. */
    autoProcess: bool('ASTROPHOTO_AUTO_PROCESS', true),
    /** Auto-processing pools the new session with every earlier library session of the same target (multi-night stack). */
    poolSessions: bool('ASTROPHOTO_POOL_SESSIONS', false),
    /** auto: use the server's own copy of the library when it has the session, else upload. shared | upload force one. */
    dataAccess: str('ASTROPHOTO_DATA_ACCESS', 'auto') as 'auto' | 'shared' | 'upload',
    /** Where the library is as the server sees it: relative to its images folder ("" = the same folder), or absolute. */
    libraryPath: str('ASTROPHOTO_LIBRARY_PATH', ''),
    /** Copy the finished JPEG/TIFF back into the session folder of the library. */
    fetchOutputs: bool('ASTROPHOTO_FETCH_OUTPUTS', true),
    pollS: num('ASTROPHOTO_POLL_S', 60),
  },
  agent: {
    enabled: bool('AGENT_ENABLED', true),
    /** Wake the agent to park, transfer and shut down when the telescope is plugged in to charge with sessions still on its SD card. */
    promptOnCharge: bool('PROMPT_TRANSFER_ON_CHARGE', false),
    /** Duty loop: default time between automatic wakes while on duty (the agent can pick 30 s–15 min per wake). */
    dutyIntervalS: num('DUTY_INTERVAL_S', 300),
    command: str('OMP_COMMAND', 'omp'),
    mcpUrl: str('MCP_URL', ''),
  },
};

export type Config = typeof config;

// ---------------------------------------------------------------------------
// Telescope address set from the web UI: kept in DATA_DIR/telescope.json and wins over DWARF_HOST.
// ---------------------------------------------------------------------------

const envHost = config.dwarf.host;
const hostFile = path.join(dataDir, 'telescope.json');

try {
  const saved = JSON.parse(fs.readFileSync(hostFile, 'utf8'))?.host;
  if (typeof saved === 'string' && validHost(saved)) config.dwarf.host = saved;
} catch {
  /* no override saved */
}

function validHost(h: string): boolean {
  return h.length <= 253 && /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(h);
}

/** Where the telescope address comes from: the web UI override, or .env (DWARF_HOST). */
export function telescopeHostInfo(): { host: string; source: 'ui' | 'env'; envHost: string } {
  return { host: config.dwarf.host, source: fs.existsSync(hostFile) ? 'ui' : 'env', envHost };
}

/**
 * Change the telescope address and remember it across restarts. An empty value drops the
 * override and goes back to DWARF_HOST. Returns the address now in use.
 */
export function setTelescopeHost(input: string): string {
  const host = input.trim();
  if (host === '' || host === envHost) {
    fs.rmSync(hostFile, { force: true });
    config.dwarf.host = envHost;
    return envHost;
  }
  if (!validHost(host)) throw new Error(`"${host}" is not an IP address or host name`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(hostFile, JSON.stringify({ host, since: Date.now() }));
  config.dwarf.host = host;
  return host;
}

export function observerLocation(): { lat: number; lon: number; elev: number } | null {
  const { latitude, longitude, elevationM } = config.observer;
  if (latitude === null || longitude === null) return null;
  return { lat: latitude, lon: longitude, elev: elevationM };
}

export function requireObserverLocation(): { lat: number; lon: number; elev: number } {
  const loc = observerLocation();
  if (!loc) {
    throw new Error('Observer location is not configured. Set OBSERVER_LATITUDE and OBSERVER_LONGITUDE in .env (or pass lat/lon explicitly).');
  }
  return loc;
}
