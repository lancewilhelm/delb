#!/bin/sh

set -e

# Paths
DB_PATH=/app/data/delb.db
KEY_FILE=/app/data/auth_secret.key

# Generate BETTER_AUTH_SECRET if not provided
if [ -z "$BETTER_AUTH_SECRET" ]; then
  if [ ! -f "$KEY_FILE" ]; then
    echo "BETTER_AUTH_SECRET not provided — generating one..."
    head -c 32 /dev/urandom | base64 >"$KEY_FILE"
  fi
  echo "Loading BETTER_AUTH_SECRET from $KEY_FILE..."
  export BETTER_AUTH_SECRET=$(cat "$KEY_FILE")
fi

# Set DATABASE_URL for Drizzle
export DATABASE_URL="file:$DB_PATH"

echo "Pushing database schema..."
NODE_ENV=production npx --yes drizzle-kit push --config=drizzle.config.ts

echo "Starting Nuxt app..."
exec "$@"
