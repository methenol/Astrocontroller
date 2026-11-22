---
name: dark-library
description: Keep a small, good dark-master library for the qualified acquisition profiles (the Dwarf mini shoots its own behind its built-in dark filter; the Dwarf 3's are made by the owner in the DWARFLAB app), and decide when darks need refreshing.
---
# Dark library

## Facts
- Dark masters live on the scope in `CALI_FRAME/dark/cam_0/` (`dark_exp_<s>_gain_<g>_bin_1_<T>C_stack_<n>.fits`). `transfer_session` copies them to the library, where AstroPhoto Studio finds them beside the sessions.
- **Who captures depends on the model** (`telescope_status.device.name`):
  - **Dwarf mini** (`DWARF_mini_…`): it closes its built-in dark filter for each master (verified 2026-11-21: a master shot facing a lit room read 200 ADU, its black level). No cover, no owner: capture the masters the night needs whenever the scope is idle, the scope may stay where it is.
  - **Dwarf 3**: no dark filter. The owner makes its darks in the DWARFLAB app. Recommend a missing master (which exposure and gain, and why); capture one yourself only when the owner asks and says the lens is covered. A light leak ruins the master.
- The firmware stacks up to 20 frames per master and matches exposure, gain and resolution exactly. When the sensor temperature changes during a capture it saves one master per temperature (`…_36C_stack_3` + `…_37C_stack_2` for 5 frames); the controller counts them together.
- Tool: `dark_frames action=list | capture | status | stop`. Exposure and gain codes come from the firmware's dark list, or for a combination it has never shot, from the camera's own exposure codes and DWARFLAB's gain table, so any listed exposure and gain 0/2/5/10–240 can be captured.
- **A capture runs in the background.** The telescope never acknowledges the capture command (verified 2026-10-03: 15 s and 30 s masters saved, no reply). The controller marks it done when the new master appears in CALI_FRAME. `capture` returns at once, and Astrocontroller wakes you with an event when the master is saved (or why it failed); `dark_frames action=status` shows progress (remainingMin) if the user asks. Duration ≈ frames × exposure + ~1 min, e.g. 20 × 60 s ≈ 21 min. A timeout is not a failure: check `list` for the new master before retrying.

## How AstroPhoto Studio uses darks (why quality matters more than temperature)
- It subtracts `light − bias − k·(dark − bias)`, with **k fitted per sub** from the hot pixels (dark optimisation). A dark at another temperature still removes the right amount of thermal signal. On C 20 the lights ran at 35–42 °C against a 27 °C dark, and the fitted scale rose smoothly from 1.29 to 1.50.
- A dark of another exposure at the same gain is scaled by the exposure ratio, provided a bias exists. **Gain must match.**
- Every sub gets the **same master** subtracted, so the master's own noise is added identically to all subs and does not average down in the stack. A 1-frame master adds about as much read noise as a light. A 20-frame master adds √20 ≈ 4.5× less. **Stack count is the main quality lever.**
- The scope's own live stack is stricter: DWARFLAB asks for darks within ±8 °C of the session, or it prompts to retake them.

## Policy
- Key: exposure + gain + bin + temperature. Keep masters only for the qualified profiles (acquisition-profiles); filter is not part of the key.
- Temperature: within 8 °C of a typical session = fine. Further = refresh at the next dark session; the Studio still copes meanwhile, so it is not an emergency.
- Always 20 frames.
- **Batch.** One dark session captures every missing or weak master at the current sensor temperature.
- Never in the middle of a target: only before the night's first light, at the end, or on a cloudy evening.

## Maintenance queue (keep it in NOTES.md under "Dark maintenance")
Add an entry when:
- a qualified profile has no master, or only a weak one (stack < 10);
- the typical session temperature (`analyze_subs` sensorC, or the FITS DET-TEMP) is > 8 °C from the profile's master (seasons: the sensor runs ~10 °C above the air);
- a profile is newly promoted;
- the firmware changes;
- the processed stacks show detector-fixed hot pixels or column patterns that survive dithering (report from the user or the Studio's calibration notes).

Do not add entries because the target, filter or Moon changed.

Current queue: empty. 2026-10-03 dark session (Dwarf 3): 15 s / g60 (38 °C), 30 s / g60 (39 °C) and 60 s / g60 (40 °C), all 20 frames. The older stack-1/stack-3 masters at 27–28 °C remain on the card; AstroPhoto Studio picks the nearest temperature. Next refresh: when sessions run more than 8 °C from these (winter nights).

## Procedure (one dark session)
1. Make sure nothing is imaging. `dark_frames action=list` → note the sensor temperature and which masters to make.
2. Dwarf 3 only: the owner asked for it and said the lens is covered (otherwise recommend the masters and stop here).
3. For each master in the batch: `dark_frames action=capture exposure_s=… gain=60 frames=20`. Then end your turn: the "dark master saved" event wakes you, and you start the next master only then.
4. `dark_frames action=list` → check every new master exists at the session temperature (frames may be split across temperatures).
5. Transfer later (any `transfer_session` copies CALI_FRAME). Update the queue in NOTES.md, and the profile table in acquisition-profiles.
