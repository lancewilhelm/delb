# Library access, server roles, and tag visibility rules

Delb has one shared library that the server owns. Server roles decide who can change the catalog. Per-user tag visibility rules decide which books an account can see. Reading data (status, dates, ratings, progress, reviews, notes, quotes, the TBR queue, and Shelves) belongs only to the reader. The accepted design is [ADR 0005](../../adr/0005-single-library-roles-and-tag-visibility.md). See the [user guide](../../using/library-access.md) for procedures.

## Server roles

`users.role` holds one of four values.

| Capability                                               | `owner` | `admin` | `editor` | `reader` |
| -------------------------------------------------------- | ------- | ------- | -------- | -------- |
| Read visible books and manage private reading data       | Yes     | Yes     | Yes      | Yes      |
| Add books, edit metadata and tags, replace files, delete | Yes     | Yes     | Yes      | No       |
| Rearrange the library bookshelf (without tag rules)      | Yes     | Yes     | Yes      | No       |
| Create Goodreads, Calibre, or Dropbox catalog entries    | Yes     | Yes     | Yes¹     | No       |
| Manage accounts, roles, tag rules, and server settings   | Yes     | Yes     | No       | No       |
| Delete or merge tags and genres                          | Yes     | Yes     | No       | No       |
| Subject to tag visibility rules                          | No      | No      | Yes      | Yes      |
| Role can be changed, account can be deleted              | No      | Yes     | Yes      | Yes      |

¹ Calibre import runs from the Admin settings, so in practice an Admin starts it. The Dropbox importing user must be an Editor or Admin.

The first account becomes `owner` during bootstrap. Sign-up and `POST /api/auth/admin/create-user` create `reader` accounts unless an Admin chooses `admin`, `editor`, or `reader`. The legacy `user` value is rejected. Creator provenance (`books.created_by_user_id`, `books.added_by_user_id`) records who added a book and grants no privileges.

[`internal/library`](../../../internal/library/access.go) holds the checks. `RequireCatalogEditor` returns 403 for readers. `AssertBookEditor` returns 404 when the book is hidden from the account and 403 when the account cannot change the catalog. Handlers call these inside the transaction that writes, so a role change between the check and the write cannot slip through. Hiding a control in the UI is never the authorization.

## Tag visibility rules

`user_tag_rules(user_id, tag_id, mode, created_at)` stores one row per account and tag, with `mode` either `allow` or `block`. The `visible_books(user_id, book_id)` view applies the rules:

- An `owner` or `admin` account sees every book.
- Otherwise, a book is hidden if it has any tag with a `block` rule for the account.
- Otherwise, if the account has any `allow` rule, the book is visible only when it has at least one allowed tag.
- Otherwise, the book is visible.

Every query that lists, counts, loads, downloads, or writes books joins `visible_books` on `(user_id, book_id)`, or uses `library.VisibleBookFilter`. That covers the book list and detail, files and covers, search, the dashboard, entity indexes (authors, series, publishers, genres, tags), Shelves, the TBR queue, finish summaries, Goodreads matching, and every MCP tool. A hidden book returns 404, the same as a missing one.

Rule integrity:

- `user_tag_rules.tag_id` uses `ON DELETE RESTRICT`. `DELETE /api/tags/{id}` returns 409 while a rule uses the tag, and the cleanup that removes unused tags skips tags that rules use. This prevents a deleted allow tag from silently widening an account's view to the whole library.
- `POST /api/tags/{id}/merge` moves rules to the destination tag. When an account has both modes after the merge, `block` wins.
- Rules on `owner` and `admin` accounts are refused with 409. A demoted Admin's old rules, if any, start applying again.
- TBR ranks are stored per reader. Hidden books are left out of every TBR response. Each renumbering ranks the visible queue first and moves hidden queued books after it, so a book that becomes visible again rejoins at the end.

## Library bookshelf

The shared Bookshelf view layout is stored in `bookshelf_layouts` with `scope_kind = 'library'` and `scope_id = 'main'`. Personal Shelves use `scope_kind = 'personal'` with the Shelf ID. Pictures use the same scope in `shelf_picture_assets`.

`GET /api/library/bookshelf` returns only the books that the account can see, and `canEdit` is true only for Editors and Admins without tag rules. `PUT /api/library/bookshelf` requires that same condition, because the layout must place every book in the library.

## Endpoints

| Endpoint                                       | Responsibility                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `GET /api/auth/get-session`                    | The signed-in account, including `role`                           |
| `POST /api/auth/admin/create-user`             | Create an account with `role` `admin`, `editor`, or `reader`      |
| `POST /api/auth/admin/set-role`                | Change a non-owner account's role                                 |
| `GET /api/settings/admin/users/{id}/tag-rules` | An account's `allowTags` and `blockTags` (Admin only)             |
| `PUT /api/settings/admin/users/{id}/tag-rules` | Replace an account's rules with `allowTagIds` and `blockTagIds`   |
| `GET /api/library/bookshelf`                   | The visible library bookshelf, its revision, token, and `canEdit` |
| `PUT /api/library/bookshelf`                   | Save the library bookshelf (Editors and Admins without tag rules) |
| `/api/bookshelf-pictures/library/main`         | Library bookshelf pictures                                        |

`PUT .../tag-rules` returns 400 when a tag appears in both lists or does not exist, 403 for non-admins, 404 for an unknown account, and 409 for rules on an `owner` or `admin` account.

## Imports

- **Dropbox** records the configured importing user (or the Owner) as the creator. That user must be an Editor or Admin. A retained claim keeps its importing user across restarts; legacy claim records that also list `collectionIds` still load.
- **Calibre** creates and rescans entries in the library. Rescans update the source-linked entry in place.
- **Goodreads** matches rows against the books that the importer can see. Only Editors and Admins can create missing entries or link Goodreads IDs to existing entries; Readers can apply reading data to matched books.

## Upgrade from collections

The pre-1.0 migration `0022_single_library` collapsed every collection into the library. Servers upgrading from collections must run a release that includes it before running a release that starts from the `0000_initial.sql` baseline. See [Upgrade to a single library](../../hosting/single-library-upgrade.md) for the exact mapping. [ADR 0004](../../adr/0004-exclusive-collections-and-shared-default.md) describes the earlier collection model and is superseded.
