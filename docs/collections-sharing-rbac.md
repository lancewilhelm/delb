# Collections and access control

Collections define book visibility and collaboration. System roles, collection roles, and book-creator permissions answer different questions.

## Visibility

A book is visible when it belongs to at least one collection where the current user is a member. All combines those accessible collections. Sharing a collection exposes the existing catalog records and files, while each reader keeps personal status, ratings, positions, and progress.

The Personal collection cannot be shared, transferred, left, or deleted. It can be renamed. The Add book UI always includes it. Creation endpoints also use Personal as the fallback when the caller supplies no targets; an explicit API target list is a separate contract.

## Collection roles

The following rules apply to non-Personal collections:

| Capability                                           | Owner | Editor | Viewer |
| ---------------------------------------------------- | ----- | ------ | ------ |
| View books in the collection                         | Yes   | Yes    | Yes    |
| Rename the collection                                | Yes   | Yes    | No     |
| Add/remove book links in editable targets            | Yes   | Yes    | No     |
| List, add, update, or remove other non-owner members | Yes   | Yes    | No     |
| Transfer ownership                                   | Yes   | No     | No     |
| Delete the collection                                | Yes   | No     | No     |
| Leave the collection                                 | No    | Yes    | Yes    |

Member upsert uses an existing account's email address. It accepts editor or viewer roles and cannot change the caller's own role. The owner role changes through ownership transfer. Removing the owner through member deletion is forbidden.

Transfer makes the recipient the sole owner and the previous owner an editor. Collection deletion removes collection/membership/book-link rows, not the books or their files. An owner must transfer or delete instead of leaving.

## Book operations

Collection edit rights do not automatically grant shared metadata editing. Book update, cover replacement, and deletion use creator or system admin/owner authorization in their respective handlers. Book deletion affects the shared catalog record and every collection link.

A viewer who can see a book can use the single-book collection endpoint to add it to another collection they own or edit. Targets still require edit rights. The API reports forbidden targets and ignores Personal removals.

Bulk collection operations additionally require owner/editor membership in the source collection. They resolve explicit IDs or all-with-exclusions inside that collection. There is no scope-wide bulk collection operation for All.

## Visibility after re-sharing

If reader B adds a shared book to another collection B can access, removing B from the original collection leaves access through the other link. Current reads evaluate any accessible collection; they do not track the original source of each access grant.

Earlier design notes left the long-term re-sharing policy open. This reference states implemented behavior. Changing it to revoke derived access requires a separate product decision and implementation.

## Endpoints

| Endpoint                                       | Responsibility                                      |
| ---------------------------------------------- | --------------------------------------------------- |
| `GET /api/collections`                         | Accessible collections and roles                    |
| `POST /api/collections`                        | Create a collection                                 |
| `PUT /api/collections/:id`                     | Rename an editable collection                       |
| `GET /api/collections/:id/members`             | Owner/editor member listing                         |
| `PUT /api/collections/:id/members`             | Add/update an existing user as editor/viewer        |
| `DELETE /api/collections/:id/members/:userId`  | Remove another non-owner member                     |
| `POST /api/collections/:id/leave`              | Non-owner self-removal                              |
| `POST /api/collections/:id/transfer-ownership` | Owner transfer by email                             |
| `DELETE /api/collections/:id`                  | Owner deletion of a non-Personal collection         |
| `GET /api/books/:id/collections`               | Current book memberships visible to the caller      |
| `PUT /api/books/:id/collections`               | Single-book adds/removals with target authorization |
| `POST /api/collections/:id/books/bulk`         | Source-scoped bulk membership changes               |

Single-book mutation takes `addCollectionIds` and `removeCollectionIds`. Bulk mutation takes `bookIds` or `allInCollection` with `excludedBookIds`, plus `addToCollectionIds` and `removeFromCollectionIds`. Inspect returned forbidden/ignored targets instead of treating a successful HTTP response as proof every requested target changed.

## Sources and related guides

The [collection APIs](../server/api/collections), [book collection handler](../server/api/books/[id]/collections/index.put.ts), [collection store](../app/stores/collections.ts), and [settings dialog](../app/components/Collections/EditCollectionModal.vue) define the current contract.

For procedures, use [Organize and share collections](using/collections.md). For implementation context, read [core request flows](developing/core-workflows.md#collections-and-sharing).
