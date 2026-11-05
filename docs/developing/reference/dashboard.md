# Dashboard shelves

The dashboard uses the active collection from the header. All includes the authenticated reader's accessible collections. A book shared through several collections appears once.

The count strip stays above the shelf tabs. To be read always counts the full personal queue across accessible collections and opens the dedicated queue page. Other counts describe the selected collection. Switching shelf tabs does not change either scope.

## Shelf order

| Shelf            | Included books                                             | Order                                                   |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| Continue reading | Current user's Reading status                              | Saved-position update, then status update, newest first |
| Recently read    | Current user's Finished status with a non-null finish date | Finish date, newest first                               |

Book ID resolves equal sort values. The API converts the stored finish date into a `YYYY-MM-DD` calendar date in the server's timezone, where the status endpoint parses date-only input. The browser formats that date without a timezone conversion. Finished books without a date remain in the Finished count but do not appear on Recently read.

## Dashboard API

`GET /api/dashboard` accepts these query parameters:

| Parameter      | Values                                     | Default   |
| -------------- | ------------------------------------------ | --------- |
| `shelf`        | `reading`, `recent`                        | `reading` |
| `collectionId` | Accessible collection ID, or empty for All | All       |
| `offset`       | Non-negative safe integer                  | `0`       |

The response contains `data.counts` and `data.shelf`. The shelf has `kind`, `books`, and `nextOffset`. Each page contains up to twelve books. A null `nextOffset` ends the list. The frontend appends subsequent pages with **Show more**.

Each book includes its ID, title, cover pointer, update timestamp, progress, and `finishedDate` calendar date. The shared response type is [DashboardData](../../../shared/types/dashboard.ts).

Unauthenticated requests return 401. Invalid query values return 400. An inaccessible collection returns an empty shelf and zero collection-scoped counts. The personal To be read count keeps its global scope. Responses use `Cache-Control: private, no-store`.

The selected tab is stored in the dashboard's `shelf` URL parameter. Shelf and collection changes cancel the previous client request. A late response cannot replace the current selection. A failed later page keeps the books already displayed and offers Retry.

Status changes update the loaded shelf and count strip in place. A book that no longer belongs on the selected shelf is removed without resetting the other loaded books or scroll position. Removing a book adjusts the next-page offset; an in-flight later page restarts at that offset so no book is skipped. Optional reading-status badges derive their status from the selected shelf.

## Sources and verification

- [Dashboard query](../../../server/utils/books/dashboard.ts)
- [Dashboard handler](../../../server/api/dashboard/index.get.ts)
- [Dashboard page](../../../app/pages/index.vue)
- [SQLite behavior tests](../../../server/utils/books/dashboard.test.ts)
- [Component interaction checks](../../../review/dashboard.test.mjs)
- [Production API checks](../../../review/dashboard-api.mjs), included in `pnpm test:integration`
