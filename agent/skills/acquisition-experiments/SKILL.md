---
name: acquisition-experiments
description: Rare, planned A/B tests to change the qualified acquisition profiles (a new exposure, gain or mount mode) — one candidate vs the incumbent, equal integration, judged on AstroPhoto Studio's processed result. Never during a normal target.
---
# Acquisition experiments

Use only when the session log or the user gives a reason. Examples:
- EQ-60 keeps trailing → is EQ-30 the better default?
- Duo-Band at EQ-30 looks read-noise limited → is EQ-60 worth it?
- A firmware update changed behaviour.
- The user wants to try a gain other than 60.

Experiments cost a night of normal imaging and may need an ND session for darks, so run one only when the reason above is clear, and report it.

## Design
1. **One question, one candidate vs the incumbent.** No grids (not 15/20/30/45/60 at once, not gains 40–80).
2. **Darks first.** The candidate needs a 20-frame master at its exposure and gain (dark-library) before any lights.
3. **Same field, same night, same filter**, interleaved in blocks so both see the same altitude range and sky: e.g. 20 min incumbent, 20 min candidate, 20 min incumbent, 20 min candidate. Use **equal total integration**, ≥ 40 min each.
   - Pick a field with many unsaturated stars and some faint nebulosity, no very bright star, 40–65° altitude, away from the Moon.
   - Use the same field for every experiment, so results compare: record it in NOTES.md.
4. Each candidate's captures are separate sessions (their own DWARF_RAW folders). Process each candidate's sessions as one pool with the same profile: `process_session sessions=[…]` per candidate, both with `profile=default` (the server's best).

## Judging
Compare the two results yourself from AstroPhoto Studio's per-frame table: `GET <ASTROPHOTO_URL>/api/frames?folder=<server path>` (accepted count, fwhm, elongation, transparency) via bash/curl. Compare:
- accepted integration per hour of wall-clock time,
- median FWHM and elongation of accepted subs,
- faint-structure visibility and background noise in the final image, at the same output scale,
- artefacts: banding, hot-pixel residue, clipping.

Promote only for a clear, repeatable gain: about **≥ 10 %** in the main metric, or a real artefact fixed, without new problems. Repeat once on another night before promoting. A marginal win loses, because every profile costs dark maintenance.

## Recording
- Append `{"date","question","incumbent","candidate","field","filter","integration_s_each","metrics":{…},"decision":"promote|reject|repeat","why"}` to `experiments.jsonl`.
- Promote: add the profile to the table in **acquisition-profiles** (with its dark master) and remove anything it replaces. Demote profiles nobody uses.

## Known limits (don't spend nights on these)
- ≥ 30 s requires EQ mode (firmware). Alt-Az exposure is settled at 15 s.
- Gain < 40 is blocked for the tele in deep-sky mode (banding).
- > 60 s is not possible in scheduled capture, and in EQ it only pays with excellent polar alignment. It is the lowest priority.
