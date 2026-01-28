# Browse list cards (covers)

The top-level browse pages (Series, Authors, Publishers, Tags) render a small strip of book covers on the right side of each row.

Implementation details:

- APIs return a `books` array per row with `coverThumbnailUrl` (nullable):
  - `server/api/series/index.get.ts`
  - `server/api/authors/index.get.ts`
  - `server/api/publishers/index.get.ts`
  - `server/api/tags/index.get.ts`
- UI pages render up to 4 covers (front end decides how many):
  - `app/pages/series/index.vue`
  - `app/pages/authors/index.vue`
  - `app/pages/publishers/index.vue`
  - `app/pages/tags/index.vue`

Interaction details:

- Covers support a right-click context menu via `app/components/BookCover.vue` (`contextMenuItems` prop).
- Book thumbnails wire the menu to:
  - `View` → `/books/:id`
  - `Download` (only shown when the book has files; multiple files show per-format choices)
- The context menu lazily queries `GET /api/books/:id/files` (`server/api/books/[id]/files.get.ts`).
