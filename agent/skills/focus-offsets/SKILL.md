---
name: focus-offsets
description: The filter focus offsets (focus_offsets) — running the night plan's focus-calibration block on its field near the zenith, what the offsets do on every filter change, and converting a focus position between VIS, Astro and Duo-Band; read when a plan instruction or sample line mentions a focus calibration or focus_offsets.
---
# Filter focus offsets

Each filter puts the best focus at a slightly different focuser position: its glass moves the focal plane, and the optics bring each passband to focus a little differently. That difference is a **constant of this telescope**. The absolute best focus drifts with temperature and dew, but the difference between filters does not. It is measured once (a few nights until it settles), kept per device, and then applied by itself.

## What happens on a filter change
Once an offset is measured, every tele filter change moves the focuser by the difference between the two filters, after the filter has settled. That covers `set_camera_setting setting=filter`, `live_stacking … filter=` and the quality probe's cohorts. The tool's answer says so: `focus 571 → 578 to stay equivalent through Duo-Band (measured offset VIS → Duo-Band: +7)`. A focus found through VIS is then the best focus through Duo-Band without another sweep.
- It does **not** move while a stack is collecting. The answer says that too, and the stack's refocus handles it.
- If the scope moves the focuser by itself on a filter change, it is left alone and the answer says so.
- If no offset is measured yet, nothing moves (the answer says so).

## The planner's calibration block
While this telescope's offsets are not settled, the night plan puts one **focus-calibration block** in the night's first clear, steady stretch (forecast seeing, the plan's sky floor), on a bright open cluster near the zenith. That's at most once a night. Collection goes on around it, and a night without a clear stretch just has none. The sample line gives the steps. Run them in order:
1. `live_stacking action=stop` if a stack runs.
2. `goto_target name=<the field> one_click=true`, then `tele_visibility`. If it says BLOCKED, or the field is clouded: `focus_offsets action=skip reason=<why>`. The plan goes on with collection and tries another night. **Do not** use `night_plan action=obscured` for the calibration field.
3. `autofocus mode=astro`, then `star_focus` (as in P2: the peak inside the sweep).
4. `focus_offsets action=calibrate field=<the field>`. It runs in the background: VIS, Astro, VIS, Duo-Band, VIS. Each one is the fine ±10 sweep, re-centred while the peak sits on the edge. It takes about 45 min.
5. `focus_offsets action=status` until it says `done`. Set `duty action=next_check` by `aboutMin`. **No stack, GoTo, focus or filter change meanwhile.**
6. When it ends, the plan re-solves and moves on to its next target: run P2 on it. The calibration puts the filter back the way it found it, focus carried over.

## Reading status
- `offset`: focus units from the reference filter's best focus (VIS). `+7` means 7 units farther than VIS's best.
- `brackets`: valid measurements. `scatter` and `onTheMean`: how well they agree. Settled is 3+ brackets to ±1.5 on the mean, or 6 whatever the scatter.
- A bracket is kept only when all three sweeps found their peak inside the range with enough stars, and the two VIS sweeps agree to 12 units. The filter's peak is compared with VIS interpolated to the moment of its sweep, so a focus drifting as the tube cools cancels out.
- `perDegC`: shown only when enough brackets over a wide range of temperatures say the offset follows temperature. It is then applied at the scope's temperature.

## Converting
`focus_offsets action=convert position=571 from_filter=VIS to_filter=Duo-Band` gives the equivalent position through Duo-Band. Use it to choose P2's `star_focus` centre when the previous target was focused through another filter. The confirmed position, converted, is the sensible centre.

## Rules
- Only on the calibration field, focused, nothing else running. It refuses while a stack, a GoTo, a quality measurement or another calibration runs.
- `focus_offsets action=forget filter=<f>` drops a filter's brackets (a filter swapped, a bad night). `action=show` lists every bracket. The owner can turn the planner's block off in the Plan tab settings (focus calibration).
