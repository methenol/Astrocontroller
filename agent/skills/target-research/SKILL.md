---
name: target-research
description: The owner pressed Research on a target (or asked what something is): build a structured target package — what it is, its discovery and history, reference images, when and how high it is up tonight and through the year, and the filter, gain and sub length to collect it with on this telescope.
---
# Target research package

The owner saw something interesting or does not know what it is, and wants to learn about it before deciding anything. This is a **look-up, not an order**: nothing on the telescope moves, nothing is added to the program, no GoTo. If a stack is collecting on duty, it keeps collecting; research is housekeeping and waits until the stack is running (system prompt §4). Offer the next steps at the end and let the owner pick.

## 1. Gather (call these, in parallel where you can)

| What | Tool |
|---|---|
| Local catalog facts: designations, type, size, magnitude, J2000 position | `find_target name=…` (or `search_catalog query=…`); for a position with no name, use its `ra_hours`/`dec_deg` throughout |
| SIMBAD (type, morphology, B/V mag, distance, redshift), Wikipedia summary, NASA photo list | `object_info name=…` |
| Discovery (who, when, with what), history, notable science, if the summary does not say | `web_search` ("<name> discovered by", "<name> discovery year") |
| Reference images | `reference_image source=survey` (DSS2 plate framed to this scope's field: shows the framing); then `source=wikipedia` or `source=nasa` (the best published photo). Each call answers with a saved path (`captures/agent/…jpg`): keep it, the image goes in the package with it (§2) |
| Tonight: window above the minimum altitude, peak and when, Moon separation | `find_target` → `tonight`; `sky_conditions` for darkness and the Moon; `weather_forecast` for whether tonight is worth it |
| Seasonality through the year | `target_season name=…` |
| Capture settings for this telescope | `acquisition_plan action=advise target=…` (filter, gain, sub length, frames, dither, hours to a detection / clean / deep image, what bound the answer) |
| What the owner already has | `plan_program action=list` (is it in the program, collected vs goal), `list_library` (sessions of it) |

A planet, the Moon or a comet moves: skip `target_season` and `reference_image source=survey`; give tonight's position and the next good apparition (opposition, elongation) from `sky_conditions` and `web_search`, and use the solar-system skill for capture settings.

Every source is best effort. When one does not answer, say which in the package and carry on; never invent a number to fill a gap. Quote the tools' numbers as they come back.

## 2. The package (your reply, in this order, as Markdown)

```
# <Common name> (<main designation>)
<one-line hook: what it is and why it is worth a look>

## At a glance
| | |
|---|---|
| Type | … (SIMBAD morphology) |
| Constellation | … |
| RA / Dec (J2000) | … |
| Size | …′ × …′ — …% of the frame width |
| Magnitude | V … · surface brightness … |
| Distance | … ly (… source) |
| Other names | … |

## What it is
2–4 short paragraphs: the physics in plain words, what makes it notable, what is in the field (companions, nearby objects that share the frame).

## Discovery and history
Who discovered it, when, and with what; catalogue history (Messier, Herschel, Dreyer…); landmark observations or science since.

## Reference imagery
![<name>: DSS2 survey plate framed to this scope's field, north up, east left](captures/agent/<file from reference_image source=survey>.jpg)
What the frame will hold, where to centre, whether a rotation or a mosaic helps.

![<name>: <instrument / observatory>, credit <credit>](captures/agent/<file from reference_image source=wikipedia or nasa>.jpg)
What it shows (detail, colour) and its credit.

What to expect from this telescope compared with the published photo, honestly.

## Tonight at this site
Up from … to … above …° · peaks at …° at … · Moon …% at …° · forecast in one line · verdict: shoot it tonight, later in the night, or another night.

## Seasonality
Best months … · in season … → … (now: in / out) · best night (transits mid-darkness) … · highest it ever gets here …° · circumpolar / never rises.
A month table: month · usable h per night · peak alt.

## Collecting it with this telescope
| Filter | Gain | Sub | Frames | Dither |
|---|---|---|---|---|
| … | … | … s | … | … |
Integration: detection … h · clean … h · deep … h · what tonight adds.
Why this filter (emission lines vs broadband), what bound the answer (trailing, sky, clipping), the Moon's effect, and an alternative for a moonlit night.

## Processing notes
What to bring out (faint outer arms, Ha regions, colour of the core…), and the usual pitfalls (blown core, gradients, star bloat).

## Your history with it
In the program or not (collected / goal); sessions in the library.

## Next steps
Offer: add it to the program (suggested goal and priority), image it tonight, show it in Stellarium.

Sources: SIMBAD, Wikipedia (link), NASA/ESA image credits, any web pages used.
```

Keep it scannable: tables and short paragraphs, no filler.

**The images go in the package itself.** The owner reads the package, not the tool calls above it, which are collapsed and easy to miss. Every `reference_image` call ends with `saved as captures/agent/<file>.jpg`: put each image you fetched in the package as a Markdown image with that path, exactly as returned (`![caption](captures/agent/2026-11-07T…_reference_M_31.jpg)`), under the heading it belongs to, with a caption naming the source and the credit. Never write "see above", "as shown in the tool output" or "scroll up": if a picture matters, it is in the package. An image that could not be fetched is named as missing, with the reason, in its place.

## 3. Keep a copy

Write the package to `research/<designation>.md` in the workspace (spaces → `-`, e.g. `research/M-31.md`), with the date at the top and the same image paths, so the copy carries its pictures too. When the owner asks about a target that already has a package, read it first and refresh only what changes (tonight, the season from today, the capture plan); the identity, history and imagery stand.
