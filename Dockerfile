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

# syntax=docker/dockerfile:1.6

FROM node:20-alpine AS base
WORKDIR /app
# pnpm via corepack (Node 20 ships it).
RUN corepack enable && corepack prepare pnpm@10 --activate

# ---- deps stage: cache-friendly install ----
FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

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
