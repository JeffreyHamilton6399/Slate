## Slate v2 — single-image deploy. Builds client + server into one runtime.
FROM node:22-alpine AS deps
WORKDIR /app
# Install pnpm via npm, NOT corepack: corepack downloads pnpm at build time and
# verifies it against baked-in registry signing keys — when npm rotates those
# keys (it has, repeatedly), every fresh build exits 1 with a signature error
# even though nothing in the repo changed. npm -g is boring and reliable.
RUN npm install -g pnpm@10.33.0
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
# Cap the JS heap: constrained builders (Render free tier) can OOM-kill the
# vite build; an explicit limit keeps node within the container's budget.
ENV NODE_OPTIONS=--max-old-space-size=1536
RUN pnpm --filter @slate/client build
RUN pnpm --filter @slate/server build
# pnpm prune is unsupported in workspaces; re-install prod-only instead.
# node_modules must go first: pnpm refuses to mutate a modules dir whose
# recorded install options (scripts/dev-deps) differ from the new flags.
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
