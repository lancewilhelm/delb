# Dashboard shelves and favorites

The dashboard uses the active collection from the header. All includes the authenticated reader's accessible collections. A book shared through several collections appears once.

The count strip stays above the shelf tabs and describes the whole selected collection. Switching tabs does not change its scope.

## Shelf order

| Shelf            | Included books                                             | Order                                                   |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| Continue reading | Current user's Reading status                              | Saved-position update, then status update, newest first |
| Recently read    | Current user's Finished status with a non-null finish date | Finish date, newest first                               |
| Favorites        | Current user's favorite flag, regardless of status         | Title, alphabetically without case distinction          |

Book ID resolves equal sort values. The API converts the stored finish date into a `YYYY-MM-DD` calendar date in the server's timezone, where the status endpoint parses date-only input. The browser formats that date without a timezone conversion. Finished books without a date remain in the Finished count but do not appear on Recently read.

## Dashboard API

`GET /api/dashboard` accepts these query parameters:

| Parameter      | Values                                     | Default   |
| -------------- | ------------------------------------------ | --------- |
| `shelf`        | `reading`, `recent`, `favorites`           | `reading` |
| `collectionId` | Accessible collection ID, or empty for All | All       |
| `offset`       | Non-negative safe integer                  | `0`       |

The response contains `data.counts` and `data.shelf`. The shelf has `kind`, `books`, and `nextOffset`. Each page contains up to twelve books. A null `nextOffset` ends the list. The frontend appends subsequent pages with **Show more**.

Each book includes its ID, title, cover pointer, update timestamp, progress, `finishedDate` calendar date, and `userFavorite` boolean. The shared response type is [DashboardData](../../../shared/types/dashboard.ts).

Unauthenticated requests return 401. Invalid query values return 400. An inaccessible collection returns zero counts and an empty shelf. Responses use `Cache-Control: private, no-store`.

The selected tab is stored in the dashboard's `shelf` URL parameter. Shelf and collection changes cancel the previous client request. A late response cannot replace the current selection. A failed later page keeps the books already displayed and offers Retry.

## Personal favorites

`PUT /api/books/:id/favorite` accepts `{ "favorite": true }` or `{ "favorite": false }`. It returns `data.userFavorite`. Sending the same value again is safe.

The handler requires a session and visible book. Collection viewers can favorite books because the value belongs to their own account. Invalid values return 400. Missing or inaccessible books return 404.

The flag is `user_book_preferences.favorite`, with a default of false. The generated additive migration preserves existing progress-sync preferences. The book detail API also returns `book.userFavorite`.

The star controls on book details and dashboard books wait for server acknowledgement before changing the displayed value. Failed writes keep the previous value and show an error. Removing a favorite from the Favorites shelf reloads that shelf.

Favorites are independent of reading status, ratings, and progress sync. Removing collection access hides its books from the dashboard even if a favorite record remains.

## Sources and verification

- [Dashboard query and favorite mutation](../../../server/utils/books/dashboard.ts)
- [Dashboard handler](../../../server/api/dashboard/index.get.ts)
- [Favorite handler](../../../server/api/books/[id]/favorite.put.ts)
- [Dashboard page](../../../app/pages/index.vue)
- [Star control](../../../app/components/BookFavoriteButton.vue)
- [SQLite behavior tests](../../../server/utils/books/dashboard.test.ts)
- [Component interaction checks](../../../review/dashboard.test.mjs)
- [Production API checks](../../../review/dashboard-api.mjs), included in `pnpm test:integration`
