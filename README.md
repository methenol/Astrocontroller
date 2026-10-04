# Astrocontroller

An AI operator for the **DWARFLAB Dwarf 3** smart telescope. The app runs in Docker and has three parts:

- **An MCP server** with 50 tools that control both cameras, the mount, focus, astro workflows, daytime tracking, image analysis, weather, planning and data transfer.
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
| `DUTY_INTERVAL_S` | Default time between duty samples (see "Duty loop"); the agent can choose 30 s–15 min per sample. Default `300`. |
| `PROMPT_TRANSFER_ON_CHARGE` | When the scope is plugged in to charge with sessions still on its SD card, the agent is woken to park, transfer (processing queues itself) and shut the telescope down once the transfers are done. Never while imaging. Default `false`. |
| `LIBRARY_PATH` | Host folder for your imagery library (mounted at `/library`). |
| `WEB_PORT` | Host port for the UI and MCP endpoint. |
| `LIVE_STREAM_FPS` / `LIVE_STREAM_WIDTH` | Browser live-view rate and size. |
| `PUID` / `PGID` | (Linux) uid/gid that owns files written to `./data` and the library. Default 1000. |
| `ASTROPHOTO_URL` | AstroPhoto Studio server (e.g. `http://gpu-box:8000` over Tailscale). Empty = processing off. |
| `ASTROPHOTO_PROFILE` | Restoration profile, by name, from the server's `/api/v1/profiles`: `default` (the server's default: ImageMM with its Noise2Noise pass), `imagemm` (without it), `n2n-network` (fast), `n2n-rl`. |
| `ASTROPHOTO_AUTO_PROCESS` / `ASTROPHOTO_POOL_SESSIONS` | Queue processing after each transfer / stack each new night with the earlier nights of its target. |
| `ASTROPHOTO_DATA_ACCESS` / `ASTROPHOTO_LIBRARY_PATH` | `auto` \| `shared` \| `upload`, and where the library is as the server sees it (see below). |
| `ASTROPHOTO_FETCH_OUTPUTS`, `ASTROPHOTO_PRESET`, `ASTROPHOTO_STACK_PARAMS`, `ASTROPHOTO_PARAMS`, `ASTROPHOTO_POLL_S` | Copy results back; optional preset and JSON overrides; poll interval. |

Generated agent config (`models.yml`, `config.yml`, `mcp.json`) is rewritten from `.env` on every start under `data/home/.omp/agent/`.

## Agent chat

The Agent tab streams the agent's work as it happens:
- **Reasoning and tool calls.**
  - Reasoning appears in a fold that is open while the model thinks and closes once it answers ("thought for 12 s"). If you open or close it yourself, it stays that way.
  - Tool calls show their intent, a live timer while they run, and their result. Failed calls stand out.
- **Scrolling.** The view follows new output while you are at the bottom. Scroll up and it stays where you are; a "↓ new" button brings you back.
- **Status line.** It shows what the agent is doing (thinking, writing, running `goto_target` for 1 m 20 s), and the context bar shows how full the model's context is. **Compact** summarises older history to free space.
- **Plan card.** The agent's todo list, i.e. its plan for the night, appears above the chat as it updates it.
- **Talking to it mid-turn.**
  - **Enter** steers it: the message is delivered at its next step.
  - **Alt+Enter** queues a follow-up for when the turn ends. Queued messages show as chips you can remove.
  - **Esc** stops it, and **↑** in an empty box recalls your last message.
- **Automatic messages** (duty samples and events) are shown folded and marked as automatic.

### Duty loop

An LLM turn ends when the model stops calling tools, and nothing happens after that until someone writes again. A **duty** keeps the agent working as a closed-loop controller without giving it a way to sleep:
- Start one from the duty bar (objective, end time: astronomical dawn, a time, or none; sample interval), or the agent starts one with the `duty` tool when you give it an unattended objective.
- Each time the agent's turn ends, the next **sample** is scheduled. At that time the agent is woken with the objective and fresh measurements (time to dawn, connection, battery, tracking, stacking progress, dark capture, transfers, processing, camera-service health).
- **Events** wake it at once: a stack the scope ended itself, a dark master saved, a transfer or processing job finished, connection lost or back, low battery, charging, a hung camera service. Events about work the agent started reach it even without a duty.
- The agent cannot complete a duty before its end time. You can pause, resume, stop or "wake now" from the duty bar, and pressing Stop on the agent pauses the duty.

