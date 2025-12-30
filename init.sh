#!/bin/bash
set -e

echo "Starting local initialization..."

# Check Node.js
if ! command -v node >/dev/null; then
  echo "Node.js is not installed. Please install Node.js (version 20+ recommended)." >&2
  exit 1
fi

# Nuxt's tooling can be sensitive to very new Node majors. Prefer Node 20/22.
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js version is too old. Please install Node.js 20+." >&2
  echo "Detected: $(node --version)" >&2
  exit 1
fi

if [ "$NODE_MAJOR" -gt 22 ]; then
  echo "Warning: Detected Node.js $(node --version). This project is tested primarily on Node 20/22." >&2
  echo "If you hit errors during 'nuxt prepare', try switching to Node 22 (or 20) via your version manager." >&2
fi

# Check or install pnpm
if ! command -v pnpm >/dev/null; then
  echo "pnpm is not installed. Installing pnpm..."
  corepack enable
  corepack prepare pnpm@latest --activate
fi

# Check for openssl
if ! command -v openssl >/dev/null; then
  echo "openssl is not installed. Please install openssl." >&2
  exit 1
fi

# Install dependencies
echo "Installing dependencies with pnpm..."
pnpm install --frozen-lockfile

# Create data directory
mkdir -p ./data

# Check and set AUTH_SECRET in .env
if [ ! -f .env ]; then
  echo "Creating .env file with a generated AUTH_SECRET."
  AUTH_SECRET=$(openssl rand -base64 32)
  echo "AUTH_SECRET=$AUTH_SECRET" >.env
elif grep -q '^AUTH_SECRET=' .env; then
  # Extract existing value
  EXISTING_SECRET=$(grep '^AUTH_SECRET=' .env | cut -d '=' -f2-)
  if [ -z "$EXISTING_SECRET" ]; then
    AUTH_SECRET=$(openssl rand -base64 32)
    # Replace empty AUTH_SECRET value with new secret
    sed -i.bak "s|^AUTH_SECRET=.*|AUTH_SECRET=$AUTH_SECRET|" .env
    rm -f .env.bak
    echo "Populated empty AUTH_SECRET in .env with a generated value."
  else
    echo "AUTH_SECRET already set in .env. Leaving it unchanged."
  fi
else
  AUTH_SECRET=$(openssl rand -base64 32)
  echo "AUTH_SECRET=$AUTH_SECRET" >>.env
  echo "Added AUTH_SECRET to existing .env file."
fi

# Export DATABASE_URL (for local Drizzle migrations)
export DATABASE_URL="file:$(pwd)/data/delb.db"

# Run Drizzle migrations
echo "Running Drizzle database schema push..."
NODE_ENV=production npx --yes drizzle-kit push --config=drizzle.config.ts

echo "Initialization complete. You may now run:"
echo ""
echo "  pnpm dev        # for development"
echo "  pnpm start      # for production (if built)"
echo ""
