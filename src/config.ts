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

const dataDir = path.resolve(str('DATA_DIR', './data'));

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
  agent: {
    enabled: bool('AGENT_ENABLED', true),
    command: str('OMP_COMMAND', 'omp'),
    mcpUrl: str('MCP_URL', ''),
  },
};

export type Config = typeof config;

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