### Telescope controls

- **Disconnect / Connect** (top bar) releases the telescope without stopping the container. It closes the control link, the video readers and the stack preview, cancels transfers, and refuses every command until you press Connect (e.g. to use the DWARFLAB app). It survives a restart.
- **Reboot / Shut down** are in the Power row of the controls (with confirmation).

## Imagery library

`transfer_session` (and the Album/Library tabs) copy sessions from the SD card over FTP. On this network that measured about 20 MB/s. The library mirrors the telescope's own `Astronomy` folder, which is the layout AstroPhoto Studio reads:

```
<LIBRARY_PATH>/
  DWARF_RAW_TELE_<target>_EXP_15_GAIN_60_<time>/
      *.fits                     raw 16-bit Bayer subs (RGGB); failed_*.fits = subs the scope's stacker rejected
      stacked.jpg, stacked-16_*.png/.fits, shotsInfo.json, session.json
      processed/                 finished JPEG/TIFF/JSON from AstroPhoto Studio
  CALI_FRAME/<dark|flat|bias>/<cam_0|cam_1>/*.fits    the device's calibration masters
  _photos/<date>/…               daytime photos/videos
```

The scope names the session folder after the GoTo target. The controller picks the name the way the DWARF app does (Messier, then Caldwell, then catalog id), so nights captured with either one stack together.

## Processing in AstroPhoto Studio

When a transfer finishes, the session is queued for processing on an [AstroPhoto Studio](../AstroPhoto-Studio) server (`ASTROPHOTO_URL`, normally a GPU machine on Tailscale), using its `/api/v1` job API. The queue is a local **outbox** (`data/processing.json`) that survives restarts:

1. **Getting the data to the server.** With `ASTROPHOTO_DATA_ACCESS=auto`, the outbox asks the server whether it already sees the session at `ASTROPHOTO_LIBRARY_PATH`/`<session>` with every sub. This is the case when both read the NAS: set the Studio's `--images` to the same Dwarf folder, or point `ASTROPHOTO_LIBRARY_PATH` at it. If the server doesn't see the session, the subs, `shotsInfo.json` and the camera's `CALI_FRAME` masters are uploaded to its uploads folder first. Uploads are resumable and skip files already there.
2. **Submitting.** Each item is submitted with the configured profile. Submission is idempotent, so a lost reply never queues a job twice.
3. **Waiting and collecting.** The outbox polls the job and copies the outputs to `<session>/processed/`.

**Field sessions** need nothing special. While the server is out of reach, items wait in the outbox. They go out once it answers, uploading when the server can't see the data.

**Multi-night stacks.** One job is one image. `process_session target="C 33"` pools every library session of that target, and `ASTROPHOTO_POOL_SESSIONS=true` does this automatically after each transfer.

The profile names, presets and job kinds come from the server, so new profiles in Studio work without code changes here. The agent tools are `processing_status`, `process_session` and `processing_job`; the Library tab has a Processing card.

## Data and the agent workspace (`./data`)

- `workspace/.omp/SYSTEM.md`: the agent's system prompt. It's seeded from `agent/SYSTEM.md` and tracks the shipped version until you edit it.
- `workspace/.omp/skills/*/SKILL.md`: playbooks. They're seeded once and then owned by the agent (and you, via the Skills tab).
- `workspace/NOTES.md`: site, equipment and preference notes the agent maintains.
- `sessions/`: conversation history (resumed on restart; **New** starts fresh).
- `captures/agent/`: every image the agent looked at.

Seeded skills: `session-startup`, `deep-sky-imaging`, `acquisition-profiles`, `session-qc`, `dark-library`, `acquisition-experiments`, `target-planning`, `cloud-gap-imaging`, `polar-alignment`, `daytime-wildlife`, `solar-system`, `image-assessment`, `data-management`, `skill-writing`.

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
| Images & data | `list_album`, `view_image`, `analyze_image`, `analyze_subs`, `dark_frames`, `delete_album_items`, `list_device_sessions`, `transfer_session`, `transfer_files`, `jobs`, `list_library` |
| Processing | `processing_status`, `process_session`, `processing_job` |

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
