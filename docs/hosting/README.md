# Host Delb

Delb needs a persistent SQLite database and a writable managed library directory. Container restarts must preserve both.

## Quick start

### Docker

For an install on your own machine, run this command with Docker and OpenSSL
installed. Keep the generated secret for future container replacements.

```sh
DELB_AUTH_SECRET="$(openssl rand -hex 32)"
docker run -d \
  --name delb \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e BETTER_AUTH_SECRET="$DELB_AUTH_SECRET" \
  -e BETTER_AUTH_URL=http://localhost:3000 \
  -v delb-data:/app/data \
  -v delb-library:/app/library \
  ghcr.io/lancewilhelm/delb:stable
```

Open `http://localhost:3000` and register the first account, which becomes the
Owner. The two named volumes keep your database and books between container
replacements.

### Unraid

In the Unraid web UI, open **Docker → Add Container**. This example uses a pool
named `cache` and an Unraid server at `192.168.1.20`. Use your own pool name and
server IP.

| Field                         | Example value                                                      |
| ----------------------------- | ------------------------------------------------------------------ |
| Name                          | `delb`                                                             |
| Repository                    | `ghcr.io/lancewilhelm/delb:stable`                                 |
| Network Type                  | Bridge                                                             |
| Port (TCP)                    | Host `3080` to container `3000`                                    |
| Path (Read/Write)             | Host `/mnt/cache/appdata/delb/data` to container `/app/data`       |
| Path (Read/Write)             | Host `/mnt/cache/appdata/delb/library` to container `/app/library` |
| Variable `BETTER_AUTH_SECRET` | Output of `openssl rand -hex 32`. Keep the same value on updates.  |
| Variable `BETTER_AUTH_URL`    | `http://192.168.1.20:3080`                                         |

Create both host folders and make them writable by UID/GID `1001:1001`.
If they are already writable by `99:100`, you can set `--user 99:100`
in **Advanced View → Extra Parameters**. Create the container, open the URL
you set above, and register the Owner account.

See the [Docker hosting guide](docker.md) for Compose, permissions,
and optional mounts.

## Deployment configuration

| Setting or path               | Purpose                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`          | Stable authentication secret, required when `NODE_ENV=production` (the Docker default). `AUTH_SECRET` is also accepted |
| `BETTER_AUTH_URL`             | Public origin used in the browser, including scheme and non-standard port; controls secure cookies and CSRF checks     |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Comma-separated additional trusted origins for auth requests (supports simple `*` wildcards)                           |
| `DATABASE_URL`                | Local SQLite file path or `file:` URL; defaults to `file:./data/delb.db` (`/app/data/delb.db` in Docker)               |
| `DELB_LIBRARY_DIR`            | Managed library directory; defaults to `library` (`/app/library` in Docker)                                            |
| `HOST` and `PORT`             | Server bind address and port; the container sets `HOST=0.0.0.0` and `PORT=3000`                                        |
| `LOG_LEVEL` and `LOG_FORMAT`  | Log verbosity (`debug`, `info`, `warn`, `error`) and format (`text` or `json`)                                         |
| `DELB_LOG_DIR`                | Rotating log directory; defaults to `logs/` next to the database file (`/app/data/logs` in Docker)                     |
| `DELB_AUTO_MIGRATE`           | Set to `false` or `0` to skip automatic startup migrations (defaults to `true`)                                        |
| `/app/data`                   | Persistent SQLite database (`delb.db`) and default rotating log directory                                              |
| `/app/library`                | Writable managed ebooks, covers, storage locks, and operation journals                                                 |
| `/app/dropbox`                | Optional writable local ingestion directory                                                                            |
| `/app/calibre`                | Optional read-only Calibre import source                                                                               |

Store `BETTER_AUTH_SECRET` through your deployment's secret configuration and keep it stable across restarts. Configure `BETTER_AUTH_URL` to match the address that users open in the browser.

Experimental ChatGPT spine generation uses one shared connection configured under **Settings → Admin → Spine generation**. Every book editor can use that connection for books that they can edit. Delb encrypts the provider tokens in the database with a key derived from `BETTER_AUTH_SECRET`. Use a persistent secret of at least 32 characters and keep it separate from database backups, because anyone with both the database and the secret can decrypt those tokens. Changing or losing the secret requires an administrator to reconnect ChatGPT. An interrupted token refresh also requires reconnecting, and restoring an older database backup can invalidate an active connection. Disconnecting removes the shared credentials locally without revoking them remotely. Active sign-in attempts live in server memory and must restart if the server restarts. In a multi-instance deployment, route the sign-in attempt and its polling requests to the same server process.

The Docker image runs as non-root user `delb` (UID `1001`, GID `1001`) by default and includes a writable `/tmp` directory (`1777`). Make sure that the mounted writable directories allow UID/GID `1001` to write, or run the container with a matching `--user` value. Library storage also requires working SQLite locking semantics. See [filesystem requirements](storage-recovery.md#ownership-and-filesystem-requirements) and [Unraid setup](docker.md#unraid-setup).

## Initialize an installation

1. Prepare persistent storage for `/app/data` and `/app/library`.
2. Set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`.
3. Start the container. The `/app/delb` binary applies pending embedded SQLite migrations and reconciles storage recovery before serving HTTP requests.
4. Open Delb and register the first account, which becomes the system owner.
5. Sign in as the owner and review global registration, metadata provider, and ingestion settings.

