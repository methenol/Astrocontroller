# Stellarium Web Engine

The planetarium in the web UI's Stellarium tab.

Source: https://github.com/Stellarium/stellarium-web-engine
Commit: 1162c9ef73cc94f4762dfbfd24c637190119ea93
License: GNU AGPL v3 (LICENSE-AGPL-3.0.txt), Copyright Stellarium Labs SRL / Noctua Software Ltd.
The engine is unmodified; its complete source is at the commit above.

- `stellarium-web-engine.js`, `stellarium-web-engine.wasm`: `make js` (release) with emscripten 1.39.17.
- `fonts/`: Roboto, from the engine's `apps/simple-html/static/fonts`.
- `skydata/`: the engine's `apps/test-skydata` (stars to magnitude 7, the bright deep-sky objects,
  the western sky culture, the Milky Way, Sun and Moon textures, comets, minor planets,
  satellites, the Guéreins landscape), so the sky works with no internet at the observing site.

With `STELLARIUM_STREAM=true` the page also streams the online surveys from data.stellarium.org
(DSS colour imagery, Gaia stars, the full deep-sky catalog, the planet textures).

Rebuild with `scripts/stellarium/build-engine.sh`.
