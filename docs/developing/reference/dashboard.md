# Dashboard

The dashboard describes the books in the library that the authenticated reader can see. Tag visibility rules apply to every count, list, and card.

## Layout

| Section          | Contents                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All books card   | Total books, an optional color-coded status bar, a link per non-empty status, **Browse all books**, and art of the library's books                            |
| Continue reading | Up to three Reading books with their latest progress; **View all** opens the status-filtered Books view                                                       |
| Reading status   | One tile per status (Reading, To be read, Finished, DNF, No status) with its count and cover art; To be read opens the dedicated queue, others the Books view |
| Your shelves     | One tile per personal shelf, then **New shelf**                                                                                                               |

The **Delb** link in the header always opens the dashboard. **Browse all books** clears the persisted Books filters before navigating; status links keep them. All counts, including To be read, describe the books that the reader can see.

### All books art

The card's **⋯** menu, or **Appearance → Dashboard → All books art**, chooses **Wall** (the default), **Pile**, or **Shelf**.

Pile drops books picked at random from the library into a draggable pile: 24 by default (20 on narrow cards), or the reader's **Pile size**, using the same physics as Pile tiles. The books stay to the right of the text, or above it on narrow cards. A pile suits any size, so it is used whenever the reader can see at least one book.

Shelf stands the most recently added books, newest first, in one row across the card on a plain ground drawn from the theme's colors. Like the wall, the row fades out under the text. On narrow cards it sits above the text instead. It draws the bookshelf's own spines (spine artwork, or a colored spine with the title and author), sized the way the bookshelf sizes them, and never larger than on the bookshelf. On wide cards the card's right edge always cuts a spine at its middle, so the shelf looks like it continues: the last book when every book fits, or the book that reaches the edge when the row starts under the text and runs on. On narrow cards the row is centered, and a longer row runs past both edges. The card loads more books while the row has room. **Spine art only**, shown while Shelf is chosen, limits the shelf to books with spine artwork; a library without any says so on the card.

**Appearance → Dashboard → Wall motion** can set the Wall to **Drift up** (default **Off**). The grid then moves slowly upward along its columns, at a **Drift speed** from 1 to 10 (default 3, about 9 pixels per second). Each time a row leaves the top, a new row of older covers arrives at the bottom. The page fetches the next 45 covers about three rows before they are needed, and loops back to the newest once every visible book has been shown. Copies never touch, including where the list wraps. Drift stays off when the system asks for reduced motion, and pauses while the card is off screen or the tab is hidden. The ⋯ menu does not offer motion; the setting and the command palette's **dashboard › wall drift up** toggle do.

Wall depends on how many recent covers the reader can see, so a small library never looks broken:

| Covers | Art                                                                        |
| ------ | -------------------------------------------------------------------------- |
| 16+    | A tilted 9-column wall of covers with an even gap                          |
| 4–15   | A 7-column wall of larger covers; repeats never touch a copy of themselves |
| 1–3    | The books face-out with dashed empty slots, plus **Add books**             |
| 0      | Line art with **Add books**                                                |

Both wall layouts choose a random starting cover from the overview's first page when the dashboard opens. With drift on, new pages extend that same cover sequence.

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

Shelf art sizes each spine the way the bookshelf does: a width set by hand on the bookshelf is kept, and otherwise the width follows the book's current page count (from 22 to 55 units). Heights are the stored height that each book gets when it is created.

Every style works from a single cover up. Pile tiles hold books picked at random from the list, ten by default or the reader's **Pile size**; the other styles show the start of the list in its order. Wall fills 25 slots: lists with 25 or more books show no repeats, smaller lists repeat covers in a pattern where no copy touches another, and lists under four books draw as Fan. Shelf stands the list's books as spines in one row, in list order, the same way as the All books Shelf. A row that fits is centered. A list with more books than fit runs past both edges of the tile, so the cut spines show that it holds more. DNF art is desaturated.

