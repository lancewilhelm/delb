# Host Delb

Delb needs a persistent database and a writable managed library. A container restart must preserve both. Start with [Docker deployment](docker.md) for the image build, runtime mounts, permissions, and startup migrations.

## Deployment configuration

| Setting or path               | Purpose                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`          | Stable authentication secret, required by the production entrypoint               |
| `BETTER_AUTH_URL`             | Public origin used for authentication, including scheme and port where applicable |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Comma-separated trusted origins for authentication requests                       |
| `DATABASE_URL`                | Defaults to `file:./data/delb.db`; the container sets a default under `/app/data` |
| `/app/data`                   | Persistent default SQLite database                                                |
| `/app/library`                | Writable managed ebooks, covers, storage locks, and journals                      |
| `/app/dropbox`                | Optional writable local ingestion directory                                       |
| `/app/calibre`                | Optional read-only Calibre import source                                          |

Store the authentication secret through your deployment's secret configuration. Keep it stable across restarts. Configure the public origin to match the address used in the browser.

The image runs as UID/GID 1001 by default. Ensure the mounted writable directories permit that user to write, or choose a matching runtime user. Library storage also needs working SQLite locking semantics. See [filesystem requirements](storage-recovery.md#ownership-and-filesystem-requirements).

## Initialize an installation

1. Prepare the database and library volumes.
2. Configure authentication and origins.
3. Start the container. Its entrypoint applies committed migrations before starting the Nuxt server.
4. Open Delb and register the first account.
5. Review global registration and ingestion settings as the system owner.

Expected result: the owner can sign in, open the shared Default collection, and add a book. Keep the service stopped if startup reports an unresolved storage recovery error.

For development or a disposable local demonstration, use the [contributor guide](../developing/README.md). Demo fixture commands are not production initialization commands.

## Upgrade and preserve recoverability

1. Stop Delb writers, including background ingestion, before taking a consistent backup.
2. Back up the database and managed library together. Preserve operation journals and related files.
3. Retain the current configuration and application version with the backup.
4. Start the new version and allow committed migrations and storage recovery to complete.
5. Check sign-in, book visibility, a download, and personal reading data before resuming normal use.

To restore, stop all writers and restore the matching database and library backup with the matching application version and configuration. Do not combine an older database with newer library contents or assume an older binary understands newer migrations.

See [storage recovery](storage-recovery.md) for interrupted operations and timestamp migration caveats. A restore procedure must be rehearsed on your own deployment before it counts as verified recovery for that environment.

Existing installations also require the [exclusive collection migration](collection-migration.md), with a backup, administrative preview, and confirmed apply before normal library requests resume.

## Ingestion and administration

- Use [Calibre import](calibre-import.md) to migrate an existing Calibre library. Keep the source read-only and retain a source backup.
- Configure **Settings → Admin → Dropbox** for a local ingestion directory, allowed extensions, and one target collection. This is a filesystem inbox, not the Dropbox cloud service. Ingestion requires a suitable configured user/target context.
- Configure Hardcover through the admin metadata settings. The server stores the token and clients receive an availability flag. See [metadata providers](../developing/reference/metadata.md).
- Run [health checks](health-checks.md) from the admin library controls. Quick checks inspect database conditions; deep checks also inspect bounded filesystem/duplicate conditions.

Use server logs when investigating failures. Older investigations are retained in the [historical archive](../archive/README.md). Do not delete `.delb-*` journals or lock databases to suppress an error. Follow the [storage recovery instructions](storage-recovery.md).

## Deployment evidence

The initial documentation verification uses an isolated loopback demo with synthetic data. It does not establish Docker execution, a real Unraid share, arbitrary network filesystems, public reverse-proxy configuration, or live metadata-provider availability. See the [verification record](../developing/documentation-status.md).
