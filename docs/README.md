# Delb documentation

Delb manages a shared book library, access controls, ebook files, and each reader's personal reading data. Start with the path that matches your task.

## Use Delb

Follow the core user guides:

1. [Create an account and find your library](using/get-started.md).
2. [Add books](using/add-books.md) by uploading files, searching metadata, or entering details manually.
3. [Browse and find books](using/find-books.md).
4. [Share the library and control access](using/library-access.md).
5. [Read books and track progress](using/reading.md).
6. [Import from Goodreads](using/import-goodreads.md) to bring over statuses, ratings, reviews, notes, and shelves.
7. [Connect an agent](using/connect-an-agent.md) to search your library and update reading data or metadata.

See the [glossary](../GLOSSARY.md) for library, server role, tag visibility rule, book view, and reading-data terminology.

## Host Delb

Start with the [hosting guide](hosting/README.md). It covers Docker deployment, Unraid setup, configuration, backups, imports, health checks, and storage recovery.

## Develop Delb

Start with the [contributor guide](developing/README.md), then read:

- [System architecture](developing/architecture.md) for runtime responsibilities and the feature map.
- [Delb's data model](developing/data-model.md) for shared and per-user records.
- [Core request flows](developing/core-workflows.md) to connect user actions to backend handlers.
- [MCP integration design](developing/mcp-design.md) for agent authentication and tool boundaries.
- [Documentation status and verification](developing/documentation-status.md) for historical verification records and evidence limits.

## Feature reference

Browse the [feature reference index](developing/reference/README.md) or [UI component reference](developing/ui/README.md).

| Topic                                          | Reference                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication and account administration      | [Authentication](developing/reference/auth.md)                                                                                       |
| Roles, tag rules, and access endpoints         | [Library access, roles, and tag visibility rules](developing/reference/library-access.md)                                            |
| Dashboard layout, card art, and API            | [Dashboard](developing/reference/dashboard.md)                                                                                       |
| Reading status, dates, and progress rules      | [Reading status and progress](developing/reference/reading-status-progress.md)                                                       |
| EPUB position persistence and reader endpoints | [EPUB reader](developing/reference/epub-reader.md)                                                                                   |
| PDF rendering and page persistence             | [PDF reader](developing/reference/pdf-reader.md)                                                                                     |
| Finished-book share cards                      | [Share cards](developing/reference/share-cards.md)                                                                                   |
| Settings, appearance, and synchronization      | [Settings](developing/reference/settings.md)                                                                                         |
| Grid and list field behavior                   | [Book view preferences](using/find-books.md#change-the-grid-or-list)                                                                 |
| Navigation and layout behavior                 | [UI layout](developing/reference/library-layout.md)                                                                                  |
| Search                                         | [Global search](developing/reference/global-search.md)                                                                               |
| External metadata and covers                   | [Metadata providers and imports](developing/reference/metadata.md)                                                                   |
| Goodreads import                               | [Import from Goodreads](using/import-goodreads.md), [import rules](developing/reference/reading-status-progress.md#goodreads-import) |
| Calibre migration                              | [Calibre import](hosting/calibre-import.md), [Calibre's schema](developing/reference/calibre-schema.md)                              |
| Library integrity checks                       | [Health checks](hosting/health-checks.md)                                                                                            |
| Managed files and interrupted operations       | [Storage recovery](hosting/storage-recovery.md)                                                                                      |
| Container deployment                           | [Docker](hosting/docker.md)                                                                                                          |
| EPUB package                                   | [Independent EPUB cover package](../internal/epub/epub.go)                                                                           |
| Component details                              | [UI component reference](developing/ui/README.md)                                                                                    |

## Architecture decisions and historical records

[ADR 0005](adr/0005-single-library-roles-and-tag-visibility.md) records the current library model: one shared library, server roles, tag visibility rules, genres, and unified bookshelf layouts. It supersedes [ADR 0004](adr/0004-exclusive-collections-and-shared-default.md). Servers upgrading from pre-1.0 preview versions that used collections can follow [Upgrade to a single library](hosting/single-library-upgrade.md).

Past design discussions, repair investigations, and obsolete asset instructions live in the [archive](archive/README.md). They preserve historical context without presenting old commands or defect status as current guidance.

## Folder layout

The documentation folders are:

- `using/` contains user task guides.
- `hosting/` contains deployment, import, health, and recovery guides.
- `developing/` contains architecture and contributor setup, with `reference/` for feature contracts and `ui/` for component details.
- `adr/` contains architecture decision records.
- `images/` contains screenshots and their provenance.
- `archive/` contains historical records.
