ARG NODE_VERSION=20

# Base stage with slim Node image
FROM node:${NODE_VERSION}-slim AS base
WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# -------------------------------
# Dependencies stage
FROM base AS deps

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# -------------------------------
# Build stage
FROM base AS build

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Optional: pre-create the data dir (won't be used in build output, just useful now)
RUN mkdir -p ./data

# Build the Nuxt app
RUN pnpm build

# -------------------------------
# Runtime stage
FROM base AS runner

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000


# Default secrets can be overridden at runtime
ENV BETTER_AUTH_SECRET=""
ENV BETTER_AUTH_TRUSTED_ORIGINS=""
ARG NUXT_PUBLIC_APP_VERSION=manual
ENV NUXT_PUBLIC_APP_VERSION=${NUXT_PUBLIC_APP_VERSION}

# Create a system user for security
RUN addgroup --system --gid 1001 nodejs && \
  adduser --system --uid 1001 --home /home/nuxt nuxt

# Copy production build output
COPY --chown=nuxt:nodejs --from=build /app/.output .output


# Copy schema + drizzle artifacts if needed at runtime
COPY --from=build /app/node_modules ./node_modules
COPY --chown=nuxt:nodejs --from=build /app/app/utils ./app/utils
COPY --chown=nuxt:nodejs --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --chown=nuxt:nodejs --from=build /app/drizzle ./drizzle
COPY --chown=nuxt:nodejs --from=build /app/package.json ./package.json

# Create writable data dir and set ownership
RUN mkdir -p /app/data && chown -R 1001:1001 /app

# Use volume for persistent DB
VOLUME ["/app/data"]

# Now switch to non-root user
USER nuxt
WORKDIR /app

EXPOSE 3000

COPY --chown=nuxt:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", ".output/server/index.mjs"]

