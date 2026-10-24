#!/usr/bin/env bash
# Rebuild the Stellarium Web Engine served by the Stellarium tab (public/vendor/stellarium/).
#
# Clones github.com/Stellarium/stellarium-web-engine at $SWE_REF, compiles it to WebAssembly in
# the emscripten image its own web frontend pins (emsdk 1.39.17), and copies the engine, its fonts
# and the bundled sky data into public/vendor/stellarium/. Needs git and docker.
#
#   scripts/stellarium/build-engine.sh            # the pinned commit
#   SWE_REF=master scripts/stellarium/build-engine.sh
set -euo pipefail

SWE_REPO=${SWE_REPO:-https://github.com/Stellarium/stellarium-web-engine.git}
SWE_REF=${SWE_REF:-1162c9ef73cc94f4762dfbfd24c637190119ea93}
EMSDK_IMAGE=${EMSDK_IMAGE:-emscripten/emsdk:1.39.17}

root=$(cd "$(dirname "$0")/../.." && pwd)
out="$root/public/vendor/stellarium"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git clone --quiet "$SWE_REPO" "$work/swe"
git -C "$work/swe" checkout --quiet "$SWE_REF"

# The image's apt sources are gone (Debian buster), so scons comes from pip.
docker run --rm -v "$work/swe:/app" "$EMSDK_IMAGE" /bin/bash -c \
  "python3 -m pip install -q 'scons==4.4.0' && source /emsdk/emsdk_env.sh >/dev/null && cd /app && make js; r=\$?; chown -R $(id -u):$(id -g) /app; exit \$r"

rm -rf "$out/skydata" "$out/fonts"
mkdir -p "$out/fonts"
cp "$work/swe/build/stellarium-web-engine.js" "$work/swe/build/stellarium-web-engine.wasm" "$work/swe/LICENSE-AGPL-3.0.txt" "$out/"
cp "$work/swe/apps/simple-html/static/fonts/"Roboto-*.ttf "$out/fonts/"
cp -r "$work/swe/apps/test-skydata" "$out/skydata"
rm -rf "$out/skydata/skycultures/belarusian"
# the flat 'zero' ground has no data in test-skydata, but the engine still fetches its description
mkdir -p "$out/skydata/landscapes/zero"
printf '<h2>Zero Horizon</h2>\n<p>A flat, featureless ground at altitude 0°.</p>\n' > "$out/skydata/landscapes/zero/description.en.utf8"

commit=$(git -C "$work/swe" rev-parse HEAD)
sed -i -E "s/^Commit: .*/Commit: $commit/" "$out/README.md"
echo "Stellarium Web Engine $commit -> $out"
