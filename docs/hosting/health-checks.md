# Library health checks

Delb provides on-demand administrative checks at `POST /api/settings/admin/health`. The [admin library UI](../../app/components/Settings/SettingsAdminLibrary.vue) exposes them under **Settings → Admin → Library**. Running health checks requires the Admin or Owner server role.

Health checks report findings only. They do not automatically repair or delete records or files.

## Modes and results

| Mode    | Checks                                                                                                                           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `quick` | Empty titles and duplicate identifiers                                                                                           |
| `deep`  | Quick checks plus bounded fuzzy title and author comparisons, file existence, cover-path existence, and missing thumbnail checks |

Each result includes an ID, name, status (`ok`, `warn`, or `error`), message, and optional remediation guidance, metadata, and sample rows (`sample`).

Deep checks enforce bounded sampling, comparison, and filesystem stat limits. A clean bounded result does not prove that every book or file on disk was scanned.

Independent copies and separate editions of the same title are valid in Delb. Fuzzy duplicate results report inspected book counts, configured limits, and whether the scan reached a bound.

## Reference-only books

A book entry without an attached file is a valid catalog entry for a physical or reference-only book. Missing-file checks inspect only recorded `book_files` rows, so an intentional reference-only book does not trigger a missing-file error.

## Interpret findings

| Finding                             | Next step                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| Empty title                         | Inspect the book entry and correct its metadata                                        |
| Duplicate identifier or fuzzy match | Compare the entries; similarity does not prove that they are the same edition          |
| Missing file or cover               | Compare the database path with the managed library and any retained operation journals |
| Missing thumbnail                   | Inspect the source cover and prior cover operation before regenerating thumbnails      |

Back up the database and managed library together before performing manual repairs. Follow [storage recovery](storage-recovery.md) whenever retained operation journals are involved.

## Ingestion checks and scope

Upload, Calibre, Goodreads, and dropbox ingestion handlers run their own input and duplicate checks rather than executing the full admin health suite. Automatic repair, duplicate merging, and deployment-specific restore drills are outside the health endpoint's scope.

See the [health handler](../../internal/admin/health.go) for current limits, check IDs, and response fields.
