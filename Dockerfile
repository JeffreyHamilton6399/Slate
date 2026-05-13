## Slate v2 — single-image deploy. Builds client + server into one runtime.
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
COPY packages/sync-protocol/package.json packages/sync-protocol/
COPY packages/mesh/package.json packages/mesh/
COPY packages/fbx-export/package.json packages/fbx-export/
COPY packages/ui-tokens/package.json packages/ui-tokens/
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm --filter @slate/client build
RUN pnpm --filter @slate/server build
RUN pnpm prune --prod

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
