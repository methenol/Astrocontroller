---
name: polar-alignment
description: Guide the user through EQ-mode setup and polar alignment of the Dwarf 3 using the built-in EQ solving measurement, iterating until the error is small.
---
# Polar alignment (EQ mode)

EQ mode lets the Dwarf 3 track like an equatorial mount, so there's no field rotation and longer subs work. It needs a tripod with a wedge/tilt head and a view of the celestial pole region.

## Setup (explain to the user)
1. Level the tripod.
2. Tilt the Dwarf 3 onto its side on the wedge as described in the DWARFLAB EQ-mode instructions, so its rotation (azimuth) axis points at the celestial pole.
3. Aim the rotation axis roughly at the pole: **north** (Polaris) in the northern hemisphere, south in the southern. The tilt angle should equal the site latitude (see `telescope_status.observer.lat`).
4. `telescope_status` should then show `bodyMode: "eq"`. If it still says `altaz`, re-check the tilt.

## Measure → adjust → repeat
1. Run **session-startup** first (homed, time/location synced). The sky must be clear around the pole.
2. `polar_alignment action=measure` (takes 1–3 min). It returns azimuth and altitude error in degrees and arcminutes, plus a quality rating.
3. Tell the user the `correction` exactly as returned: e.g. "pitch up 1.0°, rotate 3.0° clockwise".
   - **Azimuth error** → rotate the tripod head clockwise/counter-clockwise.
   - **Altitude error** → pitch (tilt) up/down.
4. Repeat until the total error is < 15′ (good) or < 6′ (excellent). Usually 3–5 iterations.
5. Afterwards: `calibrate` (or one-click GoTo) as usual. Subs of 30–60 s should now hold round stars: use the EQ-30 / EQ-60 profiles (acquisition-profiles).

## Sign conventions (from the DWARFLAB app's EQ screen)
- aziErr > 0 → rotate the tripod head clockwise; otherwise counter-clockwise, by |aziErr|°.
- altErr > 0 → tilt upward; otherwise downward, by |altErr|°.
