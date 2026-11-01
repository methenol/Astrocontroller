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
| `UNITS` | `metric` (°C, km/h, mm, km; the default) or `imperial` (°F, mph, in, mi): how weather is shown in the UI, the Rain Guard alarms and the night report. Settings are stored in metric either way. |
| `UNITS` | `metric` (°C, km/h, mm, km; the default) or `imperial` (°F, mph, in, mi): how weather is shown in the UI, the Rain Guard alarms and the night report. Settings are stored in metric either way. |
| `PLAN_MIN_ALTITUDE_DEG` | Default minimum altitude for target planning. |
| `PLAN_BORTLE` | Site sky class 1 (dark) … 9 (inner city), default `5`. The one number that moves every reachability threshold: what the sky and glass can bring up, and how long a sub the sky rewards. |
| `PLAN_FILTERS` | The Dwarf 3's filters, default `Astro,Duo-Band`. Each target is planned through the best of them (continuum targets through Astro only) and `suggestedFilter` names it. Decides whether a faint hydrogen-alpha region is a target at all, and how much the Moon costs it. |
| `PLAN_FILTER` | Force one glass for every target instead (`none`, `astro`, `uhc`, `duo-band`, `ha 7nm`, a product name…); empty = `PLAN_FILTERS`. |
| `PLAN_APERTURE_MM` | Clear aperture of the tele lens. The one optics number the scope cannot report; without it the sub advice is the mount's ceiling, with the missing number named. |
| `PLAN_READ_NOISE_E` | Camera read noise in electrons. With it the sub length is one number; without it the plan quotes the honest range from a modern sensor to an old one. |
| `PLAN_MOUNT` / `PLAN_GUIDED` | `alt-az` (default) or `eq`; guided or not. Sets what trails and how soon: field rotation on an alt-az head, the trails budget on an unguided equatorial, nothing when guided. |
| `PLAN_PLATE_SCALE_ARCSEC` | Arcsec per pixel; the telescope's own plate scale is used when unset. |
| `PLAN_DEVICE` | Force the capture planner's device spec by id (`dwarf-3`, `dwarf-mini`, `seestar-s30`, `seestar-s30-pro`, `seestar-s50`, `seestar-s50-pro`, or your own); empty = picked from what the scope reports. See [Capture settings](#capture-settings-filter-gain-sub-length-and-integration). |
| `PLAN_SKY_SQM` | The site's zenith sky from a sky meter (mag/arcsec²). Wins over the rig's measured sky and over `PLAN_BORTLE`. |
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

- **Disconnect / Connect** releases the telescope without stopping the container. It closes the control link, the video readers and the stack preview, cancels transfers, and refuses every command until you press Connect (e.g. to use the DWARFLAB app). Over ZWO Telescope Network it also tells the tunnel container to release the scope's single remote session, and Connect asks for it back (*The tunnel session* below). It survives a restart. On a phone it is in the ⋯ menu; at desk widths it sits in the top bar.
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

## Plan tab: the night, solved for your program

The **Program** is what you want collected: targets with an integration goal and a priority (1 low … 5 top), plus an optional filter, minimum altitude, "not before" date, "keep collecting after the goal", and a note for the agent. **Find targets** filters the catalog by type, frame fill, magnitude and size: matching targets can be added with one click, and the same filter picks the plan's **fillers** for hours none of your targets can use.

