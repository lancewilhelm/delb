# Metadata providers and imports

Delb searches Google Books and Hardcover through server endpoints. The Add book dialog imports complete records; the book editor can apply selected fields. See [Add books](../../using/add-books.md) for user steps.

## Provider availability

| Provider     | Search endpoint                                  | Configuration                       |
| ------------ | ------------------------------------------------ | ----------------------------------- |
| Google Books | `GET /api/books/metadata/search?q=...`           | Public API through the server proxy |
| Hardcover    | `GET /api/books/metadata/hardcover/search?q=...` | Admin-configured server-side token  |

The search modal can enable multiple providers and remembers choices in account settings. Hardcover is unavailable to the client when the server's capability flag says no token is configured. Tokens remain on the server and are not returned as account settings.

## Creation and selective editing

`POST /api/books/metadata-import/create` accepts a provider item or query and target collection IDs. The handler checks the session and target edit roles, resolves a record, detects possible duplicates, and creates or links catalog data.

The current backend maps title, authors, description, identifiers, language, publication data, page count, categories/tags, publisher, and available series information. It resolves related entity rows, writes author/tag/identifier links, and can fetch a cover. These paths are implemented; older phase notes incorrectly marked backend mapping as pending.

The editor's metadata modal returns the selected fields to [BookEditor](../../../app/components/Books/BookEditor.vue). Applying fields to the form is distinct from persisting the edited book through Save. Review the form before saving changes to shared metadata.

Metadata-only creation does not download an ebook. Canonical directory/cover work can occur without a `book_files` entry. Some filesystem and remote-cover steps are best-effort after database work, so a catalog entry can exist without a fetched cover.

## Duplicate decisions

| Action                      | Result                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| Cancel                      | Leave the pending import unapplied                                  |
| Add existing to collections | Link a visible candidate into missing editable targets              |
| Replace selected            | System admin/owner replaces the selected existing record's metadata |
| Add new entry               | Create a separate catalog entry                                     |

A replacement preserves the book ID and associated personal reading identity. Updating shared metadata affects every collection containing the record. The Add book dialog presents the candidate review and action-specific feedback.

## Field mapping

| Provider record                                              | Delb records                                         |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| Title, description, language, publication fields, page count | `books`                                              |
| Authors                                                      | `authors` and ordered `book_authors` links           |
| Categories                                                   | `tags` and `book_tags` links                         |
| Publisher and available series                               | Related shared entities and book foreign keys        |
| ISBN and other identifiers                                   | `book_identifiers`                                   |
| Remote image                                                 | Managed cover/thumbnail files and book cover pointer |

Hardcover results are mapped into the shape consumed by the shared import flow. Provider coverage depends on the returned record; missing fields are not evidence of a failed import.

## Cover delivery

External images pass through [server image handling](../../../server/utils/books/external-image.ts). The current contract accepts decoded JPEG, PNG, and WebP input, normalizes output to PNG for metadata delivery, and bounds input/output size, pixels, redirects, and elapsed time. Active SVG input is rejected.

Cover storage and ebook embedding are separate operations. A stored cover can be delivered through the authorized book-cover endpoint; supported EPUB cover updates use the independent [EPUB package](../../../packages/epub/README.md) and Delb's storage coordination.

## Sources and evidence

- [Search modal](../../../app/components/BookMetadataSearchModal.vue), [Add book dialog](../../../app/components/Books/BookAddModal.vue), and [editor](../../../app/components/Books/BookEditor.vue).
- [Metadata creation](../../../server/api/books/metadata-import/create.post.ts) and [metadata proxy endpoints](../../../server/api/books/metadata).
- [Hardcover secret handling](../../../server/utils/secrets/hardcover.ts).
- [Core request flows](../core-workflows.md#add-a-book) and [verification record](../documentation-status.md).

The synthetic demo blocks outbound requests. Source inspection and supplied-record imports do not establish successful live Google Books/Hardcover searches or cover downloads.
