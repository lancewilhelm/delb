# Personal Shelves design

A Shelf is a private selection of books from collections the owner can access. The same book can belong to several Shelves. Its collection, artwork, and spine dimensions remain properties of the book.

## Use

The Shelves page creates and opens named Shelves. Its book picker browses the authorized Books endpoint and searches titles, authors, and ISBNs. The Books page adds its existing selection to a Shelf. The grid, list, and visual bookshelf use the existing view components.

The authenticated Shelf operations list, create, rename, delete, read, change membership, and save the visual arrangement. A save includes a revision and a token derived from the visible catalog and collection roles. The server rechecks both inside the write transaction. Only the Shelf owner can manage the Shelf; only a collection owner or editor can change a book's shared dimensions.

## Representation

`personal_shelves` stores ownership, name, revision, and empty bookcase geometry. `personal_shelf_books` stores one membership and remembered placement per book. The geometry contains no book identifiers. Reads intersect membership with current collection access, then compose the visible layout from those placements and shared book dimensions. Hidden members and their placements never enter the response. Saves update only visible placements, preserving hidden ones.

When a visible book cannot fit its remembered position after access returns or its dimensions change, layout composition keeps the unaffected books in place and appends the affected book in the next available position. The same layout code repairs a shared collection bookshelf if a book is resized elsewhere. Composition uses deterministic overflow identifiers and does not write on reads.

## Design decision

A per-book placement was chosen over one full layout containing every hidden member. It keeps membership and remembered placement together, lets visible edits leave hidden anchors untouched, and avoids returning hidden identifiers to the client. This adds a composition step on reads and requires concurrent mutations to compare a revision and current visible catalog token. Geometry, membership, and dimensions each have one owner.

The picker extends the paginated Books query rather than the capped global-search result. It uses the same title matching and collection access rules and adds author and normalized ISBN matching. Selection in the picker is local so it cannot overwrite the Books page's selection.
