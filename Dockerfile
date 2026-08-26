# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# Zen Gateway — production image.
#
# Design notes:
# - Multi-stage build: build stage compiles the admin SPA (Vite/React) and
#   installs all backend deps; the final runtime stage discards devDependencies,
#   build tools (vite, tailwindcss, tsc, etc.), and admin source.
# - Base image is pinned to a specific Bun minor (oven/bun:1.3.14) — NOT
#   `latest`. `latest` is a moving target and silently pulls new Bun
#   versions into old images.
# - Non-root user (`bun` uid 1000) for the runtime. All copied files are
#   chown'd to bun:bun so no root privilege is required at startup.
# - HEALTHCHECK against /livez — no DB dependency. /livez is always cheap.
#   Orchestrators/HAProxy can use /readyz for traffic gating (Phase 3).
# - VERSION + GIT_SHA are passed at build time and surfaced at /version
#   for ops/deploy verification. They are NOT secrets — build metadata only.
# - No secrets, credentials, or .env files are baked into the image.
#   DATABASE_URL and all secrets must be injected at runtime via env_file
#   or the orchestrator's secret injection mechanism.
# -----------------------------------------------------------------------------

ARG BUN_VERSION=1.3.14
ARG OVEN_IMAGE=oven/bun:${BUN_VERSION}

# ---- Stage 1: build the admin SPA and install all backend deps ---------------
FROM ${OVEN_IMAGE} AS build

WORKDIR /app

# Copy the manifests first so the dependency install layer caches when only
# backend source changes. `bun.lock` is the lockfile (canonical for Bun).
COPY package.json bun.lock ./
COPY admin/package.json admin/bun.lock ./admin/

# Install all deps for the backend (including devDependencies for TS types).
RUN bun install --frozen-lockfile

# Install admin workspace deps for the SPA build.
RUN cd admin && bun install --frozen-lockfile

# Copy the source and run the SPA build. The backend is run directly from
# TS via Bun's transpile-and-execute — no separate backend compile step.
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
COPY tsconfig.json ./
COPY admin ./admin

RUN cd admin && bun run build

# ---- Stage 2: minimal runtime ------------------------------------------------
# Fresh layer — only the runtime artifacts, no build tools, no admin source,
# no admin node_modules (the SPA is already compiled into admin/dist).
FROM ${OVEN_IMAGE} AS runtime

ARG VERSION=dev
ARG GIT_SHA=unknown
ENV VERSION=${VERSION} \
    GIT_SHA=${GIT_SHA} \
    NODE_ENV=production \
    PORT=8787

# Run as the non-root `bun` user that the oven/bun image ships with (uid 1000).
# WORKDIR is set before USER so the directory is created by root then owned
# by bun after the subsequent chown on each COPY.
WORKDIR /app
USER bun

# Backend runtime files only.
# Correctness note: admin/node_modules is intentionally NOT copied here.
# The admin SPA (Vite/React/Tailwind) is a build artifact — everything
# the runtime needs from admin is in admin/dist. Copying admin/node_modules
# would bloat the image with ~100 MB of devDependencies and vite internals.
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun --from=build /app/node_modules ./node_modules
COPY --chown=bun:bun --from=build /app/admin/dist ./admin/dist
COPY --chown=bun:bun --from=build /app/src ./src
COPY --chown=bun:bun --from=build /app/migrations ./migrations
COPY --chown=bun:bun --from=build /app/tsconfig.json ./tsconfig.json

EXPOSE 8787

# Bun's built-in HTTP server. `--bun` is implicit when invoked via `bun run`.
# idleTimeout is set programmatically in src/index.ts (sized against the
# streaming idle timeout); the CLI flag is not available here.
CMD ["bun", "run", "src/index.ts"]

# Liveness probe: cheap check, no DB. Orchestrators use this to decide
# whether to restart the container. Never call /readyz here — that touches
# Postgres and would cause a container restart whenever PG is briefly busy.
#
# --interval: how often Docker checks (15s)
# --timeout:  time to wait for a response before marking failed (3s)
# --start-period: grace period before checks count toward retries (10s)
# --retries:  consecutive failures needed to mark unhealthy (3)
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e 'fetch("http://127.0.0.1:"+process.env.PORT+"/livez").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'