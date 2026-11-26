---
status: accepted
---

# Use a single shared library with server roles, tag visibility rules, genres, and unified bookshelf layouts

Delb replaces multi-collection book membership and per-user book ownership with a single shared library owned by the server. Every organizing concept in Delb gets one distinct job: server roles control who can modify the catalog, shared manual tags power browsing and Plex-style per-user visibility rules, metadata-provider categories move into dedicated genres, personal shelves hold private reader lists, and visual bookshelf layouts live in one unified table saved on demand.

This decision was confirmed on 2026-11-25 in [issue #100](https://github.com/lancewilhelm/delb/issues/100). It defines the architecture for Delb `v1.0.0` and supersedes [ADR 0004](0004-exclusive-collections-and-shared-default.md). Phases 1 through 3 implement it; Phase 4 resets the migration chain.

## Context

Delb is a self-hosted personal library built for a household and a small trusted circle of close friends or family. Its organizing concepts are meant to mirror a real physical library and real bookshelves.

Under [ADR 0004](0004-exclusive-collections-and-shared-default.md), collections, personal shelves, and tags overlapped in ways that created day-to-day friction:

- **Collections carried two competing jobs.** They served both as the access boundary and as a top-level grouping mode. Juggling multiple collections felt clunky when readers wanted one shared household library while still needing to hide specific books from certain guest accounts.
- **Scope was inconsistent across the interface.** The collection picker in the header scoped the Dashboard counts, Books, Authors, Series, Publishers, and Tags, whereas Personal Shelves and the TBR queue ignored the picker and always spanned every accessible collection.
- **Visual bookshelves were tangled with plain lists and split across three tables.** The database stored visual arrangements in `collection_bookshelves`, `user_bookshelves`, and geometry columns on `personal_shelves`. Every personal shelf carried visual bookcase configuration even when it only represented a plain list such as an imported Goodreads shelf.
- **Tags mixed two unrelated sources.** Broad categories imported from Google Books and Hardcover (`Fiction`, `Science Fiction & Fantasy`) sat in the same `tags` table as manual labels that readers added by hand.

## Target model

Each concept owns one clear responsibility with no overlap:

| Concept                          | Scope and ownership                              | Cardinality per book                 | Responsibility                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Library**                      | Shared; owned by the server                      | Every book in the catalog            | The single book catalog. There is no collection picker in the header; every view operates on the same accessible library for the signed-in user.                       |
| **Server roles**                 | Per user account (`Admin`, `Editor`, `Reader`)   | Applies across the library           | Controls who can manage users and settings (`Admin`), who can modify catalog entries and files (`Admin` and `Editor`), and who is read-only on the catalog (`Reader`). |
| **Tag visibility rules**         | Per user account, configured by an `Admin`       | Evaluated against shared `tags`      | Plex-style allowlist or blocklist rules that hide or scope books for specific accounts without splitting the library into collections.                                 |
| **Genres (Subjects)**            | Shared catalog metadata                          | Many                                 | Objective bibliographic categories imported from metadata providers (Google Books, Hardcover, and embedded EPUB subjects).                                             |
| **Tags**                         | Shared manual labels (`Admin` and `Editor`)      | Many                                 | Manual shared descriptors for browsing, filtering, and driving per-user tag visibility rules.                                                                          |
| **Reading status and TBR queue** | Private to each reader                           | Exclusive (0 or 1)                   | Tracks `To be read`, `Reading`, `Finished`, and `DNF`, along with reading dates and the reader's ordered TBR queue.                                                    |
| **Shelves (Lists)**              | Private to each reader                           | Many                                 | Lightweight, additive groupings such as `Favorites`, `2026 Reads`, and imported Goodreads custom shelves.                                                              |
| **Bookshelf view**               | Optional view mode (`Grid`, `List`, `Bookshelf`) | One saved layout per scope on demand | Visual spine arrangement stored in one unified `bookshelf_layouts` table. Physical spine dimensions (`book_shelf_dimensions`) stay shared on the book entry.           |

## Library ownership, roles, and visibility

- **The library owns every book.** Books do not belong to individual user accounts, and creator provenance (`created_by_user_id`) does not grant separate edit or delete privileges.
- **Three server roles replace per-collection roles:**
  - **Admin:** Manages user accounts, roles, per-user tag visibility rules, and server settings, and has full catalog write access.
  - **Editor:** Can add books, upload and replace files, edit shared catalog metadata (including genres and tags), organize the shared library bookshelf, and delete catalog entries.
  - **Reader:** Strictly read-only on the catalog. A `Reader` cannot add books (including private or reference-only books), edit shared metadata, or delete entries. A `Reader` can browse, read, download visible books, and manage their own private reading data (reading status, dates, progress, ratings, reviews, notes, quotes, TBR queue, and personal shelves).
- **Plex-style per-user tag visibility rules replace collection-based hiding.** Every book in the library is shared by default. When an `Admin` wants to hide specific books from an account (such as a guest or family member) or restrict an account to a subset of books, the `Admin` configures allowlist or blocklist rules on that user account against shared manual `tags`.
- **Uniform enforcement across every surface.** Every API handler, search query, dashboard counter, entity index (authors, series, publishers, genres, tags), personal shelf query, TBR queue query, file download, and MCP tool enforces the signed-in user's tag visibility rules consistently. Removing the collection picker eliminates scope mismatches across pages and dashboard tiles.
- **Background imports target the single library directly.** Dropbox ingestion and Calibre imports no longer pin or recheck a target `collection_id`. Goodreads imports remain available to `Admin` and `Editor` accounts when creating new catalog entries; `Reader` accounts can only update personal reading data on existing visible books and cannot create new books.

## Genres vs. shared tags

- **Genres (Subjects)** hold objective categories sourced from metadata providers (Google Books, Hardcover) and embedded EPUB subjects. They live in dedicated `genres` and `book_genres` tables rather than `tags`.
- **Tags** remain shared catalog vocabulary managed manually by `Admin` and `Editor` accounts. Keeping tags shared avoids duplicating personal Shelves and allows administrators to use tags directly for per-user visibility rules.

## Personal shelves, reading status, and visual bookshelf layouts

- **Shelves stay lightweight personal groupings.** A reader's personal Shelves remain private, many-to-many lists (suitable for Goodreads custom shelves and utilitarian buckets) without requiring visual bookcase geometry.
- **Reading status remains distinct from personal shelves.** Reading status is mutually exclusive (a book has at most one status per reader), whereas a book can appear on any number of personal shelves at once. Reusing similar tile components on the Dashboard in separate sections is acceptable; subtle visual differentiation (such as status accent styling) is left as future polish rather than a prerequisite for this change.
- **Bookshelf view is an optional presentation mode backed by one table.** The interface keeps **Library** and **Shelves** as the only top-level navigation items, with **Bookshelf** as an optional view mode (`Grid`, `List`, `Bookshelf`).
- **One unified `bookshelf_layouts` table** replaces `collection_bookshelves`, `user_bookshelves`, and the visual geometry and placement columns on `personal_shelves`. The main Library has one shared visual layout (editable by `Admin` and `Editor` accounts), and a personal Shelf creates a saved layout record only on demand if the reader arranges it in Bookshelf view.
- **Physical dimensions stay shared.** Because a real book has one physical size, `book_shelf_dimensions` remains shared on the book entry.

## Migration strategy and pre-1.0 baseline

- **Collapse all existing collections into the single shared library.** During the Phase 3 migration, every existing book across all collections becomes a book in the single shared library. The migration does not try to synthesize per-user private collections or automatic restriction rules; administrators can apply tag visibility rules after upgrading if needed.
- **Remove collection infrastructure cleanly.** Phase 3 removes `collections`, `collection_members`, `collection_books`, `books.collection_id`, the header collection picker, book move and collection deletion flows, and the legacy ADR 0004 migration UI and endpoints.
- **Reset the migration chain once before `v1.0.0`.** Because Delb has not yet tagged `v1.0.0`, Phase 4 will squash the accumulated Drizzle SQL migrations into a single clean `0000_initial.sql` baseline only after Phases 1 through 3 have merged and settled.

## Phased implementation plan

Because collection references currently span roughly 100 files across `internal/` and `app/`, this change is split into four ordered, independently verifiable phases tracked from [issue #100](https://github.com/lancewilhelm/delb/issues/100):

1. **Phase 1 — Genres vs. shared tags ([issue #113](https://github.com/lancewilhelm/delb/issues/113)):** Add `genres` and `book_genres`, route metadata provider categories and EPUB subjects into genres, expose genres in the API, UI, and MCP, and keep `tags` strictly for manual shared tags.
2. **Phase 2 — Unified bookshelf layouts ([issue #114](https://github.com/lancewilhelm/delb/issues/114)):** Consolidate `collection_bookshelves`, `user_bookshelves`, and `personal_shelves` visual layout fields into one `bookshelf_layouts` table saved on demand, keeping Shelves lightweight by default.
3. **Phase 3 — Single shared library, server roles, and tag visibility rules ([issue #115](https://github.com/lancewilhelm/delb/issues/115)):** Add server roles (`Admin`, `Editor`, `Reader`) and per-user tag visibility rules, collapse all collections into the single shared library, remove collection plumbing across Go, Vue, MCP, Dropbox, and Calibre, mark [ADR 0004](0004-exclusive-collections-and-shared-default.md) as superseded, and update [GLOSSARY.md](../../GLOSSARY.md) and the reference docs.
4. **Phase 4 — Pre-1.0 migration baseline ([issue #116](https://github.com/lancewilhelm/delb/issues/116)):** Squash the pre-1.0 SQL migration chain into a single `0000_initial.sql` baseline and remove obsolete upgrade shims before tagging `v1.0.0`.

## Implementation decisions

Phase 3 settled these details while implementing the model:

- **New accounts are Readers.** Sign-up and admin-created accounts default to `reader`. Earlier versions enrolled new accounts in the default collection as editors.
- **The upgrade keeps existing write access.** Accounts that owned or could edit at least one collection become `editor`; accounts with only viewer memberships, or none, become `reader`.
- **Tag visibility rules never apply to `owner` and `admin` accounts.** The server refuses rules for them, so an Admin can always see and manage the whole library.
- **An allow rule never silently widens.** A tag that a rule uses cannot be deleted, and merging a tag moves its rules to the destination tag (a block rule wins on conflict). Otherwise deleting a restricted account's only allowed tag would expose the whole library to that account.
- **The library bookshelf is editable only without tag rules.** The shared layout must place every book, so an Editor with tag visibility rules sees it read-only, without the hidden books.
- **Tag and genre deletion and merging stay Admin-only,** because tags drive visibility rules. Editors add and remove tags on books.

## Deferred items

- **Social sharing (shared reviews in `#99`, shared ratings, shared lists):** Explicitly out of scope for this work. Moving to a single shared library provides a natural household boundary if social features are revisited later.
- **Dashboard visual differentiation between status tiles and shelf tiles:** Kept as optional future polish.

## Related references

- [ADR 0004: Give each book one collection and use a shared default](0004-exclusive-collections-and-shared-default.md) (superseded)
- [Library access, server roles, and tag visibility rules](../developing/reference/library-access.md)
- [Delb's data model](../developing/data-model.md)
- [Metadata fetcher](../developing/reference/metadata.md)
- [Glossary](../../GLOSSARY.md)
