# Astrocontroller

An AI operator for the **DWARFLAB Dwarf 3** smart telescope. The app runs in Docker and has three parts:

- **An MCP server** with 44 tools that control both cameras, the mount, focus, astro workflows, daytime tracking, image analysis, weather, planning and data transfer.
- **[Oh My Pi](https://github.com/can1357/oh-my-pi)** (the `omp` fork of the Pi coding agent). It runs headless in RPC mode as the agent, using your own OpenAI-compatible, vision-capable LLM.
- **A web UI** with live tele/wide/stack views, live-stacking progress, manual controls, a chat with the agent, tonight's weather and target plan, an album and library browser, a skill editor and logs.

The agent keeps playbooks ("skills") and site notes in its workspace and is told to refine them as it learns.

## Quick start

```bash
cp .env.example .env      # set DWARF_HOST, OBSERVER_*, LLM_*, LIBRARY_PATH
docker compose up -d --build
open http://localhost:8080
```

Requirements: Docker. The telescope must be in **STA mode** on your LAN (set this up once with the DWARFLAB app). The container also needs outbound internet for the weather forecast.

> **Close the official DWARFLAB app** (phone/desktop) while using Astrocontroller. While the app holds a session, the telescope drops every other control connection about a second after it connects. The log will tell you if this is happening.

### Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `DWARF_HOST` | Telescope IP (STA mode), e.g. `10.0.0.196`. AP mode is `192.168.88.1`. |
| `DWARF_AUTO_SYNC_TIME_LOCATION` | Push time, timezone and location on every connect (default `true`). |
| `OBSERVER_LATITUDE` / `OBSERVER_LONGITUDE` / `OBSERVER_ELEVATION_M` | Site. Needed for planning, calibration, GoTo, polar alignment and weather. |
| `OBSERVER_TIMEZONE` | IANA zone (e.g. `America/New_York`). All reported times use it. |
| `PLAN_MIN_ALTITUDE_DEG` | Default minimum altitude for target planning. |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | OpenAI-compatible chat-completions endpoint (vLLM, llama.cpp, LM Studio, …). |
| `REASONING_EFFORT` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. You can also change it live in the UI. |
| `LLM_CONTEXT_WINDOW` / `LLM_MAX_TOKENS` | Model limits. |
| `LLM_THINKING_FORMAT` | Optional request shape for thinking (`qwen-chat-template`, `openai`, …). Leave empty for auto. |
| `LLM_VISION` | Send camera and FITS images to the model (default `true`). |
| `LIBRARY_PATH` | Host folder for your imagery library (mounted at `/library`). |
| `WEB_PORT` | Host port for the UI and MCP endpoint. |
| `LIVE_STREAM_FPS` / `LIVE_STREAM_WIDTH` | Browser live-view rate and size. |
| `PUID` / `PGID` | (Linux) uid/gid that owns files written to `./data` and the library. Default 1000. |

Generated agent config (`models.yml`, `config.yml`, `mcp.json`) is rewritten from `.env` on every start under `data/home/.omp/agent/`.

## Imagery library

`transfer_session` (and the Album/Library tabs) copy sessions from the SD card over FTP. On this network that measured about 20 MB/s.

```
<LIBRARY_PATH>/
  <Target>/<date>_<DWARF_RAW_… folder>/
      lights/*.fits             raw 16-bit Bayer subframes (RGGB)
      lights/rejected/*.fits    subs the scope's stacker rejected
      stacked.jpg, stacked-16_*.png/.fits, img_reference.png, shotsInfo.json, session.json
  _calibration/<tele|wide>/<dark|flat|bias>/*.fits    the device's calibration masters
  _photos/<date>/…              daytime photos/videos
```

## Data and the agent workspace (`./data`)

- `workspace/.omp/SYSTEM.md`: the agent's system prompt. It's seeded from `agent/SYSTEM.md` and tracks the shipped version until you edit it.
- `workspace/.omp/skills/*/SKILL.md`: playbooks. They're seeded once and then owned by the agent (and you, via the Skills tab).
- `workspace/NOTES.md`: site, equipment and preference notes the agent maintains.
- `sessions/`: conversation history (resumed on restart; **New** starts fresh).
- `captures/agent/`: every image the agent looked at.

Seeded skills: `session-startup`, `deep-sky-imaging`, `target-planning`, `cloud-gap-imaging`, `polar-alignment`, `daytime-wildlife`, `solar-system`, `image-assessment`, `data-management`, `skill-writing`.

## MCP tools

The MCP endpoint is `http://<host>:8080/mcp` (Streamable HTTP, stateless). Other MCP clients can use it too.

| Area | Tools |
|---|---|
| Status/system | `telescope_status`, `telescope_device_info`, `telescope_reconnect`, `sync_time_and_location`, `power`, `raw_command` |
| Camera | `set_shooting_mode`, `get_camera_settings`, `set_camera_setting`, `take_photo`, `video_recording`, `timelapse`, `view_camera` |
| Motion & focus | `motors_home`, `motor_position`, `move_motors` (absolute/relative), `nudge`, `stop_motion`, `autofocus`, `focus_step`, `focus_position` (incl. infinity) |
| Planning | `sky_conditions`, `weather_forecast`, `plan_targets`, `find_target` |
| Astro | `calibrate`, `goto_target`, `stop_goto`, `live_stacking`, `stacking_status`, `wait`, `polar_alignment`, `track_sun_moon` |
| Daytime | `track_object`, `sentry_mode` |
| Images & data | `list_album`, `view_image`, `analyze_image`, `delete_album_items`, `list_device_sessions`, `transfer_session`, `transfer_files`, `jobs`, `list_library` |

For debugging from a shell: `node dist/tools/smoke.js` lists the tools, and `node dist/tools/smoke.js <tool> '<json-args>'` calls one.

## How it talks to the telescope

- **Control**: WebSocket `:9900`, protobuf `WsPacket`s. The protobuf definitions, packet codec and command registry come from [`@alikh/dwarflab-sdk`](https://github.com/alikh31/dwarflab-sdk) (MIT). `src/dwarf/protocol.ts` adds commands and message variants the SDK lacks (motor run-to/reset/position, one-click GoTo `goto_only`, EQ solving results, …), and the firmware error table comes from [`dwarf_python_api`](https://github.com/stevejcl/dwarf_python_api) (MIT).
- **Live views**: RTSP `:554/ch0|ch1/stream0` (H.265 1080p30) → ffmpeg → MJPEG, on demand. **Stack preview**: the scope's own MJPEG on `:8092/mainstream`.
- **HTTP** `:8082`: device info, album, and the per-mode parameter schema (exposure tables, gain lists, param IDs). **Files**: HTTP `:80` and anonymous FTP `:21`.
- **Catalog**: [OpenNGC](https://github.com/mattiaverga/OpenNGC) (CC-BY-SA 4.0) plus a nickname table. GoTo coordinates are J2000, which I verified against coordinates the DWARF app recorded on this device.
- **Weather**: [Open-Meteo](https://open-meteo.com) (clouds by layer, rain, wind, dew point) + [7Timer!](https://www.7timer.info) (seeing and transparency).

## Validation status (Dwarf 3, firmware 1.5.3, 2026-10-02)

**Verified on hardware:**
- Connection, state and notifications; time/location sync.
- Motor homing, absolute and relative moves, joystick direction mapping (screen-relative), stop.
- Both live streams, full-resolution grabs, and dropping corrupt H.265 frames after motion.
- All camera parameters: exposure, gain, white balance (auto/scene/kelvin), filter, sharpness, … read back from the device.
- Photo, burst, video, normal autofocus, single-step focus, going to the stored infinity focus position.
- Object tracking start/stop with results; shooting-mode switching.
- Album listing; viewing and analysing stacked JPGs and raw FITS; session listing; session transfer with calibration frames.
- Live-stacking start/stop/progress and the stack-preview stream, in forced preview mode.
- Weather, planning and target lookup; the agent end to end with tool calls and vision on your vLLM endpoint.

**Implemented from the protocol, not yet run against the sky** (I validated indoors, so no stars): plate-solve `calibrate`, `goto_target` / one-click GoTo, real live-stacking captures, astro autofocus, `polar_alignment` (EQ solving), sentry mode, Sun/Moon tracking, timelapse. The first clear night will exercise these, and the agent is told to record what it learns in its skills.

Firmware quirks found along the way: several commands are acted on but never acknowledged (single-step focus, track start, RGB/power), motor run-to replies only when the motion completes, and a forced stack without GoTo is preview-only (no FITS saved). These are all handled in code.

## Development

```bash
npm install && npm run build
node --env-file=.env dist/index.js     # needs ffmpeg; set AGENT_ENABLED=false if omp isn't installed
npm run catalog                        # refresh OpenNGC
```
