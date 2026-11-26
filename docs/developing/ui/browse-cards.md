# Browse list cards (covers)

The top-level browse pages (Series, Authors, Publishers, Genres, and Tags) render a strip of book covers on the right side of each row.

## Implementation details

- Catalog list endpoints in [`internal/books/catalog.go`](../../../internal/books/catalog.go) return a `books` array per row with a nullable `coverThumbnailUrl`:
  - `GET /api/series`
  - `GET /api/authors`
  - `GET /api/publishers`
  - `GET /api/genres`
  - `GET /api/tags`
- UI pages render up to 4 covers per row:
  - [`app/pages/series/index.vue`](../../../app/pages/series/index.vue)
  - [`app/pages/authors/index.vue`](../../../app/pages/authors/index.vue)
  - [`app/pages/publishers/index.vue`](../../../app/pages/publishers/index.vue)
  - [`app/pages/genres/index.vue`](../../../app/pages/genres/index.vue)
  - [`app/pages/tags/index.vue`](../../../app/pages/tags/index.vue)

## Interaction details

- Covers support a right-click context menu via [`app/components/BookCover.vue`](../../../app/components/BookCover.vue) (`contextMenuItems` prop).
- Book thumbnails wire the menu to:
  - **View**, linking to `/books/:id`.
  - **Download**, shown only when the book has files; multiple files show per-format choices.
- The context menu lazily queries `GET /api/books/:id/files` in [`internal/books/books_files.go`](../../../internal/books/books_files.go).

## Series list cards (covers)

Series rows order covers by series index. `GET /api/series` in [`internal/books/catalog.go`](../../../internal/books/catalog.go) returns book records with nullable cover thumbnail URLs, and [`app/pages/series/index.vue`](../../../app/pages/series/index.vue) chooses how many covers to display.
