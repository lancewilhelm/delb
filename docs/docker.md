# Docker

Delb’s Docker image runs the Nuxt server and maintains a persistent SQLite DB.

## Build

`docker build -t delb .`

## Run

This expects:

- a persistent volume mounted to `/app/data` for `data/delb.db`
- (optional) a Calibre library mounted to `/app/calibre` (read-only input)
- a writable Delb library mounted to `/app/library`
- `BETTER_AUTH_SECRET` provided via env

Example:

`docker run --rm -p 3000:3000 -e BETTER_AUTH_SECRET=... -v delb-data:/app/data -v /path/to/calibre:/app/calibre:ro -v /path/to/delb-library:/app/library delb`

## Permissions

The container runs as a non-root user (`nuxt`, uid 1001). Any bind-mounted paths
must be writable by that user if you want to:

- upload/change covers
- delete books/files
- write the SQLite DB in `/app/data`

If your host uses a different owner (e.g. Unraid’s `nobody:users`), either:

- change ownership/permissions on the host so uid/gid 1001 can write, or
- run the container with a matching `--user` (uid:gid) for the mounted library.

Calibre can be mounted read-only at `/app/calibre`. Delb writes all managed files
to `/app/library`.

### Unraid user shares

Unraid user shares (`fuse.shfs`) can place files that appear in the same folder
on different backing disks or pools. When that makes a direct backup rename fail,
Delb copies the existing file to its transaction backup, flushes it to storage,
verifies its size and SHA-256 digest, and only then replaces the original. The
same journal and rollback behavior remain in effect.

Configuring the share split level so each author/book directory stays together
can reduce cross-disk I/O, but is not required for cover uploads to be safe.

## Migrations

Delb uses Drizzle SQL migrations from `.drizzle/migrations`. The container runs migrations on startup via `.drizzle/migrate.ts` (compiled to `.drizzle/migrate.mjs` during the Docker build).

When the schema changes, generate and commit migrations with `pnpm db:generate`.
