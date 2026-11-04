# Delb documentation

Delb manages a shared book catalog, collection access, ebook files, and each reader's personal reading data. Start with the path that matches your task.

## Use Delb

Follow the main library workflow:

1. [Create an account and find your library](using/get-started.md).
2. [Add books](using/add-books.md) by uploading a file, searching metadata, or entering details manually.
3. [Browse and find books](using/find-books.md).
4. [Organize and share collections](using/collections.md).
5. [Read books and track progress](using/reading.md).

See the [glossary](../GLOSSARY.md) for library, collection, book view, and reading-data terminology.

## Host Delb

Start with the [hosting guide](hosting/README.md). It links deployment, configuration, migrations, backups, recovery, and administrative tasks.

## Develop Delb

Start with the [contributor guide](developing/README.md), then read:

- [System architecture](developing/architecture.md) for runtime responsibilities and the complete feature map.
- [Delb's data model](developing/data-model.md) for shared and per-user records.
- [Core request flows](developing/core-workflows.md) to connect user actions to backend work.
- [Documentation status and verification](developing/documentation-status.md) for evidence, known limitations, and the next documentation passes.

## Feature reference

| Topic                                          | Reference                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Collection permissions and endpoints           | [Collections and access control](collections-sharing-rbac.md)                                         |
| Reading status, dates, and progress rules      | [Reading status and progress](reading-status-progress.md)                                             |
| EPUB position persistence and reader endpoints | [EPUB reader](epub-reader.md)                                                                         |
| Settings, appearance, and synchronization      | [Settings](settings.md)                                                                               |
| Grid and list field behavior                   | [Book view settings](book-view-settings.md)                                                           |
| Navigation and layout behavior                 | [UI layout](ui-layout-philosophy.md)                                                                  |
| Search                                         | [Global search](global-search.md)                                                                     |
| External metadata and covers                   | [Metadata fetcher](metadata-fetcher.md)                                                               |
| Calibre migration                              | [Calibre import](calibre-import.md), [Calibre's schema](calibre-database-schema.md)                   |
| Library integrity checks                       | [Health checks](health-checks.md)                                                                     |
| Managed files and interrupted operations       | [Storage recovery](storage-recovery.md)                                                               |
| Container deployment                           | [Docker](docker.md)                                                                                   |
| EPUB package                                   | [Independent EPUB cover package](../packages/epub/README.md)                                          |
| Component details                              | [Tooltips](tooltip.md), [browse cards](browse-cards.md), [series cards](series.md), [icons](icons.md) |
| Recorded defects                               | [Known issues](known-issues.md)                                                                       |

The architecture and core guides describe the implementation at the revision recorded in [documentation status](developing/documentation-status.md). Historical review records and future-work sections are identified separately from current behavior.
