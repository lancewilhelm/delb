# Upgrade to exclusive collections

Existing installations require an administrative data migration after the committed SQL migrations. Fresh installations initialize the shared **Default** during the first successful registration.

## Prepare the upgrade

1. Stop the previous Delb version and its background ingestion.
2. Back up the database and managed library together, including operation journals. Retain the old application version and configuration.
3. Apply committed SQL migrations through your normal deployment procedure. Containers apply them at startup. A local checkout uses `pnpm db:migrate`.
4. Start the new version and sign in as a system administrator or owner.
5. Open **Settings → Admin → Collections**.

Ordinary library requests pause until migration completes. Authentication and the migration page remain available. SQL migration stages the original links without copying books or granting access.

## Review and apply

1. Review the counts of users, former Personal collections, split books, and recovered books.
2. For each split book, choose the collection retaining its original book ID and Calibre relationship.
3. If Dropbox has multiple or stale targets, choose one destination or the new shared default.
4. Resolve reported ownership and storage-recovery blockers.
5. Confirm a matching database and library backup.
6. Select **Apply migration**.

The new **Default** belongs to the system owner. Existing users join it once as editors. Former Personal collections become ordinary private collections, with their memberships retained. Orphaned books enter private **Recovered books**.

Split entries receive verified independent file and cover-sidecar copies under `library/collection-copies/<book-id>/`. Source bytes stay in place. Reader-specific state follows accessible copies. Queued copies remain adjacent with their private rationale. Historical data for readers who lost access remains retained without restoring membership. Calibre follows only the designated original entry.

## Resume after interruption

1. Correct the reported storage failure using the matching backup when necessary.
2. Return to **Settings → Admin → Collections**.
3. Review retained choices and confirm the backup.
4. Select **Resume migration**.

Verified copies are reused. Database changes commit together after copying succeeds. If source data changed after the retained plan was created, restore the matching database and library backup before retrying. Keep migration records and copy markers intact.

## Verify the result

1. Sign in as two readers and inspect **All**. Expect only each reader's accessible collections.
2. Check a formerly private book, a split book, a download, and saved reading data.
3. Run quick and deep [health checks](health-checks.md). Review recovered books and advisory duplicates.
4. Review Dropbox and Calibre targets before resuming imports.

Changing the default later affects future enrollment and uploads. Users may leave every collection; sign-in does not rejoin them.
