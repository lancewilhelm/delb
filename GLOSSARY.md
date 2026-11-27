# Delb

Delb organizes books and their metadata in one shared library. Server roles decide who can change the library, and tag visibility rules decide which books each account can see.

The terms follow [ADR 0005](docs/adr/0005-single-library-roles-and-tag-visibility.md). The [library access reference](docs/developing/reference/library-access.md) describes the current implementation.

## Language

**Library**:
The single shared catalog of book entries on a Delb server. The server owns every entry; no account owns a book. Each account sees the part of the library that its tag visibility rules allow.

**Server role**:
An account's level of access to the library: Owner, Admin, Editor, or Reader. Server roles replace the per-collection roles of earlier versions.

**Owner**:
The first account on a server, also called the system owner. The owner is an Admin whose role cannot be changed and whose account cannot be deleted.

**Admin**:
A server role that manages accounts, server roles, tag visibility rules, and server settings, and can change the library. Tag visibility rules never apply to Admins.

**Editor**:
A server role that can add books, edit book metadata, upload and replace files, arrange the library bookshelf, and delete book entries.

**Reader**:
A server role that is read-only on the library. A Reader browses, reads, and downloads the books they can see, and keeps their own reading data, TBR queue, and Shelves. New accounts are Readers.

**Tag visibility rule**:
An Admin's rule on an Editor or Reader account that uses a shared tag to hide books from that account. An allow rule limits the account to books with at least one allowed tag. A block rule hides every book with that tag. Hidden books do not appear anywhere for that account, including counts, search, and agent tools.

**Book entry**:
A book in Delb's catalog with its own metadata, files, and reader-specific reading data. Separate entries can represent the same title.

**Copy indicator**:
A mark on a book entry that the shared library has ongoing access to a physical or audiobook copy. An unmarked indicator does not establish that no copy exists.

**Book creator**:
The user recorded as having created a book entry. Creator provenance does not grant book-management privileges; server roles decide who can change an entry.

**Reference-only book**:
A catalog entry without a downloadable ebook file. It can represent a physical book and can still have a cover and reading history.

**Book metadata**:
Descriptive information about a book, such as its title, authors, identifiers, and cover. It is distinct from the book's reading content.

**Catalog vocabulary**:
The authors, genres, tags, series, and publishers shared across Delb's book entries. Individual entries select their own associations with these terms.

**Genre**:
A shared bibliographic category attached to a book entry, populated automatically from metadata providers or embedded EPUB subjects and editable in the book editor.

**Tag**:
A manual shared label attached to a book entry for browsing and filtering, kept separate from provider-imported genres. Tags also drive tag visibility rules.

**Catalog metadata**:
Book metadata recorded in Delb's catalog.

**Embedded metadata**:
Book metadata stored inside an ebook file.

**Metadata synchronization**:
Updating a book file's embedded metadata to match the catalog metadata.

**Format conversion**:
Creation of an ebook in a different file format from an existing ebook.

**Reading position**:
A reader's saved location within an ebook. It is distinct from the historical progress log.

**Progress log**:
A reader's history of progress entries for a book, recorded manually, through reader sync, or when marking the book Finished.

**Share card**:
An image that a reader exports to share a book outside Delb. It adapts its headline and available stats—such as progress, reading duration, pages, pace, and rating—to the reader's current status for the book. It never includes a link to the library, the review, or notes.

**Mini book cover**:
A printable 50 × 30 mm flat wrap image (two 20 × 30 mm covers around a 10 × 30 mm spine) exported from Delb with physical print DPI metadata (`pHYs`) so readers can fold it around a 20 × 10 × 30 mm miniature book block.

**TBR queue**:
A reader's private, ordered list of books they plan to read. The queue contains only books that the reader can see.

**TBR rank**:
A book's position in a reader's TBR queue, starting at 1 for the book they most want to read.

**TBR rationale**:
A reader's optional, private note explaining a book's place in their TBR queue. The note remains associated with the reader and book after the book leaves the queue.

**Book view**:
A presentation of books as a grid of cover cards, a list of rows, or a bookshelf.

**Library bookshelf**:
The shared arrangement of the library's books in Bookshelf view. Editors and Admins without tag visibility rules can rearrange it; everyone else sees it read-only, without the books that are hidden from them.

**Shelf**:
A reader's private, named selection of book entries from the library. A book can appear on several Shelves, and a Shelf can have its own bookshelf arrangement.

**Spine dimensions**:
The shared width and height of a book entry as it appears on a bookshelf.

**Book field**:
A piece of book metadata that can be selected for display in a book view, such as title, authors, or tags.

**View preferences**:
A user's choice of visible book fields and their order for a particular book view. Grid and list preferences are independent.
