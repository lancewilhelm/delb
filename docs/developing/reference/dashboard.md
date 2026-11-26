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

Pile drops books picked at random from the collection into a draggable pile: 24 by default (20 on narrow cards), or the reader's **Pile size**, using the same physics as Pile tiles. The books stay to the right of the text, or above it on narrow cards. A pile suits any size, so it is used whenever the collection has at least one book.

**Appearance → Dashboard → Wall motion** can set the Wall to **Drift up** (default **Off**). The grid then moves slowly upward along its columns, at a **Drift speed** from 1 to 10 (default 3, about 9 pixels per second). Each time a row leaves the top, a new row of older covers arrives at the bottom. The page fetches the next 45 covers about three rows before they are needed, and loops back to the newest once the whole collection has been shown. Copies never touch, including where the list wraps. Drift stays off when the system asks for reduced motion, and pauses while the card is off screen or the tab is hidden. The ⋯ menu does not offer motion; the setting and the command palette's **dashboard › wall drift up** toggle do.

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

Every style works from a single cover up. Pile tiles hold books picked at random from the list, ten by default or the reader's **Pile size**; the other styles show the start of the list in its order. Wall fills 25 slots: lists with 25 or more books show no repeats, smaller lists repeat covers in a pattern where no copy touches another, and lists under four books draw as Fan. Shelf shows the first book face-out (with its finish date on Finished) and the rest as spines. A book with spine artwork shows that artwork in its own proportions; other books, or artwork that fails to load, get a generated colored spine. DNF art is desaturated.

**Appearance → Dashboard → Pile size** sets how many books every pile holds: **Auto** (the defaults above), 10, 25, 50, or 100. Piles bigger than their default use smaller covers.

Pile picks its books and lands in a new random scatter every time the page loads. The books pour in one after another, at most 0.07 seconds apart, and a whole pour takes at most 2.5 seconds. Each pile drops in once. A sample of the wrong size, from a cache made before the reader changed **Pile size**, is not shown; the pile waits for a fitting sample instead. When fresh data replaces the cached dashboard, each pile keeps its books unless its list changed size. If the books do change, the books that stay keep their places and only new books drop in. Readers can drag a book in a pile: it lifts, tilts with the motion, then drops, slides a short way, and settles. Books overlap rather than collide. A drag does not open the tile. With reduced motion, books are placed without the drop-in or tilt.

## Dashboard API

`GET /api/dashboard/overview` loads the whole dashboard in one request.

| Parameter      | Values                                     | Default |
| -------------- | ------------------------------------------ | ------- |
| `collectionId` | Accessible collection ID, or empty for All | All     |
| `pile`         | Pile size, 1–100                           | Auto    |

The response contains `data.counts`, `data.recent`, `data.lists`, and `data.piles`. `recent` holds up to 45 visible books, newest first. `lists` holds up to 25 books for each of `reading`, `to_be_read`, `finished`, `dnf`, and `none`. `piles` holds a new random sample on every request: up to 24 books from the whole scope under `all`, and up to 10 books from each status list under the same keys as `lists`. With `pile`, every sample holds up to that many books. Any other `pile` value returns 400. Each book includes its ID, title, cover pointer, update timestamp, progress, `finishedDate` calendar date, and `spineRevision` (set when the book has spine artwork). The shared response type is [DashboardOverview](../../../shared/types/dashboard.ts).

| List       | Order                                                       |
| ---------- | ----------------------------------------------------------- |
| Reading    | Saved-position update, then status update, newest first     |
| To be read | Queue rank, then unranked books                             |
| Finished   | Finish date, newest first; books without a finish date last |
| DNF        | Status update, newest first                                 |
| No status  | Date added, newest first                                    |

Book ID resolves equal sort values. The API converts the stored finish date into a `YYYY-MM-DD` calendar date in the server's timezone; the browser formats it without a timezone conversion.

Unauthenticated requests return 401. An inaccessible collection returns zero counts and empty lists. Responses use `Cache-Control: private, no-store`.

`GET /api/dashboard/recent?collectionId=&offset=` pages through the same newest-first books after the overview's first 45, for a drifting wall. Each page holds up to 45 books, and a null `nextOffset` ends the list. An invalid offset returns 400.

The shelf tiles use `GET /api/shelves?previews=25&pile=10`, with the reader's **Pile size** in place of 10. `previews=25` fills a Wall tile's 25 slots. `previews` accepts 1–25 and defaults to 4 (the Shelves page). Each preview includes the book's `spineRevision`. `pile` accepts 1–100; when it is present, each non-empty shelf includes a `pile` array of that many books picked at random. Without it the response has no `pile` field.

`GET /api/dashboard?shelf=&collectionId=&offset=` still returns counts and one paged shelf (`reading`, `finished` with a date, or `tbr`), twelve books per page. The dashboard page no longer uses it.

## Client behavior

The page paints the last overview for the same user and collection from local cache while it fetches fresh data. Pile art keeps the sample that it painted first (see [Card art](#card-art)), so a pile does not swap books or drop in again when the fresh overview arrives. A pile from an overview cached before `piles` existed, or cached at another pile size, stays empty until fresh data arrives. A collection change cancels the previous request, and a late response cannot replace the current one. A failed load offers Retry.

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