Expected result: the owner can sign in, open **Books**, and add a book. Keep the service stopped if startup reports an unresolved storage recovery error.

For development or a disposable local demonstration, use the [contributor guide](../developing/README.md). Demo fixture commands are not for production installations.

## Upgrade and preserve recoverability

1. Stop Delb and any background writers before taking a backup.
2. Back up the SQLite database directory and the managed library together. Keep operation journals and lock files intact inside the backup.
3. Record the current configuration and application version alongside the backup.
4. Start the new version and let embedded migrations and storage recovery complete.
5. Check sign-in, book visibility, a file download, and personal reading data before resuming normal use.

To restore, stop Delb and restore the matching database and library backups together with the matching application version and configuration. Do not combine an older database with newer library contents, and do not assume that an older binary understands a newer schema.

See [storage recovery](storage-recovery.md) for interrupted operations and filesystem limits. Rehearse your restore procedure on your own deployment before relying on it.

## Ingestion and administration

- Use [Calibre import](calibre-import.md) for a one-way migration from an existing Calibre library. Keep the Calibre directory mounted read-only and keep a backup of the source.
- Configure **Settings → Admin → Dropbox** for a local ingestion directory, allowed file extensions, and the importing user. This watches a local filesystem folder, not the Dropbox cloud service. Imported books go into the shared library, and the importing user must be an Editor or Admin.
- Configure Google Books and Hardcover under **Settings → Admin → Metadata**. Secrets stay on the server; clients receive only an availability flag. See [metadata providers](../developing/reference/metadata.md).
- Run [health checks](health-checks.md) from **Settings → Admin → Library**. Quick checks inspect database conditions; deep checks also run bounded file, cover, thumbnail, and fuzzy duplicate checks.
- Inspect recent server logs under **Settings → Admin → Logs** or in the rotating log files under `/app/data/logs`.

Do not delete `.delb-*` journals or `.delb-locks` databases to clear an error. Follow the [storage recovery instructions](storage-recovery.md) instead.

## Upgrading from pre-1.0 preview versions

`v1.0.0` is the first public release and starts from a squashed baseline migration (`0000_initial.sql`). New installations do not need any upgrade steps.

If you are upgrading an existing pre-1.0 preview server that still uses the earlier collections model, read [Upgrade to a single library](single-library-upgrade.md) before starting `v1.0.0`. Those databases must first run `v0.2.1` to apply migration `0022_single_library`, which merges collections into the single shared library and makes every book visible until an administrator adds tag visibility rules.

## Deployment evidence

The documentation verification suite exercises an isolated loopback demo with synthetic data. It does not certify Docker execution on every host, a real Unraid user share, arbitrary network filesystems, reverse-proxy setups, or live metadata-provider availability. See the [verification record](../developing/documentation-status.md).
