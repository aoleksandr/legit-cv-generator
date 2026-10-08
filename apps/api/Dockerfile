# syntax=docker/dockerfile:1
# Build context: repository root (see docker-compose.yml).

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true
# Prisma's schema engine (used by `migrate deploy`) needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @cv/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @cv/shared build && pnpm --filter @cv/api build
# Drop dev dependencies; the generated Prisma client is compiled into dist.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter @cv/api...

FROM base AS runtime
ENV NODE_ENV=production
ENV PRISMA_HIDE_UPDATE_MESSAGE=1
# JSON log lines; pino-pretty is a dev dependency and not in this image.
ENV LOG_PRETTY=false
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=build /app/apps/api/package.json /app/apps/api/prisma.config.ts apps/api/
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/api/assets apps/api/assets
COPY --from=build /app/apps/api/dist apps/api/dist
WORKDIR /app/apps/api
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=10 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Apply pending migrations, seed the test account outside production, then exec node so it
# receives SIGTERM directly (graceful pg-boss shutdown).
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && { [ \"$NODE_ENV\" = production ] || node prisma/seed.ts; } && exec node dist/main.js"]
