# Library navigation and layout

Delb separates library access, library navigation, and book presentation. This page describes the current layout. Earlier layout proposals have been replaced by the implementation-backed explanation below.

## Library scope

Every page operates on the one shared library, limited to the books that the signed-in account's tag visibility rules allow. There is no scope picker in the header. See [library access](library-access.md).

Separate entries can represent the same title. Each reader has separate ratings, status, reading position, and progress history. See [Delb's data model](../data-model.md).

## Navigation and book views

The navigation exposes Dashboard, Books, Shelves, To be read, Authors, Series, Publishers, Genres, and Tags. Within supported book listings, grid and list are separate book views with independent visible fields and ordering.

Books, author, publisher, genre, and tag book listings use the shared grid and list field preferences. Series retains a separate presentation. The view-settings button sits beside the grid and list switch. Changes apply immediately through account settings, including the mobile profile when enabled.

Grid cards keep selected values on one line and omit missing metadata. List cells wrap to at most three lines and use a dash for missing values. Covers remain fixed first. See [book view design record](../../archive/book-view-settings.md) and [the user guide](../../using/find-books.md).

Grid/list components virtualize rendered items while the server paginates records with stable sort keys and cursors. Those are different limits. Virtualization does not mean the client downloads the entire library.

### Responsive navigation

The **Delb** wordmark opens the dashboard. The toolbar shows all eight library
tabs when they fit. At smaller widths, Books, Shelves, and To be read stay
visible. **More** holds Authors, Series, Publishers, Genres, and Tags. When
that row cannot fit, a single dropdown contains the eight tabs. Its button
shows the current view or **Browse** when no tab is active.

### Library bookshelf

Bookshelf view shows the library's one shared arrangement. `GET /api/library/bookshelf` supplies the visible catalog and the arrangement in one compact response. Applied book filters fetch matching IDs through the authorized Books endpoint without changing the arrangement. Each book's precomputed spine dimensions belong to the book entry and appear wherever the book is shown.

[BookshelfView](../../../app/components/Books/BookshelfView.vue) owns loading, local edits, saves, and camera controls. Editors and Admins without tag visibility rules can save; everyone else can browse. Each [bookcase](../../../app/components/Books/BookshelfBookcase.vue) retains shelf geometry and drop targets while rendering nearby books. Spine artwork loads asynchronously, with title text visible while an image is pending.

### Personal Shelves

A Shelf is a private selection of book entries from the library. Its owner can add, remove, and arrange visible books. [Personal Shelf operations](../../../internal/bookshelf/shelves.go) store membership and placement separately from shelf geometry. Reads project only currently visible members and retain hidden placements for later restoration. Changing shared spine dimensions requires the Editor or Admin role. The grid, list, and visual bookshelf reuse the existing book view components.

## Filters and search

The Books page exposes a filter dropdown for title search, personal reading status, date added, finish date, file presence, and physical or audiobook copy marks. Dashboard status counts navigate to the corresponding Books filters.

Global search searches visible books and entities, including stored ISBNs. It is separate from the command palette and does not inherit every page filter. [Global search](global-search.md) names the relevant source files.

The Sidebar component contains disabled shelf, tag multi-select, and rating placeholders marked coming soon. They are not active filtering capabilities.

## Selection

Books selection supports explicit IDs and all-in-scope with exclusions. Bulk actions on shared catalog data, such as copy marks, require the Editor or Admin role. Bulk status changes affect only the reader's own data.

## Browse card art

Shelves, Authors, Series, Publishers, Genres, and Tags share the dashboard's
tile renderer. Each page applies its own saved **Card style** to the whole
grid. [Browse cards](../ui/browse-cards.md) describes the settings and preview
data.

## Add and edit books

The header Add book dialog offers Upload files, By metadata, and Manual entry. The dialog is available to Editors and Admins, and every new book goes into the library. Uploads and metadata imports create records through different backend paths. Manual entry opens a blank editor and creates the record when the user selects Create.

Shared metadata changes affect the existing book for everyone who can see it. A separate personal rating uses `book_ratings.rating`, with integers 1 through 10 representing half-star steps from 0.5 to 5 stars. Rating reads and writes select the current user.

## Sources

- [Header](../../../app/components/AppHeader.vue).
- [Books page](../../../app/pages/books/index.vue), [filter store](../../../app/stores/booksIndexFilters.ts), and [selection store](../../../app/stores/bookSelection.ts).
- [Shared grid](../../../app/components/Books/BooksInfiniteGrid.vue), [list](../../../app/components/Books/BooksInfiniteList.vue), and [view settings](../../../app/components/Books/BooksViewSettings.vue).
- [Core request flows](../core-workflows.md) for the backend connections.
