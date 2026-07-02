# ── ShowRunr relay image (design-relay-cloud.md §7 chunk 3) ───────────────────
# Multi-stage: esbuild bundles relay/start.ts (+ lib/ imports + ws) into one
# CJS file, so the runtime layer is node + a single ~200KB script. No npm, no
# node_modules, no TS at runtime.
#
# Build context is the REPO ROOT (fly.toml lives there; this file is
# relay/Dockerfile) because the relay imports from ../lib.

FROM node:22-alpine AS build
WORKDIR /app
# Only the two build-time packages — NOT the app's full dependency tree.
# ws is pinned to the app's package.json range so client/server stay in step.
RUN npm install --no-save ws@^8.21.0 esbuild@^0.25.0
COPY lib ./lib
COPY relay ./relay
# bufferutil/utf-8-validate are ws's OPTIONAL native accelerators, loaded in a
# try/require. We don't install them; mark external so the bundle resolves.
RUN npx esbuild relay/start.ts --bundle --platform=node --format=cjs \
    --external:bufferutil --external:utf-8-validate \
    --outfile=dist/relay.cjs

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist/relay.cjs ./relay.cjs
# /data is the persistent volume (fly.toml [mounts]) — the room journal's
# grant-counter monotonicity across restarts is a PROTOCOL invariant (S5).
ENV RELAY_PORT=8787 \
    RELAY_JOURNAL=/data/relay-journal.json
EXPOSE 8787
CMD ["node", "relay.cjs"]
