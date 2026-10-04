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
- Few stars, or hfrPx far above the last nights (NOTES.md) → focus or dew; run astro autofocus and check again.
- Roundness well below the last nights → wind, balance or trailing; check the altitude (field rotation table in acquisition-profiles).
- Thresholds are **relative to this scope's normal**. Accepted 15 s Alt-Az subs here have elongation ≈ 1.2, measured by AstroPhoto Studio on NGC 281 2026-10-01; its rejected trailed subs were ≈ 2.0. Do not act on absolute textbook numbers (e.g. "axis ratio > 1.2").

## Every check (on each duty sample while the stack runs)
1. `stacking_status`, then `analyze_subs count=3`.
2. **Focus:** hfrPx > baseline × 1.15 on three consecutive checks, with the star count steady (not cloud), or the sensor ≥ 5 °C colder than at autofocus → `autofocus mode=astro`, then reset the baseline. Ignore single spikes (seeing).
3. **Trailing:** roundness falling ≥ 0.1 below baseline over two checks → check wind and altitude. EQ-60 → switch to EQ-30. Alt-Az above ~65° → the target is near the zenith; move on to the next target, or accept the loss until it descends.
4. **Clouds:** star count < 50 % of baseline, or the background jumps, with `sky_check` / the forecast agreeing → do not change exposure or gain; stop stacking if useful data has collapsed for > 10 min, and resume when stars return. Thin passing cloud: keep going (the Studio masks it per tile).
5. **Dew:** stars fading and the background softening while the sky is clear and the dew-point spread is < 2 °C → tell the user (dew heater); nothing to change in settings.
6. **Reject rate** (stacking_status: taken − stacked) > 25 % over 20+ subs → find the cause with steps 2–5. NGC 281 at 15 s Alt-Az had ~24 % for the night, mostly clouds and failed registration, so ~20 % is normal here.
7. **Limits:** dawn within 20 min, target below ~25°, battery < 15 % (warn) / < 10 % (stop and transfer), SD < 2 GB → stop / move on per the plan.

## Session log
Append one JSON line per target to `session-log.jsonl` in the workspace when the target ends:
`{"date","target","profile","filter","mount","subs","rejected","baseline":{"stars","hfrPx","roundness","sensorC"},"end":{…},"refocus":n,"events":["clouds 23:10-23:40",…],"notes":"…"}`.
After processing, add the Studio's numbers if you look them up: accepted frames, median FWHM / elongation. **acquisition-experiments** reads this log; keep it factual.
