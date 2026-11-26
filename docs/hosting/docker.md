# Docker deployment

Delb publishes a minimal multi-architecture `FROM scratch` Docker image (`linux/amd64` and `linux/arm64`). The image contains the static Go binary (`/app/delb`) with the embedded Vue 3 web app, SQLite migrations, and CA certificates.

## Image tags

Images are published to GitHub Container Registry at `ghcr.io/lancewilhelm/delb`:

| Tag      | Contents                                                    |
| -------- | ----------------------------------------------------------- |
| `stable` | Latest stable release (`v1.0.0` and later). Recommended     |
| `vX.Y.Z` | Pinned release version, such as `v1.0.0`                    |
| `edge`   | Latest build from the `main` branch for testing new changes |

## Run with Docker

Delb expects:

- A persistent volume or bind mount at `/app/data` for `delb.db` and server logs.
- A writable bind mount or volume at `/app/library` for managed ebooks, covers, storage locks, and operation journals.
- `BETTER_AUTH_SECRET` set to a persistent random secret (at least 32 characters recommended).
- `BETTER_AUTH_URL` set to the URL that you open in your browser, including scheme and port when non-standard.
- Optional `/app/dropbox` (writable) for local folder ingestion.
- Optional `/app/calibre` (read-only) for migrating an existing Calibre library.

For a local install, run the following command. Save the generated secret if
you plan to recreate the container.

```sh
DELB_AUTH_SECRET="$(openssl rand -hex 32)"
docker run -d \
  --name delb \
  -p 127.0.0.1:3000:3000 \
  -e BETTER_AUTH_SECRET="$DELB_AUTH_SECRET" \
  -e BETTER_AUTH_URL="http://localhost:3000" \
  -v delb-data:/app/data \
  -v delb-library:/app/library \
  ghcr.io/lancewilhelm/delb:stable
```

For Docker Compose, save this example as `compose.yaml`. Replace the secret
with the output of `openssl rand -hex 32`, then run `docker compose up -d`.

```yaml
services:
  delb:
    image: ghcr.io/lancewilhelm/delb:stable
    restart: unless-stopped
    ports:
      - '127.0.0.1:3000:3000'
    environment:
      BETTER_AUTH_SECRET: 'replace-with-a-random-32-byte-secret'
      BETTER_AUTH_URL: 'http://localhost:3000'
    volumes:
      - delb-data:/app/data
      - delb-library:/app/library
      # Optional:
      # - ./dropbox:/app/dropbox
      # - /path/to/calibre:/app/calibre:ro

volumes:
  delb-data:
  delb-library:
```

Open `http://localhost:3000` and register the first account. That account becomes
the Owner. Before making Delb reachable from other machines, review **Allow
Registration** under **Settings → Admin → Users**. If you later use a different
address, update `BETTER_AUTH_URL` to match the address you open in your browser.

See [Host Delb](README.md#deployment-configuration) for all supported environment variables, including `BETTER_AUTH_TRUSTED_ORIGINS`, `DATABASE_URL`, `DELB_LIBRARY_DIR`, and log settings.

## Permissions

The image runs as the non-root user `delb` (UID `1001`, GID `1001`) by default. It also creates a sticky writable `/tmp` directory (mode `1777`) so SQLite temporary files work under both the default user and custom `--user` mappings.

Bind-mounted directories under `/app/data`, `/app/library`, and `/app/dropbox` must be writable by the container user so Delb can write `delb.db`, create logs, upload books and covers, and delete files.

If your host uses a different owner, either:

- Change ownership or permissions on the host directories so UID `1001`, GID `1001` can write to them, or
- Run the container with `--user <uid>:<gid>` matching the owner of your mounted directories.

Mount `/app/calibre` read-only (`:ro`). Delb copies imported files into `/app/library` and never writes to `/app/calibre`.

## Unraid setup

You can run Delb as a custom Docker container on Unraid using the published GHCR image:

- **Repository:** `ghcr.io/lancewilhelm/delb:stable` (or `ghcr.io/lancewilhelm/delb:edge` to track `main`).
- **Port:** Map container port `3000` (TCP) to your preferred host port.
- **Paths:**
  - `/app/data` (Read/Write): Persistent SQLite database (`delb.db`) and rotating logs.
  - `/app/library` (Read/Write): Delb's managed books, covers, `.delb-locks`, and operation journals.
  - `/app/dropbox` (Read/Write, optional): Local folder watched for automatic book ingestion.
  - `/app/calibre` (Read Only, optional): Source Calibre library for one-way migration.
- **Environment variables:**
  - `BETTER_AUTH_SECRET`: Required persistent random secret (at least 32 characters).
  - `BETTER_AUTH_URL`: The full URL that you use to access Delb in a browser, such as `http://<unraid-ip>:<port>` or `https://books.example.com`.
  - `BETTER_AUTH_TRUSTED_ORIGINS`: Optional comma-separated list of additional allowed origins when accessing Delb through multiple addresses or a reverse proxy.
- **User ownership:** Unraid shares are normally owned by `nobody:users` (UID `99`, GID `100`). Either add `--user 99:100` to the container's **Extra Parameters**, or make the mapped host directories writable by `1001:1001`.

### Unraid user shares

Unraid user shares (`fuse.shfs`) can place files that appear in the same folder on different backing disks or pools. When that layout causes a direct rename to fail with `EXDEV` or `EUCLEAN`, Delb falls back to copying the file to an exclusive destination, syncing it to storage, verifying its size and SHA-256 digest, and only then removing the source. The same operation journal and rollback behavior stay in effect.

Configure the share split level so each author and book directory stays on one disk, which reduces cross-disk copies. Delb also relies on SQLite locking for both `/app/data/delb.db` and `/app/library/.delb-locks`, so verify SQLite locking and recovery behavior on your chosen share or pool. Automated tests exercise `EXDEV` and `EUCLEAN` with injected faults; they do not certify a real Unraid share or power-loss durability. See [storage recovery](storage-recovery.md).

## Build from source

To build the image locally:

```sh
docker build --build-arg APP_VERSION="$(git rev-parse --short=7 HEAD)" -t delb .
```

**Settings → General → About** displays the version string that Vite bakes into the web bundle at build time from `APP_VERSION`. Published images set this build argument automatically. Local Docker builds need `--build-arg APP_VERSION=...` because `.dockerignore` excludes Git metadata; without it, the UI reports `unknown`. The Go server also logs `APP_VERSION` at startup.

## Migrations

Delb embeds its SQLite migrations from `.drizzle/migrations` into the Go binary (`embed_migrations.go`). The `/app/delb` binary applies pending migrations automatically on startup before accepting requests. To run migrations without starting the HTTP server, run `/app/delb --migrate-only`.
