# syntax=docker/dockerfile:1
# =============================================================================
# FAN (Fast Agents Network) — multi-stage build
#   builder: full monorepo build (10 packages + dashboard) under oven/bun:1
#   runtime: oven/bun:1-slim with dist + production node_modules only
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: builder
# -----------------------------------------------------------------------------
FROM oven/bun:1 AS builder

WORKDIR /app

# Node.js + npm are required only as script runners for the workspace build
# (root `npm run build` chain, prisma generate, vite build). Debian trixie
# ships Node 20.19 which satisfies engines (>=20) and Vite 7.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends nodejs npm \
	&& rm -rf /var/lib/apt/lists/*

# Install dependencies from the bun lockfile
# (no --frozen-lockfile: local bun.lock was written by an older bun and
# triggers a spurious "lockfile had changes" error on nested overrides)
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install

# Copy the rest of the sources
COPY . .

# Full build: 10 packages (tsgo; packages/db build runs `prisma generate`)
RUN npm run build

# Dashboard bundle (served by api-gateway from packages/dashboard/dist).
# dashboard depends on web-ui via `file:../web-ui`; bun snapshots file: deps
# into its store at install time (before dist exists), so re-link the dep to
# the real workspace package after the build.
RUN rm -rf packages/dashboard/node_modules/@seaagents/fan-web-ui \
	&& ln -s ../../../web-ui packages/dashboard/node_modules/@seaagents/fan-web-ui
RUN npm --prefix packages/dashboard run build

# Prepare a lean deploy context: all package.json files (workspace layout must
# match the lockfile) + built dist directories only.
RUN mkdir -p /deploy \
	&& cp package.json bun.lock /deploy/ \
	&& find . -name node_modules -prune -o -name package.json -print \
		| while read -r f; do \
			mkdir -p "/deploy/$(dirname "$f")"; \
			cp "$f" "/deploy/$f"; \
		done \
	&& for p in packages/*; do \
			if [ -d "$p/dist" ]; then \
				mkdir -p "/deploy/$p"; \
				cp -r "$p/dist" "/deploy/$p/dist"; \
			fi; \
		done \
	&& mkdir -p /deploy/prisma-gen \
	&& cp -r /app/node_modules/.bun/@prisma+client@*/node_modules/.prisma /deploy/prisma-gen/.prisma \
	&& find /deploy/prisma-gen -type f -name "*query_engine*" ! -name "*debian-openssl-3.0.x*" -delete \
	&& node -e "const fs=require('fs'); for (const p of ['/deploy/packages/web-ui/package.json','/deploy/packages/dashboard/package.json']) { const j=JSON.parse(fs.readFileSync(p,'utf8')); delete j.dependencies; delete j.devDependencies; fs.writeFileSync(p, JSON.stringify(j,null,2)); }"

# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
FROM oven/bun:1-slim AS runtime

# Prisma query engine needs OpenSSL 3; ca-certificates for outbound HTTPS.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production-only dependencies (workspace symlinks preserved).
# NOTE: the repo bun.lock is rejected by `bun install --production` under
# bun 1.3 ("lockfile had changes, but lockfile is frozen" — stale lockfile vs
# nested overrides), so production deps are resolved fresh without a lockfile.
# Everything happens in a single layer so deletions actually shrink the image:
#   - generated Prisma client (from builder, in /deploy/prisma-gen, already
#     trimmed to the debian-openssl-3.0.x engine) is placed next to
#     @prisma/client in bun's isolated store and symlinked into the app's
#     well-known engine lookup dir (~/.local/share/fan/node_modules/.prisma,
#     see resolvePrismaEngine() in packages/db/src/client.ts)
#   - prisma CLI package is dropped (build-time only, ~50MB)
#   - musl native variants are dropped (runtime is debian gnu)
#   - unused prisma wasm-edge runtimes (library engine is used) + source maps
#   - bun's download cache is wiped (~800MB of layer bloat)
#   - devDependencies leaked by `bun install --production` into workspaces
#     (typescript, vite, tailwind, @types, ...) are pruned manually
#   - web-ui/browser-only packages never loaded by the server (mini-lit,
#     lucide, katex) are pruned
COPY --from=builder /deploy ./
RUN set -e; \
	rm -f bun.lock; \
	bun install --production --ignore-scripts; \
	dir=$(echo /app/node_modules/.bun/@prisma+client@*/node_modules); \
	cp -r /app/prisma-gen/.prisma "$dir/.prisma"; \
	rm -rf /app/prisma-gen; \
	mkdir -p /root/.local/share/fan/node_modules/.prisma; \
	ln -sfn "$dir/.prisma/client" /root/.local/share/fan/node_modules/.prisma/client; \
	find "$dir/@prisma/client/runtime" -name "*.wasm-base64.*" -delete; \
	find "$dir/@prisma/client/runtime" -name "*.map" -delete; \
	cd /app/node_modules/.bun && rm -rf \
		prisma@* \
		@napi-rs+canvas-linux-x64-musl@* \
		lightningcss-linux-x64-musl@* \
		lightningcss@* lightningcss-linux-x64-gnu@* \
		typescript@* tsx@* esbuild@* @esbuild+* \
		vite@* @vitejs+* \
		@tailwindcss+* tailwindcss@* \
		@types+* \
		vitest@* jsdom@* happy-dom@* \
		@mariozechner+mini-lit@* lucide@* katex@* \
		/root/.bun/install/cache

# Data directory: SQLite DB (fan.db) + JSONL sessions live here.
# Mount a volume at /data to persist them.
#   FAN_CODING_AGENT_DIR — used by config.ts getAgentDir()
#   FAN_AGENT_DIR        — used by packages/db client.ts for DATABASE_URL default
ENV FAN_CODING_AGENT_DIR=/data/.fan/agent \
	FAN_AGENT_DIR=/data/.fan/agent \
	HOST=0.0.0.0 \
	PORT=3456 \
	NODE_ENV=production

EXPOSE 3456
VOLUME ["/data"]

# Server mode: REST + WebSocket API gateway on 0.0.0.0:3456
CMD ["bun", "packages/coding-agent/dist/cli.js", "server"]
