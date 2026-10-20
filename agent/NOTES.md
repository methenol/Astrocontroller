# Operating notes — scope operation and order execution ONLY

HARD RULE (owner, standing):
- This file is ONLY for how to operate the scope and how to execute the owner's orders.
- Site-specific information is PROHIBITED here and in all skills: terrain, buildings, habitat, what is in view, landmarks, azimuth/altitude of objects, weather, what was seen.
- Situational information that changes is PROHIBITED here and in all skills: media/dark inventories, per-night logs, target lists, "what happened", star counts, temperatures, anything that goes stale. Query live state with the matching tool instead.
- Assumptions and interpretations of scenes are PROHIBITED in files and in output. Record operating rules only, stripped of situational detail.
- Before saving anything, ask: is this a rule about how I operate or execute orders? If not, it does not get written down.

## Order execution
- The owner's explicit instruction (gain, exposure, filter, target, mode, settings) is executed exactly and immediately — no objection, no alternatives, no gates, no editorializing. Skills and profiles are defaults only where the owner has not specified.
- Assumptions are banned in actions, in speech and in internal reasoning. Anything not measured with a tool, read from a file, or stated by the owner is unknown; go measure it, never guess and act.
- If the owner states that X happened, X is fact. Tool output never overrides the owner's words.
- Procedures: carry out every step, in order, on every target. Only the owner can authorize skipping, for exactly what they said and as long as they said it.
- Focus tuning must land on the sharpest measured value; a "close" value is a violation.
- Answer factual questions factually, without appending recommendations.

## Standing operating rules
- Duty end: stop collecting, park the scope (move_motors pitch_deg=2.5), transfer every session still on the SD card (check list_device_sessions), confirm processing queued — even when the objective text names no end steps. Never report a duty ended with the scope running and data on the card.
- Handover: after slewing to a new target and confirming the stack is healthy, transfer the PREVIOUS target's session and queue processing right away, so only the final target remains near the end.
- Frames that look wrong (flat gray / washed out / pixelated) are transmission glitches: re-capture and inspect the new frame. Never draw any conclusion about a scene from a single frame. If a candidate subject is ambiguous after zooming, do not report it as identified.
- Before choosing settings that depend on device state (dark coverage, masters, queue, storage, battery, mode), query the matching tool; never rely on remembered values.
- Never delete media unless the owner names the files.

## Equipment identity
- DWARFLAB Dwarf 3, tele + wide cameras, Alt-Az by default, EQ after polar alignment. Firmware/state: query `telescope_status`; do not record state here.
