---
name: focus-offsets
description: The filter focus offsets (focus_offsets) — running the night plan's focus-calibration block on its field near the zenith, what the offsets do when the wheel changes between IRCUT and LP, and converting a focus position between them; read when a plan instruction or sample line mentions a focus calibration or focus_offsets.
---
# Filter focus offsets

The best focus through LP lies at a slightly different focuser position than through IRCUT: the filter's glass moves the focal plane, and the optics bring its two lines to focus a little differently. That difference is a **constant of this Seestar**. The absolute best focus drifts with temperature and dew, but the difference does not. It is measured once (a few nights until it settles), kept per device, and then applied by itself.

## What happens on a wheel change
Once the offset is measured, every wheel change moves the focuser by the difference, after the wheel has settled. That covers `set_camera_setting setting=filter value=LP|IRCUT` and the quality probe's cohorts. The answer says so: `focus 902 → 911 to stay equivalent through LP (measured offset IRCUT → LP: +9)`. A focus found through IRCUT is then the best focus through LP without another sweep.
- It does **not** move while a stack is collecting. The answer says so, and the stack's refocus handles it.
- If the Seestar moves the focuser by itself on the change, it is left alone and the answer says so.
- If no offset is measured yet, nothing moves (the answer says so).
- The GoTo's `lp_filter` is the firmware's own slot choice at the start of a view, before P3's autofocus and `star_focus`: the offset is not applied there.

## The planner's calibration block
While this Seestar's offset is not settled, the night plan puts one **focus-calibration block** in the night's first clear, steady stretch (forecast seeing, the plan's sky floor), on a bright open cluster near the zenith. That's at most once a night. Collection goes on around it, and a night without a clear stretch just has none. The sample line gives the steps. Run them in order:
1. `stop_stacking` if a stack runs.
2. `goto_target name=<the field> lp_filter=false`. If the frame shows cloud or an obstruction: `focus_offsets action=skip reason=<why>`. The plan goes on with collection and tries another night. **Do not** use `night_plan action=obscured` for the calibration field.
3. `autofocus`, then `star_focus` (as in P3: the peak inside the sweep).
4. `focus_offsets action=calibrate field=<the field>`. It runs in the background: IRCUT, LP, IRCUT. Each one is the fine ±10 sweep, re-centred while the peak sits on the edge. The LP sweep runs at a 5 s live exposure, put back after. It takes about 15 min.
5. `focus_offsets action=status` until it says `done`. **No stack, GoTo, focus or filter change meanwhile.**
6. When it ends, the plan re-solves and moves on to its next target: run P3 on it. The calibration puts the wheel back the way it found it, focus carried over.

## Reading status
- `offset`: focus units from IRCUT's best focus. `+9` means 9 units farther than IRCUT's best.
- `brackets`: valid measurements. `scatter` and `onTheMean`: how well they agree. Settled is 3+ brackets to ±1.5 on the mean, or 6 whatever the scatter.
- A bracket is kept only when all three sweeps found their peak inside the range with enough stars, and the two IRCUT sweeps agree to 12 units. LP's peak is compared with IRCUT interpolated to the moment of its sweep, so a focus drifting as the tube cools cancels out.
- `perDegC`: shown only when enough brackets over a wide range of temperatures say the offset follows temperature. It is then applied at the scope's temperature.

## Converting
`focus_offsets action=convert position=902 from_filter=IRCUT to_filter=LP` gives the equivalent position through LP. Use it to choose P3's `star_focus` centre when the previous target was focused through the other filter. The confirmed position, converted, is the sensible centre.

## Rules
- Only on the calibration field, focused, nothing else running. It refuses while a stack, a GoTo, a quality measurement or another calibration runs.
- `focus_offsets action=forget filter=LP` drops LP's brackets (a bad night). `action=show` lists every bracket. The owner can turn the planner's block off in the Plan tab settings (focus calibration).
