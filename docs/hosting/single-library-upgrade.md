# Upgrade to a single library

Delb now has one shared library instead of collections. Upgrading an existing server collapses every collection into that library and gives each account a server role. Migration `0022_single_library` does this automatically at startup; there is no separate migration page.

> [!IMPORTANT]
> After the upgrade, **every account can see every book**, including books that were in private collections. If some books should stay hidden from some accounts, tag those books and add tag visibility rules right after upgrading. Consider closing registration until you have reviewed access.

## Before you upgrade

1. Stop Delb and its background ingestion.
2. Back up the database and the managed library together. Delb also writes an automatic `*.pre-migration-*.bak` copy of the database before it applies pending migrations.
3. Write down which collections were private and who should not see their books. You will use this list to create tags and rules.
4. You do not need to finish a pending collection migration from an earlier version first. The new migration also handles installations that never completed it.

## What the migration changes

| Before                                                   | After                                                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System owner                                             | `owner`                                                                                                                                                  |
| Administrator                                            | `admin`                                                                                                                                                  |
| Account that owned or could edit at least one collection | `editor`                                                                                                                                                 |
| Any other account (viewer-only or no memberships)        | `reader`                                                                                                                                                 |
| Books in any collection                                  | Books in the library, with the same IDs, files, metadata, and reading data                                                                               |
| The default collection's bookshelf layout                | The library bookshelf layout. Other collections' layouts are dropped; their books are placed automatically the next time an Editor opens Bookshelf view. |
| Collection bookshelf pictures                            | Library bookshelf pictures. Pictures that the library layout does not use are removed some time after the library bookshelf is next saved.               |
| Dropbox destination collection settings                  | Removed. Dropbox imports go into the library for the configured importing user.                                                                          |

The migration removes the `collections`, `collection_members`, and `legacy_collection_books` tables, the `collection_books` view, and `books.collection_id`, along with the triggers that maintained them. Personal Shelves, reading data, and TBR queues are unchanged.

Separate book entries for the same title, which earlier versions created when a book was split between collections, stay separate. Use the health checks to find them and delete any duplicates you do not want.

## After you upgrade

1. Start Delb and sign in as the Owner or an Admin.
2. Open **Settings → Admin → Users** and check each account's role. Make accounts that should only read the library **reader**, and accounts that should add and edit books **editor**.
3. Tag the books that should be hidden from some accounts. For example, add a `private` tag to every book from a former private collection.
4. For each account that should not see those books, select its edit button and set the tag to **hide** under **tag visibility rules**. To restrict a guest to a small set of books, tag those books and set that tag to **allow** instead.
5. If you use Dropbox, open **Settings → Admin → Dropbox** and make sure the importing user is an Editor or Admin.
6. Sign in as a restricted account and confirm that the hidden books do not appear in Books, search, or the dashboard.

See [Share the library and control access](../using/library-access.md) for how roles and rules work.

## Roll back

The migration cannot be reversed in place. To return to a version with collections, stop Delb, restore the database backup and library that you made before upgrading (or the automatic `*.pre-migration-*.bak` database copy, together with the matching library), and start the earlier version.
