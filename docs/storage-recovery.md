# Storage recovery

Delb coordinates book creation, replacement, moves, cover changes and deletion with durable operation journals and database decisions. The decision is inserted in the same database transaction as the book change. Startup reconciles interrupted operations before serving requests or starting Dropbox ingestion.

Back up the SQLite database and the library together before upgrading. Apply migrations with the documented startup command. The new bootstrap marker records completed initialization, and reading-position columns support request ordering. A further migration converts user settings timestamps from seconds to milliseconds. Rollback to an older binary requires restoring the matching database backup or explicitly reversing that conversion after stopping writers. Existing book IDs, collections and personal reading records are retained during replacement.

## Interrupted operations

Do not delete `.delb-*` directories or database operation records to clear an error. They can contain the only original bytes, a recovery journal or evidence that a database change committed.

- A committed operation finalizes its verified destination and retires only the original paths it owns.
- An uncommitted operation restores or preserves its original files.
- A conflicting uncommitted move snapshots both versions inside its journal before publishing a `.delb-failed-move-*` marker with an operator warning. Later moves or deletion of the canonical book do not invalidate those retained copies. Other requests can continue.
- An unresolved committed target or a missing required original stops recovery. Preserve the journal and both database and library snapshots before investigating.
- Failed creates retain staged inputs under `.delb-failed-create-*`. Dropbox failures use unique exclusive destinations. Processing claims are reconciled on restart against their durable commit IDs.

To investigate, stop all Delb writers, preserve a copy of the database and library, and read the server warning and operation journal. Verify the expected source and destination against the commit decision and file contents. Restore from a consistent backup or reconcile the retained files before restarting. Deleting an ambiguous copy is an operator decision, not an automatic recovery action.

## Ownership and filesystem requirements

Book mutations serialize through a persistent per-book SQLite lock database under `library/.delb-locks`. The active write transaction belongs to the process; the operating system releases it when that process exits. The files remain after release and must not be removed while writers are active. Waiting for another writer is bounded, and recovery can retry a busy operation.

SQLite locking must work on the library filesystem. Use a local filesystem or a deployment whose SQLite locking semantics have been verified. This change does not establish support for concurrent writers over an arbitrary SMB/NFS mount. Test a representative deployment before moving a live library.

Canonical file movement uses verified exclusive copies only for the known `EUCLEAN` and `EXDEV` rename failures. Different existing contents are preserved. Nested sidecar directories are refused instead of recursively deleted. The tests exercise these errors with injected faults; they do not certify a real Unraid storage stack or power-loss durability.

## Resource limits

Book upload bodies are capped at 100 MiB and cover multipart bodies at 26 MiB, with a 25 MiB image cap. Body reads have a 120-second total deadline. Remote covers allow only decoded JPEG, PNG and WebP input, return PNG, and bound input/output bytes, pixels, redirects and elapsed time. Active SVG input is rejected.

EPUB archive checks bound entry count, per-entry and total inflated sizes before extraction. These are per-request limits. Operators should also set request/concurrency limits at their reverse proxy for their available memory.
