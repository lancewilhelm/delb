# Storage recovery

Delb coordinates book creation, file replacement, canonical moves, cover changes, and deletion with durable operation journals and database commit decisions. Each decision is written in the same SQLite transaction as the book change. On startup, Delb reconciles interrupted operations before serving HTTP requests or starting the dropbox watcher.

Back up the SQLite database and the managed `library/` directory together before upgrading. Startup applies pending embedded migrations automatically (or run `delb --migrate-only`). Before applying pending migrations to an existing database, Delb creates a `*.pre-migration-*.bak` snapshot. If you roll back to an older version, stop Delb and restore a matching database and library backup together. Replacing a book file keeps the existing book ID and every reader's personal reading records.

## Interrupted operations

Do not delete `.delb-*` directories or `storage_operations` rows to clear an error. They can hold the only copy of original file bytes, a recovery journal, or proof that a database change committed.

- A committed operation finishes moving its verified destination into place and removes only the original paths that it owns.
- An uncommitted operation restores or keeps its original files.
- A conflicting uncommitted move saves copies of both versions inside its journal before writing a `.delb-failed-move-*` marker with an operator warning. Later moves or deletion of the canonical book do not invalidate those retained copies, and other requests can continue.
- An unresolved committed target or a missing required original stops startup recovery. Preserve the journal, database, and library snapshots before investigating.
- Failed creates keep staged inputs under `.delb-failed-create-*`. Dropbox ingestion failures move to unique exclusive paths under `dropbox/failed/` with `*.error.txt` sidecars. Processing claims reconcile on restart against their durable commit IDs.

To investigate a recovery error:

1. Stop all Delb processes and background writers.
2. Back up the current database and `library/` directory.
3. Read the server log warning and the retained operation journal.
4. Compare the expected source and destination paths against the database commit decision and file contents.
5. Restore from a consistent backup or reconcile the retained files before restarting.

Deleting an ambiguous file copy is always an operator decision, never an automatic recovery step.

## Ownership and filesystem requirements

Book file mutations serialize through a persistent per-book SQLite lock database under `library/.delb-locks`. The active write transaction belongs to the running process, and the operating system releases it if that process exits. Lock files remain on disk after release; do not delete them while Delb is running. Waiting for another writer is bounded, and recovery can retry a busy operation.

SQLite locking must work reliably on both the database filesystem and the library filesystem. Use local storage or a filesystem whose SQLite locking semantics you have verified. Delb does not claim support for concurrent writers over arbitrary SMB or NFS mounts. Test a representative setup before moving a live library.

Canonical moves and cover updates fall back to verified exclusive copies only for `EXDEV` and `EUCLEAN` rename errors (such as cross-disk moves on Unraid user shares). Existing destination files with different contents are preserved, and nested sidecar directories are refused instead of recursively deleted. Automated tests verify these paths with injected errors; they do not certify a real Unraid storage stack or power-loss durability.

## Resource limits

- Book upload request bodies are capped at 100 MiB.
- Cover upload multipart bodies are capped at 26 MiB, with a 25 MiB image cap and a 100-megapixel cap.
- Remote cover fetches allow only decoded JPEG, PNG, and WebP input, convert output to PNG, reject active SVG input, cap payload size at 10 MiB, bound image dimensions and redirects, and apply a 10-second timeout.
- EPUB archive inspection bounds entry count, per-entry uncompressed size, and total inflated size before extraction.
- The Go HTTP server enforces a 10-second header read timeout (`ReadHeaderTimeout`). Set request body timeouts and concurrency limits at your reverse proxy to match your host memory.
