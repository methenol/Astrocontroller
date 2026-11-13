---
name: dark-library
description: Keep a small, good dark-master library for the qualified acquisition profiles, captured in batched ND-filter sessions (manual intervention), and decide when darks need refreshing.
---
# Dark library

## Facts
- Dark masters live on the scope in `CALI_FRAME/dark/cam_0/` (`dark_exp_<s>_gain_<g>_bin_1_<T>C_stack_<n>.fits`). `transfer_session` copies them to the library, where AstroPhoto Studio finds them beside the sessions.
- **Dark capture is started by the owner, never by you.** You may recommend that a master is needed (say which exposure and gain, and why); you never start an ND session or a capture on your own. They must fit the ND filter and fully retract the lens cylinder; DWARFLAB's troubleshooting guide also allows a solar-filter cover in complete darkness. A light leak ruins the master. The firmware stacks up to 20 frames per master and matches exposure, gain and resolution exactly.
- **The ND filter is magnetic and the operator tilts the scope up by hand to fit it.** Any motion can knock it off the lens and drop it on the ground: no parking, homing, GoTo, nudging or move_motors during an ND session. `dark_frames action=nd_fitted` locks all motion in the controller (UI buttons too) until `nd_removed`, so that nothing — above all a `motors_home` — moves the scope with the filter on.
- Tool: `dark_frames action=list | nd_fitted | capture | status | stop | nd_removed`. The firmware addresses exposure and gain by internal codes, and the tool learns them from the firmware's own dark list. It can only capture combinations that exist in that list. A brand-new gain or exposure needs one capture in the DWARFLAB app first.
- **A capture runs in the background.** The telescope never acknowledges the capture command (verified 2026-10-03: 15 s and 30 s masters saved, no reply). The controller marks it done when the new master appears in CALI_FRAME. `capture` returns at once, and Astrocontroller wakes you with an event when the master is saved (or why it failed); `dark_frames action=status` shows progress (remainingMin) if the user asks. Duration ≈ frames × exposure + ~1 min, e.g. 20 × 60 s ≈ 21 min. A timeout is not a failure: check `list` for the new master before retrying.

## How AstroPhoto Studio uses darks (why quality matters more than temperature)
- It subtracts `light − bias − k·(dark − bias)`, with **k fitted per sub** from the hot pixels (dark optimisation). A dark at another temperature still removes the right amount of thermal signal. On C 20 the lights ran at 35–42 °C against a 27 °C dark, and the fitted scale rose smoothly from 1.29 to 1.50.
- A dark of another exposure at the same gain is scaled by the exposure ratio, provided a bias exists. **Gain must match.**
- Every sub gets the **same master** subtracted, so the master's own noise is added identically to all subs and does not average down in the stack. A 1-frame master adds about as much read noise as a light. A 20-frame master adds √20 ≈ 4.5× less. **Stack count is the main quality lever.**
- The scope's own live stack is stricter: DWARFLAB asks for darks within ±8 °C of the session, or it prompts to retake them.

## Policy
- Key: exposure + gain + bin + temperature. Keep masters only for the qualified profiles (acquisition-profiles); filter is not part of the key.
- Temperature: within 8 °C of a typical session = fine. Further = refresh at the next ND session; the Studio still copes meanwhile, so it is not an emergency.
- Always 20 frames.
- **Batch.** One ND session captures every missing or weak master at the current sensor temperature. Never alternate ND on/off to test settings.
- Never in the middle of a target: only before the night's first light, at the end, or on a cloudy evening.

## Maintenance queue (keep it in NOTES.md under "Dark maintenance")
Add an entry when:
- a qualified profile has no master, or only a weak one (stack < 10);
- the typical session temperature (`analyze_subs` sensorC, or the FITS DET-TEMP) is > 8 °C from the profile's master (seasons: the sensor runs ~10 °C above the air);
- a profile is newly promoted;
- the firmware changes;
- the processed stacks show detector-fixed hot pixels or column patterns that survive dithering (report from the user or the Studio's calibration notes).

Do not add entries because the target, filter or Moon changed.

Current queue: empty. 2026-10-03 ND session: 15 s / g60 (38 °C), 30 s / g60 (39 °C) and 60 s / g60 (40 °C), all 20 frames. The older stack-1/stack-3 masters at 27–28 °C remain on the card; AstroPhoto Studio picks the nearest temperature. Next refresh: when sessions run more than 8 °C from these (winter nights).

## Procedure (one ND session, only when the owner starts it)
1. Make sure nothing is imaging. **Do not park or move the scope.** `dark_frames action=list` → note the sensor temperature and which masters to make.
2. The owner asked for the session: ask them once: "Please tilt the scope up by hand, fit the ND filter over the lenses (and retract the lens), then tell me when done." Wait for their confirmation (this is the one place you wait for the owner), then `dark_frames action=nd_fitted operator_confirmed=true`.
3. For each master in the batch: `dark_frames action=capture exposure_s=… gain=60 frames=20`. Then end your turn: the "dark master saved" event wakes you, and you start the next master only then.
4. `dark_frames action=list` → check every new master exists with stack 20 at the session temperature.
5. Ask the operator to remove the ND filter. When they confirm: `dark_frames action=nd_removed operator_confirmed=true`.
6. **Only after `nd_removed`: `motors_home`** before any pointing: the hand tilt left the motors' recorded position wrong. Never home while the filter is on.
7. Transfer later (any `transfer_session` copies CALI_FRAME). Update the queue in NOTES.md, and the profile table in acquisition-profiles.
