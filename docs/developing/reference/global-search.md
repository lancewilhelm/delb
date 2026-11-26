# Global search

Delb includes a unified global search modal that searches across visible library records:

- Books
- Authors
- Series
- Publishers
- Genres
- Tags

## Book identifiers (ISBN)

Book results include stored ISBN identifiers, and you can search directly by ISBN (including with a barcode scanner).

## Implementation details

- API: `GET /api/search` in [`internal/books/catalog.go`](../../../internal/books/catalog.go)
- Identifiers storage: `book_identifiers` table in [`.drizzle/migrations`](../../../.drizzle/migrations)
- UI: [`app/components/GlobalSearch/GlobalSearchModal.vue`](../../../app/components/GlobalSearch/GlobalSearchModal.vue)