Every night is solved into **blocks** from astronomical dusk to dawn (`src/night/solver.ts`), a dispatch scheduler over 10-minute slots. Each target's merit in a slot is the product of:
- **altitude** above the plan's minimum, its own, and the site's obstruction map (and tonight's blocked views), weighted by airmass;
- **field rotation** near the zenith on an alt-az mount;
- **the Moon**: Lorentzian avoidance (the separation required shrinks away from full Moon; wide for broadband, tight for a line filter) and what moonlight leaves of the target through its filter;
- **the forecast**: hours below the floor are not scheduled; poor seeing costs galaxies and planetaries most, poor transparency costs broadband most.

Targets are valued by priority, by how far they are from their goal, and by how fast their **season** is closing (their usable time over the next 90 nights against what they still need). The one about to set comes first, and the running target is kept unless another is clearly better. A switch costs the **overhead** (GoTo, centring, focus), and only a share of stacking time becomes integration (the **efficiency**). Both are learned from the journal. Each block lists **alternates** in other quadrants of the sky; each program target says what tonight adds and why it is or is not on the plan, with its season and the clear nights it still needs.

The rest of the night is solved again when the forecast updates, a session ends, a hold is set or runs out, the program or settings change, and every half hour. The past is kept as it was. **Holds** come from the night itself:
- **obstructed**: the view is filed for the horizon, and the target is held until its own path takes it clear (rising out of an obstruction in the east, out for the night when it sets behind one in the west);
- **clouded**: held for a while, then tried again;
- **skip** for tonight, **pin** to a time, or a **cloud bank** in one quadrant.

Every duty sample carries the plan's line: what to do now, whether the scope is on plan, alternates, holds, a refocus that is due, a stack that is rejecting. **Run tonight's plan** starts the plan's duty by hand. **Run the plan every night** (on by default) starts it at the plan's start each night, for a scope left out for weeks. Starfront's autonomous nights do this themselves: the roof opening before dark has the agent connect, raise the arm, verify the sky, then park and disconnect; the night's duty starts `STARFRONT_CONNECT_LEAD_MIN` (25) minutes before dark, and its first step is to connect again (5–10 min over ZWO). The roof closing has it stop, park, transfer and disconnect once the transfers are done, and so does dawn. While the mode is on, a released scope does not hold the agent's duty samples. The agent's tools are `night_plan`, `plan_program` and `journal`. The Stellarium tab's **night plan** option draws the scheduled targets with their times, the night's path, and the frame on the plan's target at the sky's clock.

## Capture settings: filter, gain, sub length and integration

For every block of the night plan (the **Capture** line in the Plan tab, `capture` in `night_plan`) and on demand (`acquisition_plan action=advise target=…`), the planner in `src/astro/acquisition/` works out the filter, gain, sub length and frame count that collect the most signal-to-noise per hour of the night on **this** telescope, and how much integration the target needs (hours to a detection, a clean and a deep picture, and what tonight adds to what is collected).

It scores every filter × gain × sub length the device offers over the target's window, sampled every 15 minutes, with the CCD equation per Bayer cell: the target's electrons (its catalog surface brightness, through the filter: a line filter keeps an emission nebula's lines and cuts a galaxy as hard as the sky), the sky's (the site's zenith sky brightened by airmass and by the Moon's scattered light, Krisciunas & Schaefer 1991; extinction from the forecast's transparency), dark current and read noise, the per-sub overhead and the dither cost, and the share of subs the stacker keeps (learned from the journal per sub length). A sub length loses the samples it cannot hold:
- **trailing**: alt-az field rotation from the actual pointing (corner trail ≤ max(3 px, the stars' FWHM)), the unguided-EQ drift budget, wind on an alt-az head;
- **overexposure**: the sky may fill at most 25% of the range above black; a target core predicted to clip costs the candidate merit;
- **darks**: on a Dwarf, only exposure/gain pairs that have a dark master on the scope.
Near-ties go to the safer side (more headroom, then the shorter sub), and the answer says what bound it, with the alternatives and where every number came from. Owner-given settings are held and predicted instead (`filter`, `gain`, `sub_s`).

**Devices.** One spec file per model in `devices/` (Dwarf 3, Dwarf Mini, Seestar S30, S30 Pro, S50, S50 Pro, with sources); add or correct a model by dropping a file into `<DATA_DIR>/devices/` (`devices/README.md` has the fields). What the connected scope reports overrides the spec: its model, optics, EQ mode, stack gain, filter wheel, the exposures and gains it offers (a Seestar's 90/120 s only with `more_exposure`), its dark masters. `acquisition_plan action=device` shows the rig and what is still a guess; `action=devices` lists the models.

**Measurements.** `acquisition_measure` turns the rig's own raw frames into the numbers the spec can only guess, deterministically (robust statistics on one green phase of the mosaic) and stores them in `<DATA_DIR>/acquisition.json`: `sensor` (dark frames: read noise, offset, dark current), `sky` (light subs: e⁻/ADU by photon transfer, the clip level, the sky in mag/arcsec² and the zenith moonless sky it implies, the stars' FWHM, the session's cadence and dither cost), `check` (the same on a running session, with a verdict: keep, shorten, lengthen, refocus). Three trusted sky cohorts (Moon down, target above 35°, astronomical dark) replace `PLAN_BORTLE` with the measured sky. The agent's `acquisition-calibration` skill is the procedure.

## Journal tab

Each night's journal is recorded from the telescope's state, whatever starts the work (the agent, the web UI, the scope). It works for the Dwarf and the Seestar alike, through a small per-driver probe (`drivers/<id>/journal.ts`). Per target visit it records:
- a timeline: GoTo and the time to get on target, autofocus and fine focus with the position they ended on, stack start, rejection bursts, stack end, link drops, notes;
- statistics: frames kept and rejected, integration, efficiency, sub length, gain and filter, altitude, the Moon, the forecast sky, and the stack's stars, HFR and background;
- a sparkline of the stack over time.

The night's events (duty, roof, plan changes, holds, what the agent was woken for) and **notes**, yours and the agent's, are kept with it. The agent reads and writes them with its `journal` tool. Files: `DATA_DIR/journal/<night>.json`; the plan is in `DATA_DIR/plan/` (`program.json`, `settings.json`, `nights/<night>.json`).

## Stellarium tab

A planetarium ([Stellarium Web Engine](https://github.com/Stellarium/stellarium-web-engine)) with the sky as it is at your site: the observer is `OBSERVER_LATITUDE` / `OBSERVER_LONGITUDE` / `OBSERVER_ELEVATION_M` and the clock runs live in `OBSERVER_TIMEZONE`. −1h / +1h and the date field step through the night; **Now** goes back to live.

- **Search** any object the engine knows, or anything in the catalog (Sharpless regions and the rest are found through the Database and dropped on the map). Tap an object for its magnitude, position, and altitude and azimuth at the shown time.
- **GoTo** sends the telescope there (refused below 5° or for the Sun). A planet goes through the solar-system GoTo; a catalog object keeps its catalog label, so sessions shot from the map and from the app land in the same folder. **Ask the agent to image it** drafts the request in the chat.
- **Telescope FOV**: a dashed rectangle the size of the tele field (2.95° × 1.66°), turned the way an alt-az head frames it (north-up in EQ mode). The scope's own pointing is drawn in solid green while it is tracking or slewing, with the target's name; **Telescope** centres the view on it.
- **Framing**: press **Frame**, then drag the sky until the dashed rectangle holds the shot you want. The card shows how far the frame centre is from the object, and **GoTo frame** points at the frame centre while keeping the object's name for the session. The rectangle's rotation is an approximation; check the first frame.
- **Sky options**: the frame and wide-angle rectangles, your horizon obstructions and minimum altitude as a shaded mask, Tonight's targets as markers, the night plan (scheduled targets with their times, the night's path, and the frame on the plan's target at the shown time), constellations, atmosphere, deep-sky objects, DSS imagery (streaming only), azimuthal and equatorial grids, and the ground.
- **Sky** buttons on Tonight's rows and **View in Stellarium** in the Database open the target here, and the agent's `show_in_stellarium` tool can show you an object (at a given time) while you chat.

The engine is AGPL-3.0, vendored unmodified in `public/vendor/stellarium/` (source commit and licence there); `scripts/stellarium/build-engine.sh` rebuilds it.

## Weather tab: can the telescope stay out tonight?

The Tonight tab asks whether the sky is good. The Weather tab asks whether it is **safe to leave the telescope outside**, unattended, until morning.

- **Rain Guard** is a next-hour alarm for precipitation, storms and wind. **Arm** it before you go to bed. The server checks the Open-Meteo 15-minute forecast every 3 minutes, so the guard keeps watching with every page closed and stays armed after a restart. It looks at the telescope's site and at a ring of 8 points around it (20 km by default).
  - **Alarm**: any precipitation at the site within the look-ahead (rain, showers and snow), precipitation falling now, an hourly chance of 60 % or more, a thunderstorm at the site or anywhere in the ring, or gusts over the limit (45 km/h).
  - **Watch**: precipitation in the ring that has not reached the site yet, or gusts near the limit.
  - **Fault**: if no check has succeeded for 12 minutes, the guard sounds a different alarm. A guard that has stopped looking must not stay quiet.
  - **Silence alarm** silences every device. If the danger lasts 20 minutes, or a new kind of danger appears, the alarm sounds again. An alarm nobody silenced keeps sounding even if the forecast clears.
  - All thresholds are in **Alarm settings**.
- **This device sounds the alarm**: the guard is on the server, but the sound comes from the devices that listen. Arming from a device makes that device listen. While armed, a listening device keeps its screen on (wake lock) and shows a notification if it is in the background. If it loses contact with the server for 90 s, it sounds the fault alarm on its own. Use **Test sound** where you sleep, and leave the page open on a powered device. Wake lock and notifications need HTTPS or `localhost`. Over plain `http://` to a LAN address, keep the screen on yourself.
- **Tonight at the telescope** is an hour-by-hour report from sunset to sunrise. It covers precipitation, thunderstorms and unstable air (CAPE), gusts, cold below the limit (−20 °C by default, the Dwarf 3's operating minimum), frost, fog and condensation. The verdict is one line: safe all night, safe with care, or *bring it in by HH:MM*.
- **Radar & satellite**: RainViewer radar for the last 2 hours, and NASA GIBS infrared cloud tops (GOES-East/West or Himawari, picked by longitude) for the last hour. Both are looped around the site. The base map is Esri's dark grey canvas. None of these sources needs an API key. No geostationary infrared layer covers Europe, Africa or western Asia on GIBS, so those sites get radar only.

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
- `rain-guard.json`: the Rain Guard's armed state and alarm settings.

Seeded skills: `session-startup`, `deep-sky-imaging`, `acquisition-profiles`, `session-qc`, `dark-library`, `acquisition-experiments`, `target-planning`, `cloud-gap-imaging`, `polar-alignment`, `daytime-wildlife`, `solar-system`, `image-assessment`, `data-management`, `skill-writing`.

## MCP tools

The MCP endpoint is `http://<host>:8080/mcp` (Streamable HTTP, stateless). Other MCP clients can use it too.

| Area | Tools |
|---|---|
| Status/system | `telescope_status`, `telescope_device_info`, `telescope_reconnect`, `sync_time_and_location`, `power`, `raw_command` |
| Camera | `set_shooting_mode`, `get_camera_settings`, `set_camera_setting`, `take_photo`, `video_recording`, `timelapse`, `view_camera` |
| Motion & focus | `motors_home`, `motor_position`, `move_motors` (absolute/relative), `nudge`, `stop_motion`, `autofocus`, `star_sharpness`, `star_focus`, `focus_step`, `focus_position` (incl. infinity) |
| Planning | `sky_conditions`, `weather_forecast`, `sky_check`, `plan_targets`, `rest_target`, `find_target`, `search_catalog`, `map_obstructions`, `acquisition_plan`, `acquisition_measure` |
| Astro | `calibrate`, `goto_target`, `stop_goto`, `astro_recover`, `live_stacking`, `stacking_status`, `polar_alignment`, `track_sun_moon` |
| Daytime | `track_object`, `sentry_mode` |
| Duty | `duty` (the unattended night loop) |
| Images & data | `list_album`, `view_image`, `analyze_image`, `analyze_subs`, `dark_frames`, `delete_album_items`, `list_device_sessions`, `transfer_session`, `transfer_files`, `jobs`, `list_library` |
| Processing | `processing_status`, `process_session`, `processing_job` |

For debugging from a shell: `node dist/tools/smoke.js` lists the tools, and `node dist/tools/smoke.js <tool> '<json-args>'` calls one.

## ZWO Seestar (`TELESCOPE_DRIVER=seestar`)

The telescope protocol is a driver (`src/drivers/`): `dwarf` (the default) and `seestar`. `TELESCOPE_DRIVER` picks one at startup. The Seestar driver keeps its own data folder (`./data-seestar` unless `DATA_DIR` is set), agent prompt (`agent/drivers/seestar/`) and MCP server (`seestar`, so its tools reach the agent as `mcp__seestar__<tool>`). The driver changes only how Astrocontroller talks to the telescope: the web UI at `/` is the same page with the same tabs (Agent, Tonight, Stellarium, Database, Library, Skills, Log), live views, stacking bar, Aim/Focus/Polar/Camera groups, duty loop and agent. Each driver declares what its device can do; a control a telescope has no equivalent of is greyed out with a note saying so (the API answers it with 501). On the Seestar that is only recording the wide camera. Everything else maps onto the Seestar:

- **Live views**: the app's model. The scope runs a star view for the whole session and pushes the selected camera's exposure as a JPEG on its image socket (tele `:4800`, wide `:4804`) every `exp_ms.continuous` (1 s). Idle, the camera is set to bin 2 (`set_camera_bin`, the firmware's ceiling), so the preview is a 1080×1920 JPEG every second: enough to get on target and watch the scope, and the browser copy is scaled by `LIVE_STREAM_WIDTH`. Anything that works from the frames (a photo, a focus measurement, a stack, a GoTo's solve) puts the camera at bin 1 first and the preview bin comes back afterwards; while stacking, the tele view shows the live stack. The streams are never stopped while connected (its RTSP streams `:4554`/`:4555` carry nothing in star mode and are not used).
- **Camera selection** is explicit and sticky: the camera in the browser's main view (or the one `select_camera` / the Camera control asks for) is the one the scope exposes with, and nothing else changes it: panning, photos and the state polls leave it alone. The other view's thumbnail says which camera is selected and how to switch. An operation that works from the tele (GoTo, plate solve, autofocus, polar alignment, stacking) borrows the tele for its duration and the wide comes back when it ends; a wide photo or a wide `get_image` while the tele is selected borrows the wide the same way. While a stack runs, the stack owns the view (the tele), and a wide selection is honoured when the stack stops. The scope is busy from the moment an operation is asked for, through its camera switch, and **Stop** (the web button, or the `stop` tool) ends whatever runs: a hand move, a GoTo, autofocus, polar alignment, a stack, including an operation still switching cameras, which then never starts.
- **Nudging** is the app's joystick: `scope_speed_move {angle, percent, level 1, dur_sec 3}` renewed every 200 ms while the arrow is held (or for the `nudge` tool's `seconds`), then the stop; `percent` is the stick's throw (50 ≈ 2.7°/s), `angle` 0 right, 90 up, 180 left, 270 down in the camera's frame. Requests wait 20 s for an answer like the app, 60 s for a view to start or stop, and the control link is kept alive with the app's 2 s heartbeat.
- **Home** opens the arm; **Level** reads the tilt sensor (on an EQ wedge, 90° minus the latitude it is set for). **Modes**: Normal = scenery, DSO = star, Moon, Planet; Sun is refused remotely (nobody can check the solar filter). **RGB** is the indicator light.
- **Photo / Burst / Timelapse**: the Seestar has no photo command, so a photo is the live frame in colour (JPEG) plus, for tele, the raw Bayer frame from the image socket (16-bit FITS), saved under `<library>/_photos/<date>/`; a timelapse is assembled into an MP4 there. **Record** records the tele camera onto the scope (`MyWorks/Scenery_video`).
- **Star tune** sweeps the focuser on raw tele subs and stops on the sharpest; the astro autofocus is the Seestar's own (it is star-based).
- **Obstruction survey**: the Seestar slews (no plate solve) to every 20° of azimuth at rising altitudes and judges the centre of the wide frame against a sky reference taken high up, stopping in each direction at the first clear sky; the map is saved for the site as the Dwarf's is. Night only, and the sky reference must show stars, so it refuses under a closed roof or cloud rather than map the roof. (The Dwarf stitches a panorama from its motor model; an EQ-mounted Seestar turns each frame by its field angle, which only the sky can calibrate, so it judges frame centres.)
- **Album, sessions, transfers**: see *Seestar storage* below. **Wire** logs the JSON-RPC traffic. The stack supervisor (a stack that rejects every frame, or gets none, is reported and stopped after `STACK_AUTOSTOP_MIN`) runs as on the Dwarf; the travel guard and charge watch are the Dwarf's own (a hosted scope is neither carried nor charged).

It speaks the Seestar's native protocol: JSON-RPC on TCP `:4700` (requests, replies and pushed events, with a `test_connection` heartbeat) and the image sockets `:4800` (tele) and `:4804` (wide) for stacked and preview frames. Firmware 7.18+ requires a signed handshake: set `SEESTAR_KEY_PATH` to the PEM private key extracted from your copy of the official app (seestarpy's `extract_pem`). The key is not shipped.

**Local network**: `SEESTAR_CONNECTION=local`, `SEESTAR_HOST=<the scope's IP>`.

**ZWO Telescope Network** (a remote scope, e.g. a hosted S50 Pro): `SEESTAR_CONNECTION=zwo`. [seestar-portfwd](https://github.com/Phaeilo/seestar-portfwd) logs in to the ZWO account, opens the ThroughTek Kalay P2P tunnel and forwards the scope's native services, so the same driver talks to it. It is vendored here in `seestar-portfwd/` (GPLv3, LICENSE alongside it) and built by `docker-compose.yml`.

*In Docker* (the usual setup), seestar-portfwd runs as a second container, `seestar-portfwd`, from `docker-compose.yml`. Astrocontroller reaches it by name on the project's network, so none of the telescope's ports have to be published on the host. The tunnel container is on that one network only. Inside it a **supervisor** (`seestar-portfwd/src/supervisor.py`) owns the tunnel process and the telescope's single remote session: the container starts idle, Astrocontroller's **Connect** asks it to take the session and **Disconnect** gives it back, and it reconnects a dropped session by itself. See *The tunnel session* below.

**The ThroughTek SDK.** The Seestar app ships two sets of the P2P libraries; the current app (3.4.1) loads the `T` set (`libIOTCAPIsT.so`, …). `docker-compose.yml` builds seestar-portfwd with `TUTK_SUFFIX=${SEESTAR_TUTK_SUFFIX:-T}`, which needs the checkout to carry that build option (the vendored one does) and the `T` libraries in `tunnel_libs/` (from your copy of the app, `config.armeabi_v7a.apk`). The tunnel's first `Connect_Ex` can still fail (`-42`, `-60`), notably while the rendezvous server and the scope sort out who held the last session: the tunnel asks again on the spot, and the supervisor restarts it on the **same** session before giving it back and backing off — handing the session back and allocating a fresh one is what turns a single `-42` into a string of them, and minutes of "not connecting". Prefer the app's Disconnect (or `docker compose stop seestar-portfwd`) over `docker rm -f`, which cannot release anything.

1. Nothing to clone: seestar-portfwd is in `seestar-portfwd/` (`SEESTAR_PORTFWD_DIR` points `docker-compose.yml` at another checkout if you must). Build it with the ThroughTek SDK set the current Seestar app loads (*The ThroughTek SDK* above, `SEESTAR_TUTK_SUFFIX`): the set upstream ships fails to connect to an S50 Pro on firmware 9.75 (`Connect_Ex failed: -42`).
2. In `.env`:
   - Set `TELESCOPE_DRIVER=seestar`, `SEESTAR_CONNECTION=zwo` and `COMPOSE_PROFILES=seestar`. The tunnel service only exists with that profile, so the Dwarf setup does not start it.
   - Set `SEESTAR_USER` and `SEESTAR_PASSWORD`, plus `SEESTAR_SN` when the account holds several scopes. Compose passes only these, and `SEESTAR_COUNTRY`, into the tunnel container.
   - Set `DATA_PATH=./data-seestar` to keep the Seestar agent's data apart from the Dwarf's, and `LIBRARY_PATH` to your library (it can be the Dwarf's).
   - Set `SEESTAR_KEY_PATH=/data/seestar.pem` and put the handshake key there (`DATA_PATH/seestar.pem`).
3. `docker compose up -d --build`.

**The tunnel session.** A Seestar serves one remote session, so the tunnel container holds exactly one and gives it back: `docker compose stop seestar-portfwd` ends it and releases the ZWO session, and so does the app's **Disconnect**, which now reaches the container (`POST /disconnect` on port 4710: stop the port mappings, abort and disconnect the SDK sessions, then `device-p2p/stop` for the conId). **Connect** (`POST /connect`) takes it again — the status chip says `opening the ZWO tunnel…` while the P2P session comes up. The container also refuses to open a second one while it holds a session, releases a session a crashed run left behind before allocating a new one, and hands the scope back on its own if Astrocontroller disappears without releasing it (`SEESTAR_TUNNEL_LEASE_S`): a controller that died cannot leave the telescope occupied. Astrocontroller counts the tunnel as up when the supervisor reports its session ready and the control port answers.

To use the telescope from other software on the host as well (ASCOM Alpaca, RTSP in VLC, SSH, seestar-portfwd's `seestar_rpc.py`), add the optional `docker-compose.seestar-ports.yml`: `COMPOSE_FILE=docker-compose.yml:docker-compose.seestar-ports.yml` in `.env`.
- Each service has its own host-port variable (`SEESTAR_PUBLISH_RPC_PORT`, `SEESTAR_PUBLISH_ALPACA_PORT`, …), and `SEESTAR_PUBLISH_ADDR` sets the address they bind to (default `127.0.0.1`).
- Delete the lines of services you do not want exposed.
- The device's port 80 is published as 8081, so it does not collide with the web UI.
- The services are unauthenticated: publish them beyond loopback only on a network you trust.

*Without Docker*, run seestar-portfwd yourself (`docker compose run --service-ports --rm seestar` in `seestar-portfwd/`; `compose.yaml` there sets `SEESTAR_TUNNEL_AUTOSTART=1`, so it connects at once, and publishes the supervisor on `127.0.0.1:4710`). Its ports are on `127.0.0.1`, and its port 80 becomes 8080, which is `WEB_PORT`'s default, so change one (startup reports the clash).

Alternatively, set `SEESTAR_TUNNEL_COMMAND` (and `SEESTAR_TUNNEL_CWD`) so Astrocontroller starts the tunnel, restarts it when it exits, and stops it with SIGINT, which releases the remote session. A managed tunnel counts as up once it has printed `tunnel ready` and the forwarded port answers.

Only one remote session exists per telescope: the official app connecting takes it over (and the other way round). The supervisor serialises this on its side (`SEESTAR_TUNNEL_LOCK`) and reports what the scope says about itself, so `tunnel_status` shows `SHOOTING`/`OCCUPIED` when somebody else has it. The `zwo_devices` tool lists the account's scopes and whether each is online, shooting or occupied.

Seestar tools: `seestar_status`, `seestar_connect`, `seestar_disconnect`, `zwo_devices`, `tunnel_status`, `tunnel_restart`, `sync_time_location`, `find_target`, `goto_target` (slew + plate solve + centre, optional `stack`), `stop`, `nudge`, `park`, `open_arm`, `plate_solve`, `polar_align`, `start_stacking`, `stop_stacking`, `start_live_view`, `autofocus`, `move_focuser`, `set_exposure`, `set_gain`, `set_dither`, `get_settings`, `set_settings`, `get_image`, `plan_targets`, `power`, `raw_rpc`. The shared tools come with them: duty, Stellarium, sky conditions and weather, the catalog and plan helpers, and the library (without the Dwarf's SD-card transfer tools and wide-camera `sky_check`).

Verified on a Seestar S50 Pro (firmware 9.75) over ZWO Telescope Network (last full pass 2026-10-31, through the web UI's own video socket and control API): connection and handshake, live views on both cameras (tele 1 fps, wide ~0.5 fps at bin 2 over the tunnel), camera selection from the main view and its persistence through held-arrow panning, photos on both cameras (the wide restored after a tele photo), stacking (started and stopped with the wide selected), autofocus and GoTo borrowing the tele and giving the wide back, Stop ending an autofocus during its camera switch and once running (`autofocus cancel`), GoTo stop, `get_image` on either camera, Home and Park, the album, recording, timelapse, modes, nudging, focusing, slews, transfers into the library and processing. The obstruction survey's refusals are verified; its sweep needs a dark sky and an open roof.

The driver (`src/drivers/seestar/`): `link.ts` (the JSON-RPC control socket, handshake, heartbeat, reconnect), `frames.ts` (the picture-socket frame format, ZIP/raw/JPEG payloads, debayer), `image-link.ts` (one persistent picture socket per camera: the live stream, stacked and current frames), `model.ts` (the state folded from replies and events: views, stack, operations, pointing), `device.ts` (the Seestar as one object: selection, operations, joystick, focus, stacking, stop), `hub.ts` (the video sources the web UI subscribes to), `storage.ts` (the scope's files for the library), `capture.ts` / `focus.ts` / `survey.ts` / `duty.ts` (photos and timelapses, star tune, the obstruction survey, the duty loop), `web.ts` and `mcp*.ts` (the web controls and the MCP tools), `tunnel.ts` / `zwo-cloud.ts` / `auth.ts` (the ZWO tunnel supervisor, the account API, the handshake key). Tests: `src/test/seestar-*.test.ts` against `src/test/fake-seestar.ts` (a Seestar on loopback with the firmware's star session, both picture ports and the handshake).

The agent has the Dwarf's tools under the same names (`telescope_status`, `take_photo`, `view_image`, `transfer_session`, `star_focus`, `move_motors`, `map_obstructions`, …), carried out with the Seestar, next to its own (`seestar_status`, `goto_target`, `raw_rpc`, …). `track_object` and `sentry_mode` say why they are not available: the Seestar's object tracking takes the id of an object its own detection found, which it does not report.

### Seestar storage

The scope keeps its images in `/boot/Image` and serves them over HTTP (port 80; `SEESTAR_HTTP_PORT`). Its file listing is a JSON-RPC call that is stateful on the scope (`get_img_file_page_number` selects the folder, `get_img_file_page_name` pages through it), so Astrocontroller lists one folder at a time.

A target's subs pile up in one folder however many nights it is shot (`MyWorks/<target>_sub/Light_<target>_<exp>s_<filter>_<YYYYMMDD-HHMMSS>.fit`, the scope's local time), with its stacks beside it (`MyWorks/<target>/Stacked_<n>_…`). Astrocontroller splits them into sessions, one per target, camera, sub length, filter and night (noon to noon), named like the Dwarf's so the library, pooling and processing take them unchanged:

    SEESTAR_RAW_TELE_M 31_EXP_60_GAIN_200_2026-10-27-21-51-23_IRCUT

A transfer copies the night's subs and stacks into that folder of the library (resuming a partial file, checking each against the scope's exact size) and the scope's master dark for the sub length (`darklibrary/<exp>s/`) into `CALI_FRAME/dark/seestar_cam_0`; processing in AstroPhoto Studio then queues itself as for the Dwarf. Deleting a session deletes its subs and stacks on the scope (only once it is fully in the library, unless forced). The Seestar and the Dwarf can share one `LIBRARY_PATH`: their sessions are named apart, and the Seestar's masters are kept in `seestar_cam_0|1`, so neither telescope's darks are applied to the other's lights.

The album lists the stacks (as colour images; a stack's FITS is rendered for the browser), the videos and any photos on the scope.

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
