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

ARG OMP_VERSION=latest
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
COPY scripts ./scripts

ENV NODE_ENV=production \
    DATA_DIR=/data \
    LIBRARY_DIR=/library \
    WEB_PORT=8080

RUN mkdir -p /data /library && chmod 777 /data /library
VOLUME ["/data", "/library"]
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
