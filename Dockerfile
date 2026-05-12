# Helm13F — production image for Railway.
#
# Strategy: ship the TypeScript source + tsx runner. No compile step
# means smaller image surface and one less moving piece in the deploy.
# tsx is in dependencies so `pnpm install --prod` keeps it.
#
# Two entrypoints share this image, chosen by Railway service config:
#   - `pnpm start`           → HTTP MCP server (src/server/main.ts)
#   - `pnpm ingest:scheduled` → cron-triggered ingestion runner
#   - `pnpm migrate`         → one-shot migrations (run pre-deploy)

FROM node:20-alpine AS base
WORKDIR /app
# pnpm via corepack (Node 20 ships it).
RUN corepack enable && corepack prepare pnpm@10 --activate

# ---- deps stage ----
# Note: no `--mount=type=cache` here — Railway's Metal builder rejects
# anonymous BuildKit cache mounts (requires a cacheKey prefix on `id`).
# The install is fast enough without it for our deploy cadence.
FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ---- runtime stage ----
FROM base AS runtime
ENV NODE_ENV=production
# Health: Railway probes /health.
ENV PORT=8080

# Bring in installed node_modules.
COPY --from=deps /app/node_modules ./node_modules
# Application code.
COPY package.json pnpm-lock.yaml tsconfig.json .npmrc ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY superinvestors ./superinvestors

EXPOSE 8080
USER node

# Default command runs the MCP HTTP server. Railway service for the
# scheduled cron overrides with `pnpm ingest:scheduled`.
CMD ["pnpm", "start"]
