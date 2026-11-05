# Dashboard shelves

The dashboard uses the active collection from the header. All includes the authenticated reader's accessible collections. A book shared through several collections appears once.

The count strip stays above the shelf tabs and describes the whole selected collection. Switching tabs does not change its scope.

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

Unauthenticated requests return 401. Invalid query values return 400. An inaccessible collection returns zero counts and an empty shelf. Responses use `Cache-Control: private, no-store`.

The selected tab is stored in the dashboard's `shelf` URL parameter. Shelf and collection changes cancel the previous client request. A late response cannot replace the current selection. A failed later page keeps the books already displayed and offers Retry.

## Sources and verification

- [Dashboard query](../../../server/utils/books/dashboard.ts)
- [Dashboard handler](../../../server/api/dashboard/index.get.ts)
- [Dashboard page](../../../app/pages/index.vue)
- [SQLite behavior tests](../../../server/utils/books/dashboard.test.ts)
- [Component interaction checks](../../../review/dashboard.test.mjs)
- [Production API checks](../../../review/dashboard-api.mjs), included in `pnpm test:integration`
