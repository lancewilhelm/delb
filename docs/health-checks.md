# Library health checks

Delb implements on-demand administrative checks at `POST /api/settings/admin/health`. The [admin library UI](../app/components/Settings/SettingsAdminLibrary.vue) exposes them in Settings. System admin/owner authorization is required.

The checks report findings. They do not automatically repair or delete the affected records/files.

## Modes and results

| Mode    | Checks                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `quick` | Books without a collection, empty titles, cross-book duplicate identifiers, users missing a Personal collection              |
| `deep`  | Quick checks plus bounded fuzzy title/author comparisons, file existence, cover-path existence, and missing thumbnail checks |

Each result includes an ID, name, `ok`, `warn`, or `error` status, a message, and optional remediation guidance, metadata, and sample rows. The response uses `sample`, not the earlier proposed `sampleIds` contract.

Deep requests have bounded sampling and comparison/stat limits. A clean bounded result does not prove an unlimited scan of every file or book completed.

## Reference-only books

A book with no associated file can be a valid physical-library entry. Missing-file checks inspect claimed file records. A missing ebook file is different from an intentional metadata-only book.

## Interpret findings

| Finding                             | Next investigation                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| Orphaned book                       | Check collection links and authorized import targets before reconnecting or removing a record |
| Empty title                         | Inspect and correct the metadata                                                              |
| Duplicate identifier or fuzzy match | Compare the books; similarity is not proof they are the same edition                          |
| Missing Personal collection         | Inspect account initialization and existing memberships                                       |
| Missing file or cover               | Compare the database pointer with the managed library and retained operation journals         |
| Missing thumbnail                   | Check the source cover and prior cover operation before regeneration                          |

Preserve a matching database/library backup before manual repair. Follow [storage recovery](storage-recovery.md) when operations or retained journals are involved.

## Ingestion checks and future work

Ingestion handlers perform their own input and duplicate checks. This reference does not claim that every import automatically runs the complete admin health suite. Automatic repair, duplicate merging, and deployment-specific restore drills require separate work and verification.

The [health handler](../server/api/settings/admin/health.post.ts) is the source for current limits, result IDs, and response fields. The [documentation record](developing/documentation-status.md) distinguishes source inspection from demo execution.
