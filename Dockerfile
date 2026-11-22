ARG NODE_VERSION=22.22.3

FROM node:${NODE_VERSION}-slim AS base
WORKDIR /app
# Install the pinned native pnpm once for all build stages. Corepack skips
# pnpm's install scripts and otherwise downloads its binary on first use.
COPY package.json ./
RUN npm install --global "$(node -p "require('./package.json').packageManager.split('+')[0]")" \
  && pnpm --version

# -------------------------------
# Dependencies stage (build)
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/epub/package.json ./packages/epub/package.json
RUN pnpm install --frozen-lockfile

# -------------------------------
# Build stage
FROM base AS build
ARG NUXT_PUBLIC_APP_VERSION=unknown
ENV NUXT_PUBLIC_APP_VERSION=${NUXT_PUBLIC_APP_VERSION}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build
# Resolve the migrator's external imports from Nitro's traced dependencies.
RUN ./node_modules/.bin/esbuild .drizzle/migrate.ts --platform=node --format=esm --target=node22 --bundle --packages=external --outfile=.output/server/migrate.mjs

# -------------------------------
# Runtime stage
FROM node:${NODE_VERSION}-slim AS runner

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

WORKDIR /app

# Create a system user for security
RUN addgroup --system --gid 1001 nodejs && \
  adduser --system --uid 1001 --home /home/nuxt nuxt

# Copy production build output
COPY --chown=nuxt:nodejs --from=build /app/.output .output

# Copy the SQL migrations and their journal (Drizzle Kit snapshots are build tooling).
COPY --chown=nuxt:nodejs .drizzle/migrations/*.sql ./.drizzle/migrations/
COPY --chown=nuxt:nodejs .drizzle/migrations/meta/_journal.json ./.drizzle/migrations/meta/

# Create writable data dir and set ownership
RUN mkdir -p /app/data && chown 1001:1001 /app /app/data

# Use volume for persistent DB
VOLUME ["/app/data"]

# Now switch to non-root user
USER nuxt

EXPOSE 3000

COPY --chown=nuxt:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", ".output/server/index.mjs"]
