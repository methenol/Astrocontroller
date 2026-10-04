# Device reference (read-only, offline)

Shipped with Astrocontroller and refreshed into this workspace on every start, so **do not edit
these files**: write what you learn into your skills or NOTES.md instead. Search before reading
whole files: `grep -n -i "<term>" reference/**/*.md`, then `read` the lines around the hit.

| File | What it is |
|---|---|
| `dwarf3-specs.md` | One-page specification sheet: optics, sensors, filters, mount, power, storage, network ports, firmware behaviour, all with sources. **Start here.** |
| `dwarflab-help/DWARF-3-Smart-Telescope-User-Manual-Part1-App-Interface-Introduction.md` | The official user manual (138 KB). The section map is below. |
| `dwarflab-help/Trouble-Shooting-Guide-For-DWARF-3-Users.md` | Official FAQ & troubleshooting: dithering, artefacts, connection problems, dark frames, calibration failures. |
| `dwarflab-help/How-to-View-and-Obtain-the-Files-on-DWARF-3.md` | SD-card layout: session folders, file naming, CALI_FRAME, failed_ subs, stacked outputs. |
| `dwarflab-help/How-to-View-and-Edit-DWARF-3-Files-Wirelessly-on-Your-Computer.md` | FTP / SMB access to the files. |
| `dwarflab-help/DWARF-3-Unboxing-and-Quick-Setup.md` | Quick setup, first power-on. |
| `dwarflab-help/Star-Trails-with-a-DWARF-3-Smart-Telescope.md` | Star-trail mode. |
| `dwarflab-help/Milky-Way-Shooting-Guide.md` | Milky Way mode (wide camera). |
| `dwarflab-help/DWARF-3-Lighting-Effects-Display.md` | What the ring-light colours and patterns mean. |
| `dwarflab-help/august-27-2026-lunar-eclipse-observation-guide.md` | Lunar-eclipse guide (Moon mode, settings). |

All `dwarflab-help/` pages are copies of the official DWARFLAB Help Center
(help.dwarflab.com, product DWARF 3), saved 2026-10-03, with the source URL at the top of each.
The app-centred instructions describe the DWARFLAB app; Astrocontroller drives the same firmware
features through its tools. Where the manual and your verified experience differ, your skills
and `dwarf3-specs.md` "Verified on this device" win.

## User manual: section map (headings to grep for)
- **1 Application interface**: 1.1 Home (1.1.3 Battery, 1.1.4 Storage), 1.2 Sky Atlas, 1.3 Explore / CoStack / CoMosaic, 1.4 Album, 1.5 Settings (storage, firmware, Wi-Fi/STA)
- **2 Shooting interface**: 2.8 Capture modes & settings, 2.10 Focus, 2.13 Parameter settings, 2.14 Information bar (2.14.1 temperature & darks), 2.15 Capture continuity / interrupted sessions
- **3 Modes**: 3.1 General, **3.2 Deep Sky** (3.2.2 sessions, EQ mode, exposure/gain, filters; **3.2.3 Dark frames & Quick Apply**, dark management), 3.3 Solar System (Sun, Moon, planets), 3.4 Auto Capture, 3.5 Panorama, 3.6 Stellar Studio, 3.7 Mega Stack, **3.8 Schedule Shooting**, 3.9 Astro Mosaic
