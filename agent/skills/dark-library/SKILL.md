---
name: dark-library
description: Keep a small, good dark-master library for the qualified acquisition profiles, captured in batched ND-filter sessions (manual intervention), and decide when darks need refreshing.
---
# Dark library

## Facts
- Dark masters live on the scope in `CALI_FRAME/dark/cam_0/` (`dark_exp_<s>_gain_<g>_bin_1_<T>C_stack_<n>.fits`). `transfer_session` copies them to the library, where AstroPhoto Studio finds them beside the sessions.
- **Capturing darks needs the operator.** They must fit the ND filter and fully retract the lens cylinder; DWARFLAB's troubleshooting guide also allows a solar-filter cover in complete darkness. A light leak ruins the master. The firmware stacks up to 20 frames per master and matches exposure, gain and resolution exactly.
- Tool: `dark_frames action=list | capture | stop`. `capture` needs `nd_filter_confirmed=true`, which you may only pass after the operator has said the filter is on. The firmware addresses exposure and gain by internal codes, and the tool learns them from the firmware's own dark list. It can only capture combinations that exist in that list. A brand-new gain or exposure needs one capture in the DWARFLAB app first.
- Progress: `telescope_status.darkCapture`. Duration ≈ frames × exposure + overhead, e.g. 20 × 60 s ≈ 21 min.

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

Current queue (2026-10-03): the 30 s and 60 s / g60 masters are stack 1, so recapture both at 20 frames before relying on EQ-30/EQ-60. The 15 s / g60 master is stack 3: recapture at 20 frames near the typical session temperature (~35–40 °C sensor in autumn).

## Procedure (one ND session)
1. Make sure nothing is imaging; park (`move_motors pitch_deg=2.5`). `dark_frames action=list` → note the sensor temperature and which masters to make.
2. Ask the operator once: "Please fit the ND filter and fully retract the lens cylinder, then tell me when done." Wait for their confirmation.
3. For each master in the batch: `dark_frames action=capture exposure_s=… gain=60 frames=20 nd_filter_confirmed=true`. Wait (`wait`) and check `telescope_status.darkCapture` until it finishes, then do the next.
4. `dark_frames action=list` → check the new masters exist with stack 20 at the expected temperature.
5. Ask the operator to remove the ND filter. **No light frames until they confirm.**
6. Transfer later (any `transfer_session` copies CALI_FRAME). Update the queue in NOTES.md, and the profile table in acquisition-profiles.
