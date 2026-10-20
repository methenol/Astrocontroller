---
name: session-qc
description: Quality control while a deep-sky capture runs — first-cohort check, focus, trailing, clouds, dew, temperature, rejection rate — and the few corrections allowed. Fix at capture time only what processing cannot fix later.
---
# Session QC

## What only capture time can fix
AstroPhoto Studio does the rest later and better: it grades every sub (stars, FWHM, elongation, transparency), masks cloud and tree tiles per frame, weights by SNR, and keeps the scope's `failed_` subs for grading. So do not throw data away and do not chase single bad frames. Act only on:
- **focus** drifting (temperature),
- **trailing** that persists (wind, balance, field rotation, polar alignment),
- **clouds or dew** collapsing the useful data,
- **the clock, battery, SD space and altitude**.

## Tools
- `analyze_subs count=3`: the newest raw subs from the SD card: stars, hfrPx, roundness (1 = round), background, saturation, sensor °C, rejectedByScope. This is the primary measurement.
- `stacking_status`: taken vs stacked → the scope's reject rate.
- `view_camera source=stack stretch=true`: a quick look; not for numbers.
- `sky_check` / `weather_forecast` when clouds are suspected.

## Baseline: the first cohort
After 12 subs (< 60 s) or 20 subs (60 s), that is two dither blocks: `analyze_subs count=4`. Record the baseline in the session log: median stars, hfrPx, roundness, background, sensor °C.
- Few stars, or hfrPx far above this session's first-cohort baseline → focus or dew; refocus as in check 2 below.
- Roundness well below this session's baseline → wind, balance or trailing; check the altitude (field rotation table in acquisition-profiles).
- Thresholds are **relative to the session's own first-cohort baseline** (e.g. accepted Alt-Az subs measured elongation ≈ 1.2 vs ≈ 2.0 for its rejected trailed subs). Do not act on absolute textbook numbers (e.g. "axis ratio > 1.2") and do not carry thresholds from past sessions.

## Every check (on each duty sample while the stack runs)
1. `stacking_status`, then `analyze_subs count=3`.
2. **Focus:** hfrPx > baseline × 1.15 on three consecutive checks, with the star count steady (not cloud), or the sensor ≥ 5 °C colder than at autofocus → `live_stacking action=stop`, run P2 steps 3–8 (full focus procedure, then restart the stack), then reset the baseline. Ignore single spikes (seeing).
3. **Trailing:** roundness falling ≥ 0.1 below baseline over two checks → check wind and altitude. EQ-60 → switch to EQ-30. Alt-Az above ~65° → the target is near the zenith; move on to the next target, or accept the loss until it descends.
4. **Clouds:** star count < 50 % of baseline, or the background jumps, with `sky_check` / the forecast agreeing → do not change exposure or gain; stop stacking if useful data has collapsed for > 10 min, and resume when stars return. Thin passing cloud: keep going (the Studio masks it per tile).
5. **Dew:** stars fading and the background softening while the sky is clear and the dew-point spread is < 2 °C → tell the user (dew heater); nothing to change in settings.
6. **Reject rate** (stacking_status: taken − stacked) > 25 % over 20+ subs → find the cause with steps 2–5.
- **Known failure (firmware): 100 % rejects although subs look perfect.** taken-count races ahead, stackedCount stays low, yet `analyze_subs` shows real subs with thousands of stars. The scope silently rejects them because the frame is dominated by a foreground obstruction (e.g. vegetation entering the FOV at low altitude) so registration fails. `view_image` one `failed_…fits` from the session folder to confirm. Fix = change target to something well above any obstruction, not refocus/exposure. First-cohort check MUST be stackedCount growth, not taken growth.
7. **Limits:** dawn within 20 min, target below ~25°, battery < 15 % (warn) / < 10 % (stop and transfer), SD < 2 GB → stop / move on per the plan.

## Known failure: tele wedged in captureRawState (firmware quirk)
During live stacking the scope can end the stack on its own (own stop, e.g. mode-change conflict) while the tele camera stays in `captureRawState` state 3. Symptoms: `telescope_status` tele video phase "preview" with ever-growing lastFrameAgoS, GoTo refused -11501, shooting-mode change -8, stills silently not written, video-stop unacknowledged; wide camera, motors, FTP and the link all stay healthy; `health.cameraService` still says "ok". A stop_goto, reconnect, or any repeat command cannot clear it — **only a power cycle does**; try `power action=reboot` at once, without asking, and expect that a physical button press may be needed. Handling: data already captured is safe (subs + metadata on SD, transferable via FTP while wedged) — transfer immediately, keep sampling `telescope_status` every ~15 min to detect a user power-cycle, and resume imaging (home → sync → GoTo → autofocus → stack) as soon as it's back.

## Session log
Append one JSON line per target to `session-log.jsonl` in the workspace when the target ends:
`{"date","target","profile","filter","mount","subs","rejected","baseline":{"stars","hfrPx","roundness","sensorC"},"end":{…},"refocus":n,"events":["clouds 23:10-23:40",…],"notes":"…"}`.
After processing, add the Studio's numbers if you look them up: accepted frames, median FWHM / elongation. **acquisition-experiments** reads this log; keep it factual.
