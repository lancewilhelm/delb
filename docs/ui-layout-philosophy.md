# Library navigation and layout

Delb separates collection scope, library navigation, and book presentation. This page describes the current layout. Earlier layout proposals have been replaced by the implementation-backed explanation below.

## Collection scope

The header collection picker chooses All or a specific accessible collection. All combines books visible through collection membership. Personal is a default collection, not a second global catalog.

A book can belong to several collections while retaining one shared metadata record. Each reader has separate ratings, status, reading position, and progress history. See [Delb's data model](developing/data-model.md).

## Navigation and book views

The navigation exposes Dashboard, Books, Authors, Series, Publishers, and Tags. These are ways to browse the selected scope. Within supported book listings, grid and list are separate book views with independent visible fields and ordering.

Books, author, publisher, and tag book listings use the shared grid/list field preferences. Series retains a separate presentation. The view-settings button sits beside the grid/list switch. Changes apply immediately through account settings, including the mobile profile when enabled.

Grid cards keep selected values on one line and omit missing metadata. List cells wrap to at most three lines and use a dash for missing values. Covers remain fixed first. See [accepted book view behavior](book-view-settings.md) and [the user guide](using/find-books.md).

Grid/list components virtualize rendered items while the server paginates records with stable sort keys and cursors. Those are different limits. Virtualization does not mean the client downloads the entire library.

## Filters and search

The Books page exposes a filter dropdown for personal reading status, date added, and file presence. Dashboard status counts navigate to the corresponding Books filters.

Global search searches accessible books and entities, including stored ISBNs. It is separate from the command palette and does not inherit every page filter. [Global search](global-search.md) names the relevant source files.

The Sidebar component contains disabled shelf, tag multi-select, and rating placeholders marked coming soon. They are not active filtering capabilities.

## Selection and collection changes

Books selection supports explicit IDs and all-in-scope with exclusions. Collection bulk actions require a concrete editable source collection and editable target collections. Personal links cannot be removed. Single-book detail controls allow membership changes in editable targets after visibility checks.

Owner/editor rights govern collection membership changes. They do not by themselves grant permission to edit a book's shared metadata or delete its record. See [access control](collections-sharing-rbac.md).

## Add and edit books

The header Add book dialog offers Upload files, By metadata, and Manual entry. Personal stays included while users select other targets. Uploads and metadata imports create records through different backend paths. Manual entry opens a blank editor and creates the record when the user selects Create.

Shared metadata changes affect the existing book across collections. A separate personal rating uses `book_ratings.rating`, with integers 1 through 10 representing half-star steps from 0.5 to 5 stars. Rating reads and writes select the current user.

## Sources

- [Header](../app/components/AppHeader.vue) and [collection picker](../app/components/CollectionPickerDropdown.vue).
- [Books page](../app/pages/books/index.vue), [filter store](../app/stores/booksIndexFilters.ts), and [selection store](../app/stores/bookSelection.ts).
- [Shared grid](../app/components/Books/BooksInfiniteGrid.vue), [list](../app/components/Books/BooksInfiniteList.vue), and [view settings](../app/components/Books/BooksViewSettings.vue).
- [Core request flows](developing/core-workflows.md) for the backend connections.
