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
- Check it: `analyze_image source=tele` → median HFR. Good: ≲ 2.5 px at 1280-px preview width. If it's soft, run astro AF again.

## 4. Exposure & gain (starting points)
| Mount | Sub length | Gain | Notes |
|---|---|---|---|
| Alt-Az, target alt < 70° | 15 s | 60 | default; field rotation limits longer subs |
| Alt-Az, near pole (Dec > 70°) | 30 s | 60 | less field rotation |
| Alt-Az, target alt > 75° | 10 s | 80 | fast azimuth tracking near zenith, many rejects |
| EQ mode (polar aligned) | 60 s | 60 | longer subs fine once aligned |
- The device already holds **dark masters for 15 s / 30 s / 60 s at gain 60** (`/Astronomy/CALI_FRAME/dark`). Prefer those combinations so darks get applied.
- Set via `live_stacking action=start exposure=15 gain=60 filter=Duo-Band frames=999` (frames 999 = until stopped).

## 5. Monitor (every 5–10 min)
- `stacking_status` → watch `rejected` (taken − stacked). A rising reject rate means clouds, wind, dew, or field rotation. Shorten subs or check the sky.
- `view_camera source=stack stretch=true` to see progress. `analyze_image source=stack` for star roundness < 0.7 = trailing.
- `wait seconds=300` between checks. Report integration time to the user periodically.
- Stop if: target below ~20° altitude, dawn within 20 min, battery < 10%, or the stack stops growing.
- Clouds: if the reject rate jumps and `weather_forecast` shows cloud arriving, pause (stop stacking) rather than collect junk; resume when the forecast clears and the wide view shows stars.
- Dew: a dew-point spread < 2 °C means dew forming on the lens is likely. Warn the user (a dew heater helps); falling star counts at constant cloud cover usually mean dew.

## 6. Finish
- `live_stacking action=stop` (normal stop finalises the stack; `fast_stop` skips final processing).
- `list_album type=astro` → newest entry. `view_image source=device:<stacked.jpg path>` and assess it.
- Offer `transfer_session session=latest` to copy FITS lights, stacks and calibration frames to the library.
- Update this skill or `NOTES.md` with anything learned (good settings, reject causes, timings).
