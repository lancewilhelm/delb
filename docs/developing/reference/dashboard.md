# Dashboard

The dashboard uses the active collection from the header. All includes the authenticated reader's accessible collections. A book shared through several collections appears once. Personal shelves are not collection-scoped, so the shelf tiles are the same for every collection.

## Layout

| Section          | Contents                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All books card   | Total books, an optional color-coded status bar, a link per non-empty status, **Browse all books**, and cover art of the most recently added books            |
| Continue reading | Up to three Reading books with their latest progress; **View all** opens the status-filtered Books view                                                       |
| Reading status   | One tile per status (Reading, To be read, Finished, DNF, No status) with its count and cover art; To be read opens the dedicated queue, others the Books view |
| Your shelves     | One tile per personal shelf, then **New shelf**                                                                                                               |

**Browse all books** clears the persisted Books filters before navigating; status links keep them. All counts, including To be read, describe the selected collection.

### All books art

The card's **⋯** menu, or **Appearance → Dashboard → All books art**, chooses **Wall** (the default) or **Pile**.

Pile drops up to 24 of the newest covers (20 on narrow cards) into a draggable pile, using the same physics as Pile tiles. The books stay to the right of the text, or above it on narrow cards. A pile suits any size, so it is used whenever the collection has at least one book.

Wall depends on how many recent covers the collection has, so a small collection never looks broken:

| Covers | Art                                                                        |
| ------ | -------------------------------------------------------------------------- |
| 16+    | A tilted 9-column wall of covers with an even gap                          |
| 4–15   | A 7-column wall of larger covers; repeats never touch a copy of themselves |
| 1–3    | The books face-out with dashed empty slots, plus **Add books**             |
| 0      | Line art with **Add books**                                                |

Books without a cover image, or whose image fails to load, use the generated title cover.

### Card art

Status and shelf tiles draw their art in one of six styles: Collage, Fan, Stack, Shelf, Pile, or Wall. Each tile's **⋯** menu picks a style for that tile; **Use default** removes the choice. **Appearance → Dashboard → Card art** sets the default for the rest. **Auto**, the default, gives each list its own style:

| List       | Auto style |
| ---------- | ---------- |
| Reading    | Stack      |
| To be read | Fan        |
| Finished   | Shelf      |
| DNF        | Stack      |
| No status  | Pile       |
| Shelves    | Fan        |

Every style works from a single cover up. Pile tiles hold up to ten books. Wall fills 25 slots: lists with 25 or more books show no repeats, smaller lists repeat covers in a pattern where no copy touches another, and lists under four books draw as Fan. Shelf shows the first book face-out (with its finish date on Finished) and the rest as spines. DNF art is desaturated.

Pile lands in a new random scatter every time the page loads. Readers can drag a book in a pile: it lifts, tilts with the motion, then drops, slides, and settles. Books overlap rather than collide. A drag does not open the tile. With reduced motion, books are placed without the drop-in or tilt.

## Dashboard API

`GET /api/dashboard/overview` loads the whole dashboard in one request.

| Parameter      | Values                                     | Default |
| -------------- | ------------------------------------------ | ------- |
| `collectionId` | Accessible collection ID, or empty for All | All     |

The response contains `data.counts`, `data.recent`, and `data.lists`. `recent` holds up to 45 visible books, newest first. `lists` holds up to 25 books for each of `reading`, `to_be_read`, `finished`, `dnf`, and `none`. Each book includes its ID, title, cover pointer, update timestamp, progress, and `finishedDate` calendar date. The shared response type is [DashboardOverview](../../../shared/types/dashboard.ts).

| List       | Order                                                       |
| ---------- | ----------------------------------------------------------- |
| Reading    | Saved-position update, then status update, newest first     |
| To be read | Queue rank, then unranked books                             |
| Finished   | Finish date, newest first; books without a finish date last |
| DNF        | Status update, newest first                                 |
| No status  | Date added, newest first                                    |

Book ID resolves equal sort values. The API converts the stored finish date into a `YYYY-MM-DD` calendar date in the server's timezone; the browser formats it without a timezone conversion.

Unauthenticated requests return 401. An inaccessible collection returns zero counts and empty lists. Responses use `Cache-Control: private, no-store`.

The shelf tiles use `GET /api/shelves?previews=25`, enough to fill a Wall tile's 25 slots. `previews` accepts 1–25 and defaults to 4 (the Shelves page).

`GET /api/dashboard?shelf=&collectionId=&offset=` still returns counts and one paged shelf (`reading`, `finished` with a date, or `tbr`), twelve books per page. The dashboard page no longer uses it.

## Client behavior

The page paints the last overview for the same user and collection from local cache while it fetches fresh data. A collection change cancels the previous request, and a late response cannot replace the current one. A failed load offers Retry.

The Continue reading covers keep the **Reading status** menu. A change that moves a book out of Reading reloads the overview so every count and tile stays consistent.

## Sources and verification

- [Overview query and handler](../../../internal/books/dashboard.go)
- [Paged shelf handler](../../../internal/books/reading_state.go)
- [Dashboard page](../../../app/pages/index.vue) and [components](../../../app/components/Dashboard)
- [Card art rules](../../../app/utils/dashboardArt.ts) and [pile physics](../../../app/utils/pilePhysics.ts)
- [SQLite behavior tests](../../../internal/books/books_test.go)
- [Card art unit tests](../../../app/utils/dashboardArt.test.ts)
- [Component interaction checks](../../../review/dashboard.test.mjs)
- [Production API checks](../../../review/dashboard-api.mjs), included in `pnpm test:integration`
