#!/bin/bash
set -e

echo "Starting local initialization..."

# Check Node.js
if ! command -v node >/dev/null; then
  echo "Node.js is not installed. Please install Node.js (version 22.22.3 or a supported newer LTS)." >&2
  exit 1
fi

node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); const supported = (major === 22 && (minor > 22 || (minor === 22 && patch >= 3))) || (major === 24 && minor >= 15) || major >= 26; if (!supported) { console.error("Use Node 22.22.3, Node 24.15+, or Node 26+."); process.exit(1); }'

# Check or install pnpm
if ! command -v pnpm >/dev/null; then
  echo "pnpm is not installed. Installing pnpm..."
  corepack enable
  corepack install
fi

# Check for openssl
if ! command -v openssl >/dev/null; then
  echo "openssl is not installed. Please install openssl." >&2
  exit 1
fi

# Install dependencies
echo "Installing dependencies with pnpm..."
pnpm install --frozen-lockfile
pnpm prepare:nuxt
pnpm --filter @delb/epub build

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
echo "Running database migrations..."
NODE_ENV=production pnpm db:migrate

echo "Initialization complete. You may now run:"
echo ""
echo "  pnpm dev        # for development"
echo "  pnpm preview    # for production (after pnpm build)"
echo ""
