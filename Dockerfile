ARG NODE_VERSION=20
ARG PNPM_VERSION=10.27.0

FROM node:${NODE_VERSION}-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# -------------------------------
# Dependencies stage (build)
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# -------------------------------
# Production dependencies stage (runtime)
FROM base AS prod-deps
ENV NODE_ENV=production
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# -------------------------------
# Build stage
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN ./node_modules/.bin/esbuild .drizzle/migrate.ts --platform=node --format=esm --target=node20 --bundle --packages=external --outfile=.drizzle/migrate.mjs
RUN pnpm build

# -------------------------------
# Runtime stage
FROM node:${NODE_VERSION}-slim AS runner

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ARG NUXT_PUBLIC_APP_VERSION=manual
ENV NUXT_PUBLIC_APP_VERSION=${NUXT_PUBLIC_APP_VERSION}

WORKDIR /app

# Create a system user for security
RUN addgroup --system --gid 1001 nodejs && \
  adduser --system --uid 1001 --home /home/nuxt nuxt

# Copy production build output
COPY --chown=nuxt:nodejs --from=build /app/.output .output

# Copy runtime deps (prod only)
COPY --chown=nuxt:nodejs --from=prod-deps /app/node_modules ./node_modules

# Copy runtime source files referenced by Nitro/server routes (Nuxt aliases to ~/utils/**)
COPY --chown=nuxt:nodejs --from=build /app/app/utils ./app/utils

# Copy migrations + migrator script
COPY --chown=nuxt:nodejs --from=build /app/.drizzle ./.drizzle

# Create writable data dir and set ownership
RUN mkdir -p /app/data && chown -R 1001:1001 /app

# Use volume for persistent DB
VOLUME ["/app/data"]

# Now switch to non-root user
USER nuxt

EXPOSE 3000

COPY --chown=nuxt:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", ".output/server/index.mjs"]
