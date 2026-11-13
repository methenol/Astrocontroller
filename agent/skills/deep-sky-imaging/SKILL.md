---
name: deep-sky-imaging
description: End-to-end deep-sky capture with live stacking — choosing settings, calibration, GoTo, focus, test frames, monitoring, stopping and wrapping up.
---
# Deep-sky imaging workflow

**At night the system prompt's procedures run the capture: P1 (no stack), P2 (every target), P3 (obscured), P4 (while stacking), P5 (target change), P8 (duty end). This skill adds detail for housekeeping time; where it differs from P1–P8, P1–P8 win.**

## 0. Before dark
- `sky_conditions` → astronomical dusk/dawn and the Moon.
- `weather_forecast` → verdict, best clear window, cloud layers, rain, wind, dew risk, seeing/transparency. If the night is poor, say so and suggest alternatives (a short session in the best window, Moon/planets through thin cloud, or another night).
- Pick the target with the **target-planning** skill. If the user didn't name one, choose it yourself and say which and why.

## 1. Prepare
- Run **session-startup** (homed, time/location synced, RGB off).
- `set_shooting_mode mode=DSO`.
- Filter: emission nebulae (HII, SNR, PN, e.g. NGC 7000, Veil, Heart/Soul) → **Duo-Band**. Galaxies, clusters, reflection nebulae → **Astro**. With a bright Moon (> 50%, < 40° away), prefer emission targets with Duo-Band.

## 2. Point
- `goto_target name=<target>` (one-click = calibrate + GoTo; 1–5 min). If it fails with plate-solving errors: check `view_camera source=wide` for clouds, obstructions, or dew, then retry once.
- Verify: `view_camera source=tele` (stretch=true). The target must be centred: an off-centre target is unusable collection.
- **Stuck calibration (firmware quirk):** a `calibrate` plate-solve attempt can hang forever (`calibration.state: running`, `busyWith: calibration`, "1 plate solve"). Everything astro then dies: one-click and plain GoTo time out without moving (GoTo state stays idle), `set_shooting_mode` is not acknowledged, `sky_check`/`raw_command` probes time out, the control link flaps lost/back in cycles. `stop_goto` and repeated `telescope_reconnect` do NOT clear it — and **`power action=reboot` may not either** (the command can be handled by the wedged service: "reboot sent" but nothing happens; only HTTP port 8082 keeps answering). **A physical power-cycle recovers it** (user long-presses the power button). Diagnose: `busyWith: calibration` + motors idle + every astro command unacknowledged.

## 3. Focus — on every target (P2 steps 3–7)
Autofocus and the fine tune are required on every target.
1. (`tele_visibility` has left the focuser at infinity.)
2. `autofocus mode=astro`.
3. `star_sharpness` → score and position.
4. Choose the sweep centre by what is logical: compare the autofocus result with the **last confirmed sharpest position tonight** (the previous target's final `star_sharpness` position, from the journal or the previous P2). Focus barely moves between targets on one night, and astro autofocus has a habit of landing grossly wrong (verified: it ended at 543 on a target whose measured peak was 570–575, score 21 vs 238; another night it gave up at 563 while the peak was 578). When the two agree (within ~15), centre on the autofocus result; when they disagree (e.g. collecting at 564, then autofocus on the next adjacent target says 510), centre on the one that makes more sense — normally the confirmed position, unless something changed that moves focus (a large temperature change, a filter change, the scope touched). A sweep started on a bad value burns minutes climbing toward the peak and can end with the peak at its edge.
   `star_focus center=<that centre> range=10 step=1` — leaves the focuser on the sharpest measured position.
   `bestAtEdge` true (the peak is on the edge of the sweep): run it again centred on the sweep's best position, same range and step, until the peak lies inside the sweep.
5. `star_sharpness` → confirm; if below the sweep's best score, run step 4 once more centred on the sweep's best position. The result is the absolute sharpest measured position.
- **Astro autofocus is a finder, not an answer.** Its position is a candidate centre; the fine tune and `star_sharpness` decide.
- Judge focus with `star_sharpness` (HFR-based, independent of exposure and gain), never with `analyze_image`'s `sharpness`.
- **Never override star_focus/star_sharpness's exposure default.** Through Duo-Band the default is 4 s (at 0.5 s too few stars show and every HFR reading is noise — a sweep at the wrong exposure "finds" absurd HFR everywhere; the same sweep at the default finds the real peak). Astro ~1 s, VIS 0.5 s.

## 4. Exposure, gain and filter: `acquisition_plan`
- The owner's settings, else `acquisition_plan action=advise target=<goto name>` (on the night plan the block's `capture` line carries it): use its `settings` (filter, gain, sub length). The qualified profiles in **acquisition-profiles** are the fallback only when it fails.
- Start: `live_stacking action=start exposure=<its sub length> gain=<its gain> filter=<its filter> frames=999` (frames 999 = until stopped).
- Settings are corrected early, on the first-cohort measurements (`acquisition_measure action=check`, `sub_length`), and reported in the journal; later only a shorter sub for cloud or wind with corroborating evidence (system prompt P2 step 8). Never change exposure or gain mid-session to "brighten" a target; every pair needs its own dark (**dark-library**).

## 5. Monitor: follow **session-qc**
- After the first cohort (12 subs; 20 at 60 s) take the baseline with `analyze_subs`, then check it on every duty sample (`stacking_status`, `analyze_subs`) along with the other night work (sky checks for the next target, hourly forecast). Between samples end your turn; the duty loop wakes you.
- Refocus on sustained HFR growth or ≥ 5 °C cooling. EQ-60 → EQ-30 on trailing. Pause for clouds without touching settings.
- Stop if: the target goes behind the site's obstruction map (`obstructedNow`; without a map, below 25°), dawn within 20 min, battery < 10%, SD < 2 GB, or the stack stops growing.
- With a multi-target plan, check the time against the plan at every check, and move on when a target's slot ends (or its altitude window closes), not only when something goes wrong.
- Dew: a dew-point spread < 2 °C means dew on the lens is likely. Warn the user (a dew heater helps); falling star counts at constant cloud cover usually mean dew.

- Stopping and restarting on the same target continues the telescope's count but writes a new `DWARF_RAW_…` session folder; at the end, process all of that target's sessions together (`process_session target=…`).

## 6. Finish
- `live_stacking action=stop` (normal stop finalises the stack; `fast_stop` skips final processing).
- `list_album type=astro` → newest entry. `view_image source=device:<stacked.jpg path>` and assess it.
- `transfer_session session=latest` copies the subs, stacks and CALI_FRAME masters to the library (NAS) and, with auto-processing on, queues the session in AstroPhoto Studio. `pool=true` stacks it together with earlier nights of the same target. In an unattended plan, do this for every target without asking. The transfer runs in the background while you slew to the next target; if a transfer measurably interferes with a running stack, report it and schedule transfers between targets or at the end instead.
- `processing_status` lists the outbox and the server queue. Tell the user which profile ran and when results are expected.
- Append the target's line to `session-log.jsonl` (session-qc). Record only operational lessons in skills/NOTES.md — never site or scene information.
