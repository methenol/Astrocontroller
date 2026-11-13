---
name: collection-quality
description: Running the planner's measure step (acquisition_quality) — the planner decides per target when its filter, gain and sub must be measured on the target after focusing, and what to shoot; read when a plan instruction contains acquisition_quality.
---
# Collection quality

The settings a target is collected with are **measured on that target with this rig**, then solved, not guessed. This is the ground truth the planner uses for the target from then on, and it also feeds the site's measured sky and seeing.

## Who decides
The **planner** drives it. Per target it decides whether the settings must be measured (`needed`: never measured or older than three weeks; `more`: not settled; `refresh`: measured under a very different sky or altitude) and which cohorts to shoot, and it puts the measure step into the target procedure of the plan's instruction (after the focus, before the stack). Run that step when the instruction has it. You may also re-measure or add data yourself whenever you see a reason (below): the engine re-solves from everything it has.

## Running the planner's step
1. The instruction says `acquisition_quality action=measure target=<name>` (perhaps `refresh=true`): run it exactly so, at the point in the procedure where it stands. The points are the planner's (`acquisition_quality action=plan` shows them and `aboutMin`, if you want to know how long it takes).
2. It runs in the background: no dataset, no journal session, no transfer (Seestar: single raw subs off the live view; Dwarf: a tiny stack copied off the card and deleted from it). Temp files are removed afterwards. It refuses without a focus recorded on the target since its GoTo.
3. `acquisition_quality action=status` until `done` (set `duty action=next_check` by `aboutMin`). The planner may add up to 3 cohorts by itself when the best sub is at the edge of what it tested or a cloud spoiled one.
4. Stack with the settings it returns (`apply`). The plan re-solves at once, and the block's `capture` line carries the measured settings from then on.
5. `journal action=note`: the settings and the one-line reason (`why[1]`).

## Re-measuring and more data (your call)
- `acquisition_quality action=measure target=<name> refresh=true`: re-measure an established target — the engine shoots its points around the current answer. Do it when the sky, the Moon or the altitude changed a lot, or the stack's subs or rejects disagree with the settings (after a focus, outside a running stack).
- `acquisition_quality action=submit session=latest` (or `files=[…]`): hand subs you already have — the running stack's newest — to the engine as a measurement of the target, without stopping anything. Good after moonrise or as the target sinks.
- Either way the engine re-solves, the plan re-solves, and the next block (or the restart you choose) uses the result.

## Reading the answer
- `settings.source`: `measured on this target`, or `model (not measured yet)`.
- `table`: every setting scored relative to the best; `note` names what limited it (stars soft or trailed, sky over 25% of the range, clipping).
- `moon`: the Moon's measured scattering through the filter (once a moon-down and a moon-up cohort exist) and how much it brightens this block.
- `set.invalid`: cohorts spoiled by cloud or an obstruction (gaps it filled or could not fill).

## Rules
- Measure the target the scope is on, centred and focused; never during another target's stack.
- `failed` with cloud in the error: P3 `cause=cloud`, not a re-run on the same cloud.
- `acquisition_quality action=forget target=<name>` drops a target's cohorts (a bad night); `action=show` lists them.

## Learned
