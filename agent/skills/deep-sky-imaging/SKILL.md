---
name: deep-sky-imaging
description: End-to-end deep-sky capture with live stacking — choosing settings, calibration, GoTo, focus, test frames, monitoring, stopping and wrapping up.
---
# Deep-sky imaging workflow

## 0. Before dark
- `sky_conditions` → astronomical dusk/dawn and the Moon. Read `NOTES.md` for horizon and site notes.
- `weather_forecast` → verdict, best clear window, cloud layers, rain, wind, dew risk, seeing/transparency. If the night is poor, say so and suggest alternatives (a short session in the best window, Moon/planets through thin cloud, or another night).
- Pick the target with the **target-planning** skill. Confirm the choice with the user if they didn't name one.

## 1. Prepare
- Run **session-startup** (homed, time/location synced, RGB off).
- `set_shooting_mode mode=DSO`.
- Filter: emission nebulae (HII, SNR, PN, e.g. NGC 7000, Veil, Heart/Soul) → **Duo-Band**. Galaxies, clusters, reflection nebulae → **Astro**. With a bright Moon (> 50%, < 40° away), prefer emission targets with Duo-Band.

## 2. Point
- `goto_target name=<target>` (one-click = calibrate + GoTo; 1–5 min). If it fails with plate-solving errors: check `view_camera source=wide` for clouds, obstructions, or dew, then retry once.
- Verify: `view_camera source=tele` (stretch=true). The target should be roughly centred.

## 3. Focus
- Start from the stored infinity position: `focus_position action=infinity` (seconds, no stars needed).
- Then `autofocus mode=astro` once per night, and again if the temperature drops > 5 °C.
- Check it: `analyze_image source=tele` → median HFR. Good: ≲ 2.5 px at 1280-px preview width. If it's soft, run astro AF again. Once subs arrive, `analyze_subs` gives the real numbers.

## 4. Exposure, gain and filter: read **acquisition-profiles**
- Choose a qualified profile: Alt-Az → **ALTAZ-15** (15 s, gain 60); EQ → **EQ-30**, or **EQ-60** for faint Duo-Band emission. The firmware requires EQ mode for ≥ 30 s.
- Never change exposure or gain mid-session to "brighten" a target; every pair needs its own dark (**dark-library**).
- Start: `live_stacking action=start exposure=15 gain=60 filter=Duo-Band frames=999` (frames 999 = until stopped).

## 5. Monitor: follow **session-qc**
- After the first cohort (12 subs; 20 at 60 s) take the baseline with `analyze_subs`, then check it on every duty sample (`stacking_status`, `analyze_subs`) along with the other night work (sky checks for the next target, hourly forecast). Between samples end your turn; the duty loop wakes you.
- Refocus on sustained HFR growth or ≥ 5 °C cooling. EQ-60 → EQ-30 on trailing. Pause for clouds without touching settings.
- Stop if: target below ~25° altitude, dawn within 20 min, battery < 10%, SD < 2 GB, or the stack stops growing.
- With a multi-target plan, check the time against the plan at every check, and move on when a target's slot ends (or its altitude window closes), not only when something goes wrong.
- Dew: a dew-point spread < 2 °C means dew on the lens is likely. Warn the user (a dew heater helps); falling star counts at constant cloud cover usually mean dew.

- Stopping and restarting on the same target continues the telescope's count but writes a new `DWARF_RAW_…` session folder; at the end, process all of that target's sessions together (`process_session target=…`).

## 6. Finish
- `live_stacking action=stop` (normal stop finalises the stack; `fast_stop` skips final processing).
- `list_album type=astro` → newest entry. `view_image source=device:<stacked.jpg path>` and assess it.
- `transfer_session session=latest` copies the subs, stacks and CALI_FRAME masters to the library (NAS) and, with auto-processing on, queues the session in AstroPhoto Studio. `pool=true` stacks it together with earlier nights of the same target. In an unattended plan, do this for every target without asking. The transfer runs in the background while you slew to the next target. If FTP during stacking turns out to cause problems, record it here and transfer between targets or at the end instead.
- `processing_status` lists the outbox and the server queue. Tell the user which profile ran and when results are expected.
- Append the target's line to `session-log.jsonl` (session-qc). Update this skill or `NOTES.md` with anything learned (reject causes, timings).
