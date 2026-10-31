# server/Dockerfile
# Multi-stage build: compile TypeScript → copy only the compiled output + prod deps.
# Base image: node:22-alpine (small, security-maintained).
# Non-root user: node (built into the official image).
# HEALTHCHECK: hits GET /health every 30 s; marks container unhealthy if it fails.
#
# Build context should be the REPO ROOT so pnpm workspace resolution works.
# docker build -f server/Dockerfile -t waypoint-server .

# ─── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# Enable corepack so we get the exact pnpm version required by the workspace.
RUN corepack enable

WORKDIR /app

# Copy workspace manifests first — let Docker cache the install layer.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY server/package.json ./server/
COPY sdk/package.json    ./sdk/
COPY web/package.json    ./web/
COPY demo/package.json   ./demo/
COPY scripts/package.json ./scripts/

# Install ALL deps (including devDeps needed by tsc).
RUN pnpm install --frozen-lockfile

# Copy source and compile.
COPY tsconfig.base.json ./
COPY server/tsconfig.json ./server/
COPY server/src ./server/src
COPY web ./web

RUN pnpm --filter @waypoint/web build
RUN pnpm --filter @waypoint/server build

# ─── Stage 2: production image ────────────────────────────────────────────────
FROM node:22-alpine AS runner

RUN corepack enable

WORKDIR /app

# Copy workspace manifests needed for pnpm to install prod-only deps.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY server/package.json ./server/
# Stub other workspace packages so pnpm's workspace protocol resolves.
COPY sdk/package.json    ./sdk/
COPY web/package.json    ./web/
COPY demo/package.json   ./demo/
COPY scripts/package.json ./scripts/

# Install PRODUCTION dependencies only (no devDeps).
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from builder.
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/web/dist ./web/dist

# Run as non-root (node user, uid 1000, built into the official image).
USER node

ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

# PORT is injected at runtime by the host.
ENV NODE_ENV=production
EXPOSE 3000

# Health check — retries 3 times over 90 s before marking unhealthy.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

# Entry point: run the compiled JS directly with Node (no tsx in prod).
CMD ["node", "server/dist/index.js"]

