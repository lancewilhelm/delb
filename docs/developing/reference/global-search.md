# Global search

Delb includes a unified “global search” (command-palette style) that searches across:

- Books
- Authors
- Series
- Publishers
- Tags

## Book identifiers (ISBN)

Book results include ISBN identifiers (when stored on the book), and you can search by ISBN (useful for barcode scanners).

Implementation details:

- API: `internal/books/catalog.go`
- Identifiers storage: `.drizzle/migrations` (`book_identifiers` table)
- UI: `app/components/GlobalSearch/GlobalSearchModal.vue`
