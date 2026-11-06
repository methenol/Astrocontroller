# syntax=docker/dockerfile:1.7
############################ build ############################
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

############################ runtime ##########################
FROM node:22-bookworm-slim

# Pinned: "latest" broke the build when omp 18.13.3 raised its Bun floor to 1.4.4.
# Bump the two together (npm view @oh-my-pi/pi-coding-agent@<version> engines).
ARG OMP_VERSION=18.13.2
ARG BUN_VERSION=1.3.14

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl unzip git ripgrep tini \
 && rm -rf /var/lib/apt/lists/*

# Oh My Pi (pi coding agent fork) runs on Bun.
ENV BUN_INSTALL=/opt/bun
ENV PATH=/opt/bun/bin:$PATH
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && bun install -g "@oh-my-pi/pi-coding-agent@${OMP_VERSION}" \
 && chmod -R a+rX /opt/bun \
 && omp --version

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY agent ./agent
COPY catalog ./catalog
COPY devices ./devices
COPY scripts ./scripts

ENV NODE_ENV=production \
    DATA_DIR=/data \
    LIBRARY_DIR=/library \
    WEB_PORT=8080

RUN mkdir -p /data /library && chmod 777 /data /library
VOLUME ["/data", "/library"]
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
# The profile hub: one Astrocontroller process per active telescope profile (src/hub/main.ts).
# CMD ["node", "dist/index.js"] runs the single-telescope app directly, as before the hub.
CMD ["node", "dist/hub/main.js"]
