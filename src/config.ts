import type { Rig } from './astro/exposure.js';
import { plateScaleArcsecPerPx } from './media/image/types.js';
import path from 'node:path';
import { Env } from './config/env.js';
import { HostOverride } from './config/host.js';
import type { Units } from './util/units.js';
import { DRIVER_IDS, type DriverId } from './drivers/types.js';

export { validHost } from './config/host.js';

export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
/**
 * How a request asks for thinking. All but one are dialects of chat completions; `openai-responses`
 * talks to OpenAI's Responses API (/v1/responses) instead, the only way OpenAI's reasoning models take
 * function tools with reasoning on (their chat completions refuse tools unless reasoning_effort is "none").
 */
const THINKING_FORMATS = ['', 'openai', 'openai-responses', 'qwen', 'qwen-chat-template', 'zai', 'openrouter'] as const;
const DATA_ACCESS = ['auto', 'shared', 'upload'] as const;

const SEESTAR_CONNECTIONS = ['local', 'zwo'] as const;
export type SeestarConnection = (typeof SEESTAR_CONNECTIONS)[number];

const env = new Env();
const driver = env.oneOf<DriverId>('TELESCOPE_DRIVER', DRIVER_IDS, 'dwarf');
// Each driver keeps its own agent workspace, sessions and overrides unless DATA_DIR says otherwise.
const dataDir = path.resolve(env.str('DATA_DIR', driver === 'dwarf' ? './data' : `./data-${driver}`));
const seestarConnection = env.oneOf<SeestarConnection>('SEESTAR_CONNECTION', SEESTAR_CONNECTIONS, 'local');
const zwo = seestarConnection === 'zwo';
/**
 * zwo: where seestar-portfwd's forwarded services are. In Docker that is its container on the
 * compose network (SEESTAR_TUNNEL_HOST, set by docker-compose.yml); outside Docker the ports it
 * publishes on loopback.
 */
const seestarHost = zwo ? env.host('SEESTAR_TUNNEL_HOST', env.host('SEESTAR_HOST', '127.0.0.1')) : env.host('SEESTAR_HOST', 'seestar.local');
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

