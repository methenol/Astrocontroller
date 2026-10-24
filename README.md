# Astrocontroller

An AI operator for the **DWARFLAB Dwarf 3** smart telescope. The app runs in Docker and has three parts:

- **An MCP server** with 55 tools that control both cameras, the mount, focus, astro workflows, daytime tracking, image analysis, weather, planning and data transfer.
- **[Oh My Pi](https://github.com/can1357/oh-my-pi)** (the `omp` fork of the Pi coding agent). It runs headless in RPC mode as the agent, using your own OpenAI-compatible, vision-capable LLM.
- **A web UI** with live tele/wide/stack views, live-stacking progress, manual controls, a chat with the agent, tonight's weather and target plan, an album and library browser, a skill editor and logs. It is mobile-first: the same page is a thumb-driven single-screen app on a phone at the scope and a two-column desk layout on a laptop.

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
| `DWARF_HOST` | Telescope IP (STA mode), e.g. `10.0.0.196`. AP mode is `192.168.88.1`. Can be changed from the web UI (View → System → Telescope IP); that setting is kept in `data/telescope.json` and wins over this one until you clear the field. |
| `DWARF_AUTO_SYNC_TIME_LOCATION` | Push time, timezone and location on every connect (default `true`). |
| `DWARF_PROTOCOL_HEADER` | `app` (default) sends the header the official DWARFLAB app sends (`majorVersion 2 / minorVersion 3`); `sdk` sends the third-party SDK's `1.20` instead. Only touch it if a firmware refuses the official header. |
| `OBSERVER_LATITUDE` / `OBSERVER_LONGITUDE` / `OBSERVER_ELEVATION_M` | Site. Needed for planning, calibration, GoTo, polar alignment and weather. |
| `OBSERVER_TIMEZONE` | IANA zone (e.g. `America/New_York`). All reported times use it. |
| `PLAN_MIN_ALTITUDE_DEG` | Default minimum altitude for target planning. |
| `PLAN_BORTLE` | Site sky class 1 (dark) … 9 (inner city), default `5`. The one number that moves every reachability threshold: what the sky and glass can bring up, and how long a sub the sky rewards. |
| `PLAN_FILTERS` | The Dwarf 3's filters, default `Astro,Duo-Band`. Each target is planned through the best of them (continuum targets through Astro only) and `suggestedFilter` names it. Decides whether a faint hydrogen-alpha region is a target at all, and how much the Moon costs it. |
| `PLAN_FILTER` | Force one glass for every target instead (`none`, `astro`, `uhc`, `duo-band`, `ha 7nm`, a product name…); empty = `PLAN_FILTERS`. |
| `PLAN_APERTURE_MM` | Clear aperture of the tele lens. The one optics number the scope cannot report; without it the sub advice is the mount's ceiling, with the missing number named. |
| `PLAN_READ_NOISE_E` | Camera read noise in electrons. With it the sub length is one number; without it the plan quotes the honest range from a modern sensor to an old one. |
| `PLAN_MOUNT` / `PLAN_GUIDED` | `alt-az` (default) or `eq`; guided or not. Sets what trails and how soon: field rotation on an alt-az head, the trails budget on an unguided equatorial, nothing when guided. |
| `PLAN_PLATE_SCALE_ARCSEC` | Arcsec per pixel; the telescope's own plate scale is used when unset. |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | OpenAI-compatible chat-completions endpoint (vLLM, llama.cpp, LM Studio, …). |
| `REASONING_EFFORT` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. You can also change it live in the UI. |
| `LLM_CONTEXT_WINDOW` / `LLM_MAX_TOKENS` | Model limits. |
| `LLM_THINKING_FORMAT` | Request shape for thinking (`qwen`, `qwen-chat-template`, `openai`, …). Use `qwen` for Qwen on vLLM: with it empty, Oh My Pi sends no reasoning effort and the server's default applies. |
| `LLM_VISION` | Send camera and FITS images to the model (default `true`). |
| `DUTY_INTERVAL_S` | Default time between duty samples (see "Duty loop"); the agent can choose 30 s–15 min per sample. Default `300`. |
| `PROMPT_TRANSFER_ON_CHARGE` | When the scope is plugged in to charge with sessions still on its SD card, the agent is woken to park, transfer (processing queues itself) and shut the telescope down once the transfers are done. Never while imaging. Default `false`. |
| `LIBRARY_PATH` | Host folder for your imagery library (mounted at `/library`). |
| `WEB_PORT` | Host port for the UI and MCP endpoint. |
| `LIVE_STREAM_FPS` / `LIVE_STREAM_WIDTH` | Browser live-view rate and size. |
| `STELLARIUM_STREAM` / `STELLARIUM_DATA_URL` | The Stellarium tab works offline from the bundled sky data; `true` also streams the online surveys (DSS colour imagery, Gaia stars, the full deep-sky catalog, planet textures) from `data.stellarium.org` or a mirror. Default `false`. |
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

- **Disconnect / Connect** releases the telescope without stopping the container. It closes the control link, the video readers and the stack preview, cancels transfers, and refuses every command until you press Connect (e.g. to use the DWARFLAB app). It survives a restart. On a phone it is in the ⋯ menu; at desk widths it sits in the top bar.
- **Reboot / Shut down** are in the System group of the controls (with confirmation). On a phone the whole System group is folded behind the ⋯ menu.
- **Star focus** lives in the Focus group: **Sharpness ★** takes one tele frame and scores how sharp the stars are at the current focus (median star half-flux radius → `1000 ÷ HFR″`), **Tune ★** steps the focuser ± 15/30/60 units around it, scores every stop and leaves it on the sharpest. The line under the buttons shows the last reading, and during a sweep which sample it is on; the focus buttons lock while it runs. Exposure and gain are put back afterwards. The agent runs the same code as `star_sharpness` / `star_focus`.

## On a phone or tablet

The UI is one page, one screen at a time, sized for gloves and dark skies. Nothing scrolls the page itself; each screen scrolls inside its own body, so the header, the capture bar and the tab bar never move.

- **Bottom bar**: View · Agent · Tonight · Album · More. Database, Library, Skills and Log live under **More** on a phone and become top-level tabs at desk widths. The screen you were on is remembered.
- **View**: tap the main view to fill the screen (Fullscreen API where it exists, an in-page mode where it does not — iOS), pinch to zoom, drag to pan, double-tap to zoom to the point you tapped and again to reset, ✕ or Esc to leave. Tapping a small view swaps it into the main slot. Frames are only streamed for the views on screen, so leaving the View screen stops the video and frees the radio.
- **Capture bar** is pinned under your thumb: camera, Photo, Burst, Record, Stack.
- **Aim** is a nine-button pad — hold any arrow to keep moving, ■ in the middle stops everything — with a speed slider and Home / Level / Park. Cell size follows the viewport (54-68 px) so it stays a thumb target on a small phone and tightens up at desk widths. Only Aim is open at phone widths; Focus, Mode & exposure and System are folded, and all of them open at desk widths.
- **Tonight** names one target to start with and the season the list was read off ("Start with the Witch Head Nebula — Milky Way core"), then gives each row its verdict — *easy*, *needs time*, or *beyond tonight's sky* with the reason (a faint hydrogen-alpha region under a bare Bortle 5 sky is not a target until you put a filter on) — its longest run that is simultaneously up, forecast-clear and moon-workable, the sub length to shoot at with the reason (`15s × 1012 subs`: what the mount can hold, not what the sky would reward), and the sky class and filter every judgement was made against. Rows the sky cannot bring up stay listed and explained, and are visibly set aside rather than quietly dropped. Targets the library already holds, or that were suggested in the last few nights, are held back by their own score and named under the list ("Held back by memory: M 31 (shot until Dec 16, 1 d ago)") instead of silently vanishing. Below 760 px the plan becomes cards with each field labelled.
- **Database** searches and filters the whole object catalog: free-text search over every designation and common name, then type, catalog, constellation, magnitude, size, "named only", and "up now" / "up tonight" above a chosen altitude. Results can be sorted by match, name, brightness, size, current altitude, hours up tonight, best time or RA. Tap a result to see all its designations, tonight's altitude curve against your minimum altitude, Moon separation, and GoTo / ask-the-agent buttons. Your filters are remembered.
- **Night mode** (the sliders menu in the header, together with Disconnect) puts a red multiply tint over everything, including the live images, and is remembered.
- **Keyboard-safe**: the composer grows as you type, always ends above the keyboard, and its text is 16 px so iOS does not zoom the page when it is focused.
- **Tap targets** are floored at 44 px tall on touch layouts; secondary controls (the view buttons, header chips, small chips under tiles) sit at 38-42 px, and nothing at phone widths is smaller than a gloved fingertip.
- **Installable**: Add to Home Screen gives a standalone app (manifest + icons, `display_override` falls back to minimal-ui where window controls overlay is not implemented). It honours the notch and home indicator safe areas. Home-screen install and fullscreen need a secure context — plain HTTP on the LAN works fine in a browser tab; put a reverse proxy or Tailscale Serve in front for HTTPS.

## Stellarium tab

A planetarium ([Stellarium Web Engine](https://github.com/Stellarium/stellarium-web-engine)) with the sky as it is at your site: the observer is `OBSERVER_LATITUDE` / `OBSERVER_LONGITUDE` / `OBSERVER_ELEVATION_M` and the clock runs live in `OBSERVER_TIMEZONE`. −1h / +1h and the date field step through the night; **Now** goes back to live.

- **Search** any object the engine knows, or anything in the catalog (Sharpless regions and the rest are found through the Database and dropped on the map). Tap an object for its magnitude, position, and altitude and azimuth at the shown time.
- **GoTo** sends the telescope there (refused below 5° or for the Sun). A planet goes through the solar-system GoTo; a catalog object keeps its catalog label, so sessions shot from the map and from the app land in the same folder. **Ask the agent to image it** drafts the request in the chat.
- **Telescope FOV**: a dashed rectangle the size of the tele field (2.95° × 1.66°), turned the way an alt-az head frames it (north-up in EQ mode). The scope's own pointing is drawn in solid green while it is tracking or slewing, with the target's name; **Telescope** centres the view on it.
- **Framing**: press **Frame**, then drag the sky until the dashed rectangle holds the shot you want. The card shows how far the frame centre is from the object, and **GoTo frame** points at the frame centre while keeping the object's name for the session. The rectangle's rotation is an approximation; check the first frame.
- **Sky options**: the frame and wide-angle rectangles, your horizon obstructions and minimum altitude as a shaded mask, Tonight's targets as markers, constellations, atmosphere, deep-sky objects, DSS imagery (streaming only), azimuthal and equatorial grids, and the ground.
- **Sky** buttons on Tonight's rows and **View in Stellarium** in the Database open the target here, and the agent's `show_in_stellarium` tool can show you an object (at a given time) while you chat.

The engine is AGPL-3.0, vendored unmodified in `public/vendor/stellarium/` (source commit and licence there); `scripts/stellarium/build-engine.sh` rebuilds it.

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

### Freeing the SD card

Once a session is safe in the library you can delete it from the telescope to free space. The **Album** tab has a **delete** button on every tile, and the **Library** tab's "Sessions on the telescope" card has **Delete** on each session plus a **Delete transferred** button for the whole card at once. Both go through the device's own album delete (the same one the DWARFLAB app uses), which wipes the whole session package — every raw frame, the stack and the thumbnail — together with its album entry, so the freed space registers correctly. An astro tile deletes its whole session, not just the one image, and says so.

A session that is **not complete in the library** is refused, so you cannot delete data you never copied; the confirm and the server both guard it, and the UI offers to force it when you really mean to. The library copies are never touched — this only clears the card. (The agent has the same power through `delete_album_items`, but is told to use it only on files you name.)

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
| Motion & focus | `motors_home`, `motor_position`, `move_motors` (absolute/relative), `nudge`, `stop_motion`, `autofocus`, `star_sharpness`, `star_focus`, `focus_step`, `focus_position` (incl. infinity) |
| Planning | `sky_conditions`, `weather_forecast`, `sky_check`, `plan_targets`, `rest_target`, `find_target`, `search_catalog`, `map_obstructions` |
| Astro | `calibrate`, `goto_target`, `stop_goto`, `astro_recover`, `live_stacking`, `stacking_status`, `polar_alignment`, `track_sun_moon` |
| Daytime | `track_object`, `sentry_mode` |
| Duty | `duty` (the unattended night loop) |
| Images & data | `list_album`, `view_image`, `analyze_image`, `analyze_subs`, `dark_frames`, `delete_album_items`, `list_device_sessions`, `transfer_session`, `transfer_files`, `jobs`, `list_library` |
| Processing | `processing_status`, `process_session`, `processing_job` |

For debugging from a shell: `node dist/tools/smoke.js` lists the tools, and `node dist/tools/smoke.js <tool> '<json-args>'` calls one.

## ZWO Seestar (`TELESCOPE_DRIVER=seestar`)

The telescope protocol is a driver (`src/drivers/`): `dwarf` (the default) and `seestar`. `TELESCOPE_DRIVER` picks one at startup. The Seestar driver keeps its own data folder (`./data-seestar` unless `DATA_DIR` is set), agent prompt (`agent/drivers/seestar/`) and MCP server (`seestar`, so its tools reach the agent as `mcp__seestar__<tool>`). The driver changes only how Astrocontroller talks to the telescope: the web UI at `/` is the same page with the same tabs (Agent, Tonight, Stellarium, Database, Library, Skills, Log), live views, stacking bar, Aim/Focus/Polar/Camera groups, duty loop and agent. Each driver declares what its device can do, and a control the Seestar has no equivalent of is greyed out with a note saying so (the API answers it with 501): level, photo, burst, record, timelapse, astro autofocus and the star-focus search, shooting modes, the RGB light, the Album and SD-card sessions, the obstruction survey (import a horizon file instead) and the wire log. The live views come from the Seestar's RTSP streams (`rtsp://<host>:SEESTAR_RTSP_PORT/stream` for tele, default 4554, and `SEESTAR_WIDE_RTSP_PORT`, default 4555, for wide) and the stacked image from the image socket. **Home** opens the arm. The Dwarf's own background services (travel guard, stack supervisor, charge watch) do not run.

It speaks the Seestar's native protocol: JSON-RPC on TCP `:4700` (requests, replies and pushed events, with a `test_connection` heartbeat) and the image sockets `:4800` (tele) and `:4804` (wide) for stacked and preview frames. Firmware 7.18+ requires a signed handshake: set `SEESTAR_KEY_PATH` to the PEM private key extracted from your copy of the official app (seestarpy's `extract_pem`). The key is not shipped.

**Local network**: `SEESTAR_CONNECTION=local`, `SEESTAR_HOST=<the scope's IP>`.

**ZWO Telescope Network** (a remote scope, e.g. a hosted S30): `SEESTAR_CONNECTION=zwo`. [seestar-portfwd](https://github.com/Phaeilo/seestar-portfwd) logs in to the ZWO account, opens the ThroughTek Kalay P2P tunnel and forwards the scope's native services, so the same driver talks to it.

*In Docker* (the usual setup), seestar-portfwd runs as a second container, `seestar-portfwd`, from `docker-compose.yml`. Astrocontroller reaches it by name on the internal `seestar` network, so none of the telescope's ports have to be published on the host.

1. Clone seestar-portfwd next to this repository (or set `SEESTAR_PORTFWD_DIR` to your checkout).
2. In `.env`:
   - Set `TELESCOPE_DRIVER=seestar`, `SEESTAR_CONNECTION=zwo` and `COMPOSE_PROFILES=seestar`. The tunnel service only exists with that profile, so the Dwarf setup does not start it.
   - Set `SEESTAR_USER` and `SEESTAR_PASSWORD`, plus `SEESTAR_SN` when the account holds several scopes. Compose passes only these, and `SEESTAR_COUNTRY`, into the tunnel container.
   - Set `DATA_PATH=./data-seestar` to keep the Seestar agent's data apart from the Dwarf's.
3. `docker compose up -d --build`.

The tunnel container restarts by itself when the P2P session drops. `docker compose stop seestar-portfwd` ends it and releases the ZWO session. The app's Disconnect closes Astrocontroller's own links only, because it cannot stop another container. Astrocontroller counts the tunnel as up once the control port answers on the network.

To use the telescope from other software on the host as well (ASCOM Alpaca, RTSP in VLC, SSH, seestar-portfwd's `seestar_rpc.py`), add the optional `docker-compose.seestar-ports.yml`: `COMPOSE_FILE=docker-compose.yml:docker-compose.seestar-ports.yml` in `.env`.
- Each service has its own host-port variable (`SEESTAR_PUBLISH_RPC_PORT`, `SEESTAR_PUBLISH_ALPACA_PORT`, …), and `SEESTAR_PUBLISH_ADDR` sets the address they bind to (default `127.0.0.1`).
- Delete the lines of services you do not want exposed.
- The device's port 80 is published as 8081, so it does not collide with the web UI.
- The services are unauthenticated: publish them beyond loopback only on a network you trust.

*Without Docker*, run seestar-portfwd yourself (`docker compose run --service-ports --rm seestar` in its checkout). Its ports are on `127.0.0.1`, and its port 80 becomes 8080, which is `WEB_PORT`'s default, so change one (startup reports the clash).

Alternatively, set `SEESTAR_TUNNEL_COMMAND` (and `SEESTAR_TUNNEL_CWD`) so Astrocontroller starts the tunnel, restarts it when it exits, and stops it with SIGINT, which releases the remote session. A managed tunnel counts as up once it has printed `tunnel ready` and the forwarded port answers.

Only one remote session exists per telescope: the official app connecting takes it over (and the other way round). The `zwo_devices` tool lists the account's scopes and whether each is online, shooting or occupied.

Seestar tools: `seestar_status`, `seestar_connect`, `seestar_disconnect`, `zwo_devices`, `tunnel_status`, `tunnel_restart`, `sync_time_location`, `find_target`, `goto_target` (slew + plate solve + centre, optional `stack`), `stop`, `nudge`, `park`, `open_arm`, `plate_solve`, `polar_align`, `start_stacking`, `stop_stacking`, `start_live_view`, `autofocus`, `move_focuser`, `set_exposure`, `set_gain`, `set_dither`, `get_settings`, `set_settings`, `get_image`, `plan_targets`, `power`, `raw_rpc`. The shared tools come with them: duty, Stellarium, sky conditions and weather, the catalog and plan helpers, and the library (without the Dwarf's SD-card transfer tools and wide-camera `sky_check`).

The Seestar driver is tested against a simulated scope only; it has not yet run against real hardware.

## How it talks to the telescope

- **Control**: WebSocket `:9900`, protobuf `WsPacket`s. The protobuf definitions, packet codec and command registry come from [`@alikh/dwarflab-sdk`](https://github.com/alikh31/dwarflab-sdk) (MIT). `src/drivers/dwarf/protocol.ts` adds commands and message variants the SDK lacks (motor run-to/reset/position, one-click GoTo `goto_only`, EQ solving results, …), and the firmware error table comes from [`dwarf_python_api`](https://github.com/stevejcl/dwarf_python_api) (MIT).
- **Live views**: RTSP `:554/ch0|ch1/stream0` (H.265 1080p30) → ffmpeg → MJPEG, on demand. **Stack preview**: the scope's own MJPEG on `:8092/mainstream`.
- **HTTP** `:8082`: device info, album, and the per-mode parameter schema (exposure tables, gain lists, param IDs). **Files**: HTTP `:80` and anonymous FTP `:21`.
- **Catalog**: about 45,000 objects in `catalog/objects.tsv`, built by `npm run catalog` (`src/tools/build-catalog.ts`). The sources are [OpenNGC](https://github.com/mattiaverga/OpenNGC) (CC-BY-SA 4.0) and these VizieR catalogs: Sharpless, LBN, Cederblad, RCW, van den Bergh, Barnard, LDN, Strasbourg-ESO planetary nebulae, Green SNRs, Dias open clusters, Harris globulars, RC3 galaxies, Arp, Hickson, Abell clusters and the Bright Star Catalogue. The IAU star names are added, plus a user-editable nickname table (`catalog/nicknames.csv`). An object listed in several catalogs is merged into one entry with all its designations. Merging matches designations and cross-identifications first, then position and size for extended objects. `catalog/sources.json` lists each source, with its citation and how many records it added or merged; the Database tab shows the same list. GoTo coordinates are J2000, which I verified against coordinates the DWARF app recorded on this device.
- **Weather**: [Open-Meteo](https://open-meteo.com) (clouds by layer, rain, wind, dew point) + [7Timer!](https://www.7timer.info) (seeing and transparency). Each fetch gets three attempts under a deadline (a first call after a spell of silence can stall in DNS/TCP for tens of seconds and then answer in under one), callers share one refresh, and the last good forecast is kept for 12 h and served with its age while it is retried in the background — so a bad second on the field connection costs you an amber "cached N min ago" on the Tonight tab instead of an empty card.

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

**Implemented from the protocol, not yet run against the sky** (I validated indoors, so no stars): plate-solve `calibrate`, `goto_target` / one-click GoTo, real live-stacking captures, astro autofocus, `polar_alignment` (EQ solving), sentry mode, Sun/Moon tracking, timelapse, and the new star-focus pair. `star_sharpness` is checked against synthetic star fields (PSF accuracy, invariance to exposure, gain, sky glow and frame size, same reading from any crop of the same sky, sensitivity to trailing, rejection of hot pixels and flat placeholder frames) and the `star_focus` sweep against a simulated focuser with a known optimum (peak search, the between-samples fit, camera restore, failures, the one-at-a-time lock); neither has seen the real sky yet. The first clear night will exercise these, and the agent is told to record what it learns in its skills.

Firmware quirks found along the way: several commands are acted on but never acknowledged (single-step focus, track start, RGB/power), motor run-to replies only when the motion completes, and a forced stack without GoTo is preview-only (no FITS saved). These are all handled in code.

## Development

```bash
npm install && npm run build
node --env-file=.env dist/index.js     # needs ffmpeg; set AGENT_ENABLED=false if omp isn't installed
npm run catalog                        # rebuild catalog/objects.tsv (downloads cached in catalog/.cache; --fresh to re-download)
```

The web UI is `public/` served as-is: no build step for HTML/CSS/JS changes, just reload.
