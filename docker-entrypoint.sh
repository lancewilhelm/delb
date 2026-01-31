#!/bin/sh

set -e

# Paths
DB_PATH=/app/data/delb.db

# Require BETTER_AUTH_SECRET (handled via env in production deployments)
if [ -z "$BETTER_AUTH_SECRET" ]; then
  echo "ERROR: BETTER_AUTH_SECRET must be set (refusing to auto-generate in production)." >&2
  exit 1
fi

# Set DATABASE_URL for Drizzle
export DATABASE_URL="${DATABASE_URL:-file:$DB_PATH}"

echo "Running database migrations..."
NODE_ENV=production node ./.drizzle/migrate.mjs

echo "Starting Delb..."
exec "$@"