export const config = {
  /** Which telescope this process drives (src/drivers/). */
  telescope: { driver },
  seestar: {
    /** local: the Seestar's own address. zwo: ZWO Telescope Network, its services forwarded to this host by seestar-portfwd. */
    connection: seestarConnection,
    /** Where the native services are: the scope on the LAN, or the tunnel (its container, or loopback) for zwo. */
    host: seestarHost,
    rpcPort: env.port('SEESTAR_RPC_PORT', 4700),
    imagePort: env.port('SEESTAR_IMAGE_PORT', 4800),
    wideImagePort: env.port('SEESTAR_WIDE_IMAGE_PORT', 4804),
    rtspPort: env.port('SEESTAR_RTSP_PORT', 4554),
    wideRtspPort: env.port('SEESTAR_WIDE_RTSP_PORT', 4555),
    /** While the wide live stream is watched and the scope is idle (no stack, no operation), a fresh wide frame is
     *  taken this often: the wide camera streams only in its own view, so each one pauses the tele's view for ~15 s.
     *  0 = only when the wide stream is opened. */
    wideRefreshS: env.num('SEESTAR_WIDE_REFRESH_S', 60, { min: 0, max: 3600 }),
    /** seestar-portfwd publishes the device's port 80 as 8080 on the host; on the Docker network it is 80 */
    httpPort: env.port('SEESTAR_HTTP_PORT', zwo && LOOPBACK.includes(seestarHost) ? 8080 : 80),
    /** PEM private key for the firmware 7.18+ handshake (extracted by you from the official app; never shipped here) */
    keyPath: env.str('SEESTAR_KEY_PATH', ''),
    autoSyncTimeLocation: env.bool('SEESTAR_AUTO_SYNC_TIME_LOCATION', true),
    /** Telescope Network account: the read-only status check, and what the tunnel logs in with */
    account: {
      user: env.str('SEESTAR_USER', ''),
      password: env.str('SEESTAR_PASSWORD', ''),
      /** the telescope's serial when the account holds several (the rented one) */
      serial: env.str('SEESTAR_SN', ''),
      country: env.str('SEESTAR_COUNTRY', 'US'),
    },
    tunnel: {
      /** started and supervised for zwo when set, e.g. `docker compose -f seestar-portfwd/compose.yaml up`; empty = the tunnel runs as a container (below) or you run it */
      command: env.str('SEESTAR_TUNNEL_COMMAND', ''),
      cwd: env.str('SEESTAR_TUNNEL_CWD', ''),
      /** how long the tunnel may take to come up before a start is called failed */
      readyTimeoutS: env.num('SEESTAR_TUNNEL_READY_TIMEOUT_S', 180, { min: 10, max: 1800 }),
      /**
       * The seestar-portfwd supervisor (seestar-portfwd/src/supervisor.py). The tunnel container
       * stays idle until Connect asks it for the scope's one session, and Disconnect hands it
       * back; used when SEESTAR_TUNNEL_COMMAND is empty, i.e. the tunnel is a container we talk to
       * rather than a child we spawn.
       */
      control: {
        enabled: env.bool('SEESTAR_TUNNEL_CONTROL', true),
        host: env.host('SEESTAR_TUNNEL_CONTROL_HOST', seestarHost),
        port: env.port('SEESTAR_TUNNEL_CONTROL_PORT', 4710),
        /** required only when the container sets SEESTAR_TUNNEL_CONTROL_TOKEN */
        token: env.str('SEESTAR_TUNNEL_CONTROL_TOKEN', ''),
        /** the container gives the scope back if we stop refreshing this often (0 = keep it until Disconnect) */
        leaseS: env.num('SEESTAR_TUNNEL_LEASE_S', 180, { min: 0, max: 3600 }),
      },
    },
  },
  /**
   * Starfront Observatories' autonomous nights (agent/starfront.ts): offered only with
   * STARFRONT_REMOTE_ZWO=true on a Seestar over ZWO Telescope Network.
   */
  starfront: {
    available: env.bool('STARFRONT_REMOTE_ZWO', false) && driver === 'seestar' && seestarConnection === 'zwo',
    /** the building the scope is in (its roof is followed); 0 = unknown: any roof, confirmed by the telescope */
    building: env.num('STARFRONT_BUILDING', 0, { min: 0, max: 100, int: true }),
    roofUrl: env.str('STARFRONT_ROOF_URL', 'https://alpaca-api.tx.starfront.space/api/v1/roof/state'),
    /** local time at which a roof still reported closed is checked with the telescope */
    roofCheckTime: env.str('STARFRONT_ROOF_CHECK_TIME', '19:00'),
    pollS: env.num('STARFRONT_POLL_S', 60, { min: 15, max: 900 }),
    /** the night's duty starts this long before the plan's start (dark): the agent connects to the disconnected scope (5–10 min over ZWO) */
    connectLeadMin: env.num('STARFRONT_CONNECT_LEAD_MIN', 25, { min: 5, max: 120, int: true }),
  },
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
     * reconstructed — keep it as the fallback if a firmware refuses 2.3. See src/drivers/dwarf/wire/transport.ts.
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
 /** metric | imperial: how weather is shown (temperatures, wind, precipitation); it is computed in metric */
 units: env.oneOf<Units>('UNITS', ['metric', 'imperial'] as const, 'metric'),
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
  /** the scope's spec file (devices/<id>.json) when the scope's own report should not pick it, e.g. seestar-s30-pro */
  device: env.str('PLAN_DEVICE', ''),
  /** the site's zenith sky brightness from a sky meter, mag/arcsec² (wins over measured subs and PLAN_BORTLE) */
  skySqm: env.optNum('PLAN_SKY_SQM', { min: 16, max: 22.5 }),
  /** the swamp factor a sub should reach: sky noise² over read noise² (Deep Sky Detail's calculator recommends 10; 3–5 is the lenient school) */
  swampFactor: env.num('PLAN_SWAMP_FACTOR', 10, { min: 1, max: 100 }),
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
    /** the address to listen on ('' = every interface); the profile hub runs each profile on 127.0.0.1 */
    bind: env.str('WEB_BIND', ''),
    /** set by the profile hub (src/hub/): the profile this process is, for the page title */
    profileName: env.str('ASTRO_PROFILE_NAME', ''),
    liveFps: env.num('LIVE_STREAM_FPS', 8, { min: 1, max: 30 }),
    liveWidth: env.num('LIVE_STREAM_WIDTH', 1280, { min: 160, max: 3840, int: true }),
  },
  /** The Stellarium tab: the bundled sky works offline; streaming adds the online surveys. */
  stellarium: {
    /** stream DSS imagery, Gaia stars, the full deep-sky catalog and the planet textures */
    stream: env.bool('STELLARIUM_STREAM', false),
    /** where the surveys are streamed from (a mirror of data.stellarium.org's layout) */
    dataUrl: env.url('STELLARIUM_DATA_URL', 'https://data.stellarium.org'),
  },
  paths: {
    data: dataDir,
    library: path.resolve(env.str('LIBRARY_DIR', path.join(dataDir, 'library'))),
    workspace: path.join(dataDir, 'workspace'),
    sessions: path.join(dataDir, 'sessions'),
    home: path.resolve(env.str('AGENT_HOME', path.join(dataDir, 'home'))),
    captures: path.join(dataDir, 'captures'),
    catalog: path.resolve(env.str('CATALOG_DIR', './catalog')),
    /** the shipped smart-telescope spec files; the owner's own go in <data>/devices */
    devices: path.resolve(env.str('DEVICES_DIR', './devices')),
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
    /** Auto-processing pools the new session with every earlier library session of the same target, camera, scope and filter (multi-night stack). */
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
if (driver === 'seestar' && zwo && LOOPBACK.includes(config.seestar.host) && config.seestar.httpPort === config.web.port) {
  // seestar-portfwd publishes the scope's port 80 on 127.0.0.1:8080, the web UI's default port: one of the two fails to bind
  env.report(`WEB_PORT ${config.web.port} is also where the ZWO tunnel forwards the Seestar's file server: set WEB_PORT to another port, or remap that port in seestar-portfwd's compose.yaml and set SEESTAR_HTTP_PORT to match`);
}
env.check();

export type Config = typeof config;

// The telescope address set from the web UI wins over DWARF_HOST (SEESTAR_HOST for the Seestar driver).
const hostConfig = driver === 'seestar' ? config.seestar : config.dwarf;
const hostOverride = new HostOverride(path.join(dataDir, 'telescope.json'), hostConfig.host);
hostConfig.host = hostOverride.load() ?? hostConfig.host;

/** Where the telescope address comes from: the web UI override, or .env (DWARF_HOST). */
export function telescopeHostInfo(): {
 host: string;
 source: 'ui' | 'env';
 envHost: string;
 /** the .env variable the address comes from when the UI sets none */
 envVar: string;
} {
 return {
  envVar: driver === 'seestar' ? (config.seestar.connection === 'zwo' ? 'SEESTAR_TUNNEL_HOST' : 'SEESTAR_HOST') : 'DWARF_HOST',
  host: hostConfig.host,
  source: hostOverride.load() !== null ? 'ui' : 'env',
  envHost: hostOverride.envHost,
 };
}

/**
 * Change the telescope address and remember it across restarts. An empty value drops the
 * override and goes back to DWARF_HOST. Returns the address now in use.
 */
export function setTelescopeHost(input: string): string {
  hostConfig.host = hostOverride.set(input);
  return hostConfig.host;
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
