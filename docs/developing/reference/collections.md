# Collections and access control

Each book entry belongs to exactly one collection. Membership grants visibility. **All** combines accessible collections, including for system administrators. Separate entries for the same title are permitted.

## Default and membership

The first successful registration initializes **Default**, owned by the system owner. Later accounts join the current default as editors. Its displayed name and default designation are independent. Switching the default affects future enrollment, the initial browsing selection, and creation fallback without moving books or changing memberships. Administrators can change it from the picker's collection settings or the Admin collection page. A fresh app load selects the default when the reader is a member; otherwise it selects All. Later collection-list refreshes preserve the current browsing choice.

Non-owners can leave or be removed, including from the default. Users can have zero memberships. Sign-in never restores membership. Each collection always has one owner.

## Roles

| Capability                                            | Owner | Editor | Viewer |
| ----------------------------------------------------- | ----- | ------ | ------ |
| Read books and manage private reading data            | Yes   | Yes    | Yes    |
| Add books, edit metadata, replace files, delete books | Yes   | Yes    | No     |
| Rename and manage non-owner members                   | Yes   | Yes    | No     |
| Move to an editable destination                       | Yes   | Yes    | No     |
| Transfer ownership                                    | Yes   | No     | No     |
| Delete a non-default collection and its books         | Yes   | No     | No     |
| Leave                                                 | No    | Yes    | Yes    |

Creator provenance grants no book-management authority. Moves require edit access to source and destination and confirmation of the access change. They preserve IDs and reading data. Stale source mappings fail.

Administrators can list collections, manage memberships, and reassign ownership without joining. Ordinary book access remains membership-based. Accounts owning collections cannot be deleted. The system owner retains its role and account protection.

## Storage and creation

`books.collection_id` is authoritative. `collection_books` is a read-only projection. SQL guards require collection assignment for new books, protect owner membership, synchronize transfer, and block deletion of owning accounts or nonempty/default collections.

Collection deletion requires two UI warnings. The final request includes the current `confirmationName` and `deleteBooks: true`. The server locks book storage, rechecks owner or administrator authority, and deletes the books, reading data, memberships, and collection in one transaction. Managed files and cover thumbnails use the existing recoverable delete journal. Files referenced by another collection are retained. Changes to the name, contents, default designation, or authority before commit stop deletion.

SQL migration stages old links in `legacy_collection_books`. Pending installations require the [preview/apply migration](../../hosting/collection-migration.md). Ordinary library requests return 503 until completion. A retained plan and verified copies support resumption.

Creation accepts one target, defaulting to the authorized shared default when omitted. Multiple or unauthorized targets fail. The UI prefers the active writable collection, then the writable default, otherwise explicit selection or creation.

Interactive duplicate suggestions include only visible books. A match in another collection can create an independent entry or cancel. It never silently moves or shares the match. Replacement stays in the existing collection and requires edit rights.

Dropbox and Calibre pin one new-entry destination at batch start and recheck access before writes. Calibre rescans follow the designated source-linked entry without moving it or updating independent copies.

## Endpoints

| Endpoint                                         | Responsibility                                               |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `GET /api/collections`                           | Membership-based list with roles and default designation     |
| `POST /api/collections`                          | Atomic collection and owner creation                         |
| `PUT /api/collections/:id`                       | Rename                                                       |
| `GET /api/collections/:id/members`               | Managed member listing                                       |
| `PUT /api/collections/:id/members`               | Add or update a non-owner editor/viewer                      |
| `DELETE /api/collections/:id/members/:userId`    | Remove a non-owner member                                    |
| `POST /api/collections/:id/leave`                | Non-owner self-removal                                       |
| `POST /api/collections/:id/transfer-ownership`   | Owner or administrator transfer by email                     |
| `DELETE /api/collections/:id`                    | Confirmed deletion of a non-default collection and its books |
| `GET /api/books/:id/collections`                 | The visible book's one collection                            |
| `PUT /api/books/:id/collections`                 | Confirmed move with `collectionId` and `sourceCollectionId`  |
| `POST /api/books/collection-sources`             | Visible sources for an explicit selection                    |
| `POST /api/books/move`                           | Atomic confirmed explicit move with expected source mappings |
| `POST /api/collections/:id/books/bulk`           | Source-scoped explicit or all-with-exclusions move           |
| `GET /api/settings/admin/collections`            | Administrative listing                                       |
| `PUT /api/settings/admin/collections/default`    | Set global default                                           |
| `GET /api/settings/admin/collections-migration`  | Preview and retained choices                                 |
| `POST /api/settings/admin/collections-migration` | Backup-confirmed apply/resume                                |

The [collection model](../../../server/utils/collections/model.ts), [migration](../../../server/utils/collections/migration.ts), and [accepted ADR](../../adr/0004-exclusive-collections-and-shared-default.md) define the contract. See [collection procedures](../../using/collections.md).

Dropbox persists each claimed file's importing user and collection before renaming the input. Recovery reloads that destination and rechecks its editor access; changed settings or defaults do not redirect a retained claim. A legacy claim without a destination stops with an error for explicit review and retry. Calibre checks the retained batch target on every entry, including rescans of existing entries.
