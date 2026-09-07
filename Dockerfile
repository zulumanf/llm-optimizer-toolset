# Web app image (spec 059). Host-agnostic: Railway, Fly, Render, or a VPS.
# The worker is a SEPARATE process — build Dockerfile.worker alongside this;
# a deployment without the worker queues every run forever (docs/deployment.md).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time env: no runtime secret is needed to compile, but env
# validation (lib/env.ts) runs during Next's page-data collection, so the
# schema needs a syntactically valid DATABASE_URL. This dummy is never
# connected to — every page is force-dynamic — and the runtime stage gets
# the real value from the platform's environment.
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Standalone output carries its own pruned node_modules.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
# The platform health check: GET /api/health (unauthenticated minimal shape).
CMD ["node", "server.js"]
