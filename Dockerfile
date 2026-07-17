## Root-context shim for deploys still building from the REPO ROOT.
## The real app lives in slate/ (see slate/Dockerfile); this mirrors it with
## slate/-prefixed COPY paths so a service configured with dockerfilePath
## ./Dockerfile and no root directory still builds. Once the Render service
## picks up `rootDir: slate` from render.yaml, slate/Dockerfile is used and
## this file is ignored. Keep the two in sync when changing build steps.
FROM node:22-alpine AS deps
WORKDIR /app
# npm-installed pnpm, not corepack — corepack's signature verification breaks
# on npm registry key rotations (see slate/Dockerfile).
RUN npm install -g pnpm@10.33.0
COPY slate/pnpm-workspace.yaml slate/package.json slate/pnpm-lock.yaml* ./
COPY slate/apps/client/package.json apps/client/
COPY slate/apps/server/package.json apps/server/
COPY slate/packages/sync-protocol/package.json packages/sync-protocol/
COPY slate/packages/mesh/package.json packages/mesh/
COPY slate/packages/fbx-export/package.json packages/fbx-export/
COPY slate/packages/ui-tokens/package.json packages/ui-tokens/
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY slate/ .
ENV NODE_OPTIONS=--max-old-space-size=1536
RUN pnpm --filter @slate/client build
RUN pnpm --filter @slate/server build
# pnpm prune is unsupported in workspaces; re-install prod-only instead.
RUN rm -rf node_modules apps/client/node_modules apps/server/node_modules packages/*/node_modules \
  && pnpm install --prod --frozen-lockfile=false

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/client/dist ./apps/client/dist
COPY --from=build /app/packages ./packages
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:8080/health || exit 1
CMD ["node", "apps/server/dist/index.js"]
