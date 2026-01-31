# Docker

Delb’s Docker image runs the Nuxt server and maintains a persistent SQLite DB.

## Build

`docker build -t delb .`

## Run

This expects:

- a persistent volume mounted to `/app/data` for `data/delb.db`
- (optional) a Calibre library mounted to `/app/library`
- `BETTER_AUTH_SECRET` provided via env

Example:

`docker run --rm -p 3000:3000 -e BETTER_AUTH_SECRET=... -v delb-data:/app/data -v /path/to/calibre:/app/library delb`

## Migrations

Delb uses Drizzle SQL migrations from `.drizzle/migrations`. The container runs migrations on startup via `.drizzle/migrate.ts` (compiled to `.drizzle/migrate.mjs` during the Docker build).

When the schema changes, generate and commit migrations with `pnpm db:generate`.