**Appearance → Dashboard → Pile size** sets how many books every pile holds: **Auto** (the defaults above), or **Custom** with a number from 1 to 250. Piles bigger than their default use smaller covers. **Pile pour** offers **Staggered**, **All at once**, and **No pour**. All at once starts every book's fall together. No pour places books directly in the pile, where they can still be dragged. In Staggered mode, **Pour speed** ranges from 1 to 10 and defaults to 5. Level 10 takes half the default time, and level 1 takes five times as long.

Pile picks its books and lands in a new random scatter every time the page loads. At the default **Pour speed**, the books pour in one after another, at most 0.07 seconds apart, and a whole pour takes at most 2.5 seconds. The initial layout runs once per pile. A sample of the wrong size, from a cache made before the reader changed **Pile size**, is not shown; the pile waits for a fitting sample instead. When fresh data replaces the cached dashboard, each pile keeps its books unless its list changed size. If the books do change, the books that stay keep their places and only new books follow the configured pour. Readers can drag a book in a pile: it lifts, tilts with the motion, then drops, slides a short way, and settles. Books overlap rather than collide. A drag does not open the tile. With reduced motion, books are placed without the drop-in or tilt.

## Dashboard API

`GET /api/dashboard/overview` loads the whole dashboard in one request.

| Parameter | Values           | Default |
| --------- | ---------------- | ------- |
| `pile`    | Pile size, 1–250 | Auto    |

The response contains `data.counts`, `data.recent`, `data.lists`, and `data.piles`. `recent` holds up to 45 visible books, newest first. `lists` holds up to 25 books for each of `reading`, `to_be_read`, `finished`, `dnf`, and `none`. `piles` holds a new random sample on every request: up to 24 visible books under `all`, and up to 10 books from each status list under the same keys as `lists`. With `pile`, every sample holds up to that many books. Any other `pile` value returns 400. Each book includes its ID, title, cover pointer, update timestamp, progress, `finishedDate` calendar date, `spineRevision` (set when the book has spine artwork), `pages`, `shelfWidth` (a spine width set by hand on the bookshelf, otherwise null), and `shelfHeight` (the stored spine height, or null). The shared response type is [DashboardOverview](../../../shared/types/dashboard.ts).

| List       | Order                                                       |
| ---------- | ----------------------------------------------------------- |
| Reading    | Saved-position update, then status update, newest first     |
| To be read | Queue rank, then unranked books                             |
| Finished   | Finish date, newest first; books without a finish date last |
| DNF        | Status update, newest first                                 |
| No status  | Date added, newest first                                    |

Book ID resolves equal sort values. The API converts the stored finish date into a `YYYY-MM-DD` calendar date in the server's timezone; the browser formats it without a timezone conversion.

Unauthenticated requests return 401. An account whose tag visibility rules hide every book gets zero counts and empty lists. Responses use `Cache-Control: private, no-store`.

`GET /api/dashboard/recent?offset=&spines=` pages through the same newest-first books after the overview's first 45, for a drifting wall or a Shelf. `spines=1` lists only books with spine artwork, from offset 0, for **Spine art only**. Each page holds up to 45 books, and a null `nextOffset` ends the list. An invalid offset, or a `spines` value other than `0` or `1`, returns 400.

The shelf tiles use `GET /api/shelves?previews=25&pile=10`, with the reader's **Pile size** in place of 10. `previews=25` fills a Wall tile's 25 slots. `previews` accepts 1–25 and defaults to 4 (the Shelves page). Each preview includes the book's `spineRevision`, `pages`, `shelfWidth`, and `shelfHeight`. `pile` accepts 1–250; when it is present, each non-empty shelf includes a `pile` array of that many books picked at random. Without it the response has no `pile` field.

`GET /api/dashboard?shelf=&offset=` still returns counts and one paged shelf (`reading`, `finished` with a date, or `tbr`), twelve books per page. The dashboard page no longer uses it.

## Client behavior

The page paints the last overview for the same user from local cache while it fetches fresh data. Pile art keeps the sample that it painted first (see [Card art](#card-art)), so a pile does not swap books or drop in again when the fresh overview arrives. A pile from an overview cached before `piles` existed, or cached at another pile size, stays empty until fresh data arrives. A new request cancels the previous one, and a late response cannot replace the current one. A failed load offers Retry.

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
