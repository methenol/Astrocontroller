---
name: target-planning
description: Choosing what to image tonight — visibility windows, Moon, framing against the Dwarf 3 field of view, scheduling multiple targets.
---
# Target planning

1. `sky_conditions` → darkness window, Moon phase/rise/set, planets. `weather_forecast` → is it worth setting up, and when is the clear window? Plan targets that are well placed *during the clear window*.
2. `plan_targets` (optionally `types=["emission"]`, `["galaxy"]`, …, `min_altitude`, `start`/`end`). The score already weights hours above minimum altitude, peak altitude, framing, brightness and Moon separation. For anything the plan doesn't surface (a specific catalog, constellation, size range, "what Sharpless nebulae are up tonight"), use `search_catalog`: it filters the full ~45k-object database and returns tonight's hours and best time per object.
3. Sanity-check the top picks:
   - **Framing**: tele field is 177′ × 100′. Objects under ~8′ look tiny. Objects larger than the field need a mosaic or the wide camera.
   - **Altitude**: in Alt-Az plan each target's slot in the **30–65°** band. Below that, haze and extinction; above ~65° field rotation trails the frame edges even at 15 s (table in acquisition-profiles). East/west of the meridian rotates least. In EQ mode only the low limit matters.
   - **Moon**: > 50% illuminated → emission nebulae with Duo-Band, or keep > 60° from the Moon.
   - **Meridian/timing**: image each target around its `bestTime`. Order targets so each one is high when you shoot it (east-rising targets later).
   - **Horizon**: check `NOTES.md` for blocked directions; `find_target` gives current azimuth.
4. Integration goals: emission nebulae ≥ 1–2 h; galaxies ≥ 2 h; bright clusters 20–30 min. Goals can span nights: sessions of the same target, profile and filter are pooled into one image (`process_session target=…`), so a target that only gets 1 h tonight can continue tomorrow. Check `list_library` for what a target already has before planning more. Several shorter targets per night are fine.
5. Present 3–5 options with one-line reasons (best time, hours visible, framing, filter) and recommend one.

Record what worked (and what didn't fit or was blocked) in `NOTES.md`.
