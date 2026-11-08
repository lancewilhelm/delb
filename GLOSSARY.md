# Delb

Delb organizes books and their metadata in a library of shared and private collections.

Collection terminology follows the [accepted collection model](docs/adr/0004-exclusive-collections-and-shared-default.md). The [collections reference](docs/developing/reference/collections.md) describes the current implementation.

## Language

**Library**:
The books a reader can access through their collection memberships. The All selection includes every accessible collection.

**Collection**:
A named group of books with its own members and access roles. Each book entry belongs to exactly one collection, while separate entries for the same title can exist in different collections.

**Default collection**:
The shared collection selected when members open the app, for automatic enrollment of new readers, and as the fallback destination when an added book has no explicit collection target. Its default designation does not grant access to users who are not members.

**Book entry**:
A book in Delb's catalog with its own metadata, files, and reader-specific reading data. Separate entries can represent the same title.

**Copy indicator**:
A mark on a book entry that the shared library has ongoing access to a physical or audiobook copy. An unmarked indicator does not establish that no copy exists.

**Book move**:
A change to a book entry's sole collection that preserves its identity and reading data. Access follows membership in the destination collection.

**Personal collection (legacy)**:
A reader's protected default collection in Delb's existing model. It can be renamed but cannot be shared, transferred, left, or deleted.

**Collection owner**:
The single required member who controls a collection's ownership and deletion. This role is separate from the system owner and a book's creator.

**Book creator**:
The user recorded as having created a book entry. Creator provenance does not grant book-management privileges independently of collection roles.

**Reference-only book**:
A catalog entry without a downloadable ebook file. It can represent a physical book and can still have a cover and reading history.

**Book metadata**:
Descriptive information about a book, such as its title, authors, identifiers, and cover. It is distinct from the book's reading content.

**Catalog vocabulary**:
The authors, tags, series, and publishers shared across Delb's book entries. Individual entries select their own associations with these terms.

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

**TBR queue**:
A reader's private, ordered list of books they plan to read. The queue spans all collections the reader can access.

**TBR rank**:
A book's position in a reader's TBR queue, starting at 1 for the book they most want to read.

**TBR rationale**:
A reader's optional, private note explaining a book's place in their TBR queue. The note remains associated with the reader and book after the book leaves the queue.

**Book view**:
A presentation of a set of books as a grid of cover cards or a list of rows.

**Book field**:
A piece of book metadata that can be selected for display in a book view, such as title, authors, or tags.

**View preferences**:
A user's choice of visible book fields and their order for a particular book view. Grid and list preferences are independent.
