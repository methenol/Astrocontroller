---
name: target-planning
description: Choosing what to image tonight — visibility windows, Moon, framing against the Dwarf 3 field of view, scheduling multiple targets.
---
# Target planning

1. `sky_conditions` → darkness window, Moon phase/rise/set, planets. `weather_forecast` → is it worth setting up, and when is the clear window? Plan targets that are well placed *during the clear window*.
2. `plan_targets` (optionally `types=["emission"]`, `["galaxy"]`, …, `min_altitude`, `start`/`end`). The score already weights hours above minimum altitude, peak altitude, framing, brightness and Moon separation.
3. Sanity-check the top picks:
   - **Framing**: tele field is 177′ × 100′. Objects under ~8′ look tiny. Objects larger than the field need a mosaic or the wide camera.
   - **Altitude**: best above 35–40° (less haze and extinction). Avoid > 80° in Alt-Az (rotation and tracking rejects near zenith).
   - **Moon**: > 50% illuminated → emission nebulae with Duo-Band, or keep > 60° from the Moon.
   - **Meridian/timing**: image each target around its `bestTime`. Order targets so each one is high when you shoot it (east-rising targets later).
   - **Horizon**: check `NOTES.md` for blocked directions; `find_target` gives current azimuth.
4. Integration goals: emission nebulae ≥ 1–2 h; galaxies ≥ 2 h; bright clusters 20–30 min. Several shorter targets per night are fine.
5. Present 3–5 options with one-line reasons (best time, hours visible, framing, filter) and recommend one.

Record what worked (and what didn't fit or was blocked) in `NOTES.md`.
