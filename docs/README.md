# Delb documentation

Delb manages a shared book library, access to it, ebook files, and each reader's personal reading data. Start with the path that matches your task.

## Use Delb

Follow the main library workflow:

1. [Create an account and find your library](using/get-started.md).
2. [Add books](using/add-books.md) by uploading a file, searching metadata, or entering details manually.
3. [Browse and find books](using/find-books.md).
4. [Share the library and control access](using/library-access.md).
5. [Read books and track progress](using/reading.md).
6. [Import from Goodreads](using/import-goodreads.md) to bring over statuses, ratings, reviews, and shelves.
7. [Connect an agent](using/connect-an-agent.md) to search your library and update personal reading data.

See the [glossary](../GLOSSARY.md) for library, server role, tag visibility rule, book view, and reading-data terminology.

## Host Delb

Start with the [hosting guide](hosting/README.md). It links deployment, configuration, migrations, backups, recovery, and administrative tasks.

## Develop Delb

Start with the [contributor guide](developing/README.md), then read:

- [System architecture](developing/architecture.md) for runtime responsibilities and the complete feature map.
- [Delb's data model](developing/data-model.md) for shared and per-user records.
- [Core request flows](developing/core-workflows.md) to connect user actions to backend work.
- [Documentation status and verification](developing/documentation-status.md) for evidence, known limitations, and the next documentation passes.

## Feature reference

Browse the [feature contracts](developing/reference/README.md) or [UI component references](developing/ui/README.md).

| Topic                                          | Reference                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Roles, tag rules, and access endpoints         | [Library access, roles, and tag visibility rules](developing/reference/library-access.md)                                            |
| Reading status, dates, and progress rules      | [Reading status and progress](developing/reference/reading-status-progress.md)                                                       |
| EPUB position persistence and reader endpoints | [EPUB reader](developing/reference/epub-reader.md)                                                                                   |
| Settings, appearance, and synchronization      | [Settings](developing/reference/settings.md)                                                                                         |
| Grid and list field behavior                   | [Book view preferences](using/find-books.md#change-the-grid-or-list)                                                                 |
| Navigation and layout behavior                 | [UI layout](developing/reference/library-layout.md)                                                                                  |
| Search                                         | [Global search](developing/reference/global-search.md)                                                                               |
| External metadata and covers                   | [Metadata fetcher](developing/reference/metadata.md)                                                                                 |
| Goodreads import                               | [Import from Goodreads](using/import-goodreads.md), [import rules](developing/reference/reading-status-progress.md#goodreads-import) |
| Calibre migration                              | [Calibre import](hosting/calibre-import.md), [Calibre's schema](developing/reference/calibre-schema.md)                              |
| Library integrity checks                       | [Health checks](hosting/health-checks.md)                                                                                            |
| Managed files and interrupted operations       | [Storage recovery](hosting/storage-recovery.md)                                                                                      |
| Container deployment                           | [Docker](hosting/docker.md)                                                                                                          |
| EPUB package                                   | [Independent EPUB cover package](../internal/epub/epub.go)                                                                           |
| Component details                              | [UI component reference](developing/ui/README.md)                                                                                    |

The architecture and core guides describe the implementation at the revision recorded in [documentation status](developing/documentation-status.md). Historical review records and future-work sections are identified separately from current behavior.

[ADR 0005](adr/0005-single-library-roles-and-tag-visibility.md) records the current model: a single shared library, server roles, tag visibility rules, genres, and unified bookshelf layouts. It supersedes the [collection model in ADR 0004](adr/0004-exclusive-collections-and-shared-default.md). Existing installations follow [Upgrade to a single library](hosting/single-library-upgrade.md).

## Historical records

Past design discussions, repair investigations, and obsolete asset instructions live in the [archive](archive/README.md). They preserve context and evidence without presenting old commands or defect status as current guidance.

## Folder layout

The documentation folders are:

- `using/` contains user task guides.
- `hosting/` contains deployment, import, health, and recovery guides.
- `developing/` contains architecture and contributor setup, with `reference/` for feature contracts and `ui/` for component details.
- `images/` contains screenshots and their provenance.
- `archive/` contains historical records.
