---
name: target-planning
description: Choosing what to image tonight — visibility windows, Moon, framing against the Dwarf 3 field of view, scheduling multiple targets.
---
# Target planning

**The night plan comes first.** When the owner keeps a program (`plan_program action=list`: targets with an integration goal and a priority), tonight's schedule is `night_plan action=show`: blocks from the plan's start to its end, each with its target, expected integration, altitude, Moon, sky, and alternates in other quadrants; `program` says for each target what is collected, what tonight adds, and why it is or is not on tonight's plan. On duty, follow it (`night_plan action=now`). Tell it what the night does to it: `obscured` (an obstruction or a cloud), `sky_hold` (a part of the sky is out), `skip`, `pin`; it solves the rest of the night again and answers with what to do now. Add targets to the program only on the owner's request (`plan_program action=add name=… goal_hours=… priority=…`). The steps below are for choosing without a program, or when the owner asks for options.

1. `sky_conditions` → darkness window, Moon phase/rise/set, planets. `weather_forecast` → is it worth setting up, and when is the clear window? Plan targets that are well placed *during the clear window*.
2. `plan_targets` (optionally `types=["emission"]`, `["galaxy"]`, …, `min_altitude`, `start`/`end`). The score already weights hours above minimum altitude, peak altitude, framing, brightness and Moon separation. With a site obstruction map (`map_obstructions`) "up" also means above the mapped trees and buildings in that direction; `obstructedNow: true` = behind them right now.
3. Sanity-check the top picks:
   - **Framing**: tele field is 177′ × 100′. Objects under ~8′ look tiny. Objects larger than the field need a mosaic (`plan_mosaic`, see below) or the wide camera.
   - **Altitude**: in Alt-Az plan each target's slot in the **30–65°** band. Below that, haze and extinction; above ~65° field rotation trails the frame edges even at 15 s (table in acquisition-profiles). East/west of the meridian rotates least. In EQ mode only the low limit matters.
   - **Moon**: > 50% illuminated → emission nebulae with Duo-Band, or keep > 60° from the Moon.
   - **Meridian/timing**: image each target around its `bestTime`. Order targets so each one is high when you shoot it (east-rising targets later).
   - **Visibility**: confirmed only by `tele_visibility` after the GoTo (P2 step 2) and by the owner. What is in view changes with every setup; never record it.
4. Integration goals: emission nebulae ≥ 1–2 h; galaxies ≥ 2 h; bright clusters 20–30 min. Goals can span nights: sessions of the same target, profile and filter are pooled into one image (`process_session target=…`), so a target that only gets 1 h tonight can continue tomorrow. Check `list_library` for what a target already has before planning more. Several shorter targets per night are fine.
5. On duty, choose: the first row that is not gated and has `obstructedNow` not true (system prompt P1/P3), then run P2. A blocked view is recorded as a patch of sky at a time, and the plan's horizon carries it: `clearsAt` says when an obstructed target comes clear as the sky turns. Outside a duty, when the owner asks for options: present 3–5 with one-line reasons (best time, hours visible, framing, filter) and recommend one.
6. `suggestedFilter` starts with the filter to use: `Astro` or `Duo-Band` (the planner picks per target from the Dwarf 3's own filters).

Record per-target outcomes in `session-log.jsonl` (session-qc); skills and NOTES.md hold operational rules only, never site or scene information.

## Mosaics and cropping

Both are the owner's choice: a global setting (`plan_program action=settings`: `mosaicEnabled`, `roiCropEnabled`) and a per-target `mosaic` / `roi_crop` of `on`, `off` or `inherit`. A target's own setting wins.

- A mosaic is one program target whose goal is per panel: 2 h on a 4-panel mosaic is 8 h of accepted integration. `plan_mosaic` computes the panels; never work out positions yourself.
- During its block use `get_next_mosaic_panel`: goto_target with exactly the name, `ra_hours` and `dec_deg` it gives, stack for `stack_minutes`, then ask again. The name is how the panel's integration is counted across nights. Autofocus at the start of the block, not at each panel.
- `get_mosaic_progress` is the record of what is done (accepted integration, never time spent). `process_mosaic` sends the project to AstroPhoto Studio, which reports back rejected frames and any panel to shoot again.
- `mosaicAllowNative` is off by default: the firmware mosaics' scale units are not confirmed on hardware. Use `start_native_mosaic` only for a project planned that way, and check the first frames.
- Cropping has nothing to do with the telescope. AstroPhoto Studio crops; the processing request carries the percentage of the frame to keep, worked out from the catalog size when cropping is on. `process_session roi_crop_percent` overrides it.
