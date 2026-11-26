# Share cards

A share card is a PNG image that summarizes one finished book for posting outside Delb. The browser draws it on a canvas from the reader's own finish summary. The card never includes a link to the library, the reader's review, or notes.

## Finish summary endpoint

`GET /api/books/{id}/finish-summary` returns the data that a card draws. The [handler](../../../internal/books/finish_summary.go) requires a session and uses the same collection-membership check as `GET /api/books/{id}`. A book that the reader cannot see returns 404. Every personal field comes from the authenticated reader's own rows, so a member of a shared collection never sees another reader's dates, rating, or progress.

| Field                             | Meaning                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `book`                            | Title, author names in position order, series, page count, cover path, and `updatedAt` for the cover URL                           |
| `status`                          | The reader's status, or `null`                                                                                                     |
| `startedAt`, `finishedAt`         | Stored timestamps as ISO strings, or `null`                                                                                        |
| `startedDate`, `finishedDate`     | The same dates as local `YYYY-MM-DD` calendar days, which match the dates the book page shows                                      |
| `durationDays`                    | Calendar days from start to finish, counting both days, so a book started and finished on one day has 1. `null` without both dates |
| `pages`                           | The book's page count, or `null` when it is missing or zero                                                                        |
| `pagesPerDay`                     | `pages ÷ durationDays`, rounded to one decimal, or `null` when either is missing                                                   |
| `rating`                          | The reader's half-star rating from 1 to 10, or `null`                                                                              |
| `finishYear`, `yearFinishOrdinal` | The local year of the finish date, and the book's position among the reader's visible finished books in that year                  |
| `progress.days`                   | One entry per calendar day from start to finish, described below                                                                   |
| `progress.checkpointCount`        | The number of days in that range on which the reader logged progress                                                               |

The ordinal counts books whose status is `finished` with a finish date in the same year, up to and including this one. Books finished at the same instant are ordered by ID. Books that the reader can no longer see are not counted.

### Daily progress series

Unlike `GET /api/books/{id}/progress-logs`, which returns at most 200 entries, the series covers the whole reading window. Each day carries:

- `percent`: cumulative progress at the end of the day. It starts at 0 on the start date and never decreases. A day without a log, or with a lower log than an earlier day, keeps the previous value.
- `deltaPercent`: the progress gained that day.
- `pages` and `pagesRead`: the same values in pages when the book has a page count, otherwise `null`.
- `hasCheckpoint`: whether the reader logged progress that day.

Logs are bucketed by the local calendar day of `occurred_at`, and the highest percentage on a day wins. Logs outside the window are ignored, so an earlier read does not leak into the chart. The `status-finished` entry that a finish date creates counts as a checkpoint on the finish day. A window longer than 3,660 days returns an empty series; the other fields are unaffected.

## Card model and toggles

[`buildShareCardModel`](../../../app/utils/shareCardModel.ts) combines the summary with the reader's toggles. A stat appears only when its toggle is on and the data exists:

| Toggle            | Shows                                      | Needs                                      |
| ----------------- | ------------------------------------------ | ------------------------------------------ |
| Rating            | Stars or a rating stat                     | A rating                                   |
| Duration & dates  | Days, the date range, and "Book N of YYYY" | A finish date; days also need a start date |
| Page count & pace | Pages and pages per day                    | A page count; pace also needs a start date |
| Pace chart        | The pace curve or daily bar chart          | A start date and 3 or more checkpoint days |
| Delb logo         | The Delb mark                              | Nothing                                    |

The chart threshold prevents a made-up straight line between a start and a finish. The Cover palette and Duotone styles draw no chart, so the dialog disables that toggle for them.

## Styles and formats

The [renderer](../../../app/utils/shareCardRender.ts) uses only the Canvas 2D API and the bundled Noto Serif, Inter, and IBM Plex Mono fonts. It waits for those faces before drawing. Layout math, such as text wrapping, safe areas, and chart geometry, lives in [shareCardLayout.ts](../../../app/utils/shareCardLayout.ts) and takes a text-measuring function, so it is unit tested without a browser.

| Style           | Look                                                                                    |
| --------------- | --------------------------------------------------------------------------------------- |
| Cover palette   | Dark cover-tinted glow, centered cover, serif title, and stats (the default)            |
| Editorial split | Cover on a tinted panel, a large hero stat, and a daily bar chart on a light panel      |
| Swiss grid      | Warm light poster with hairline rules, the cover on a muted mat, and tabular stats      |
| Duotone         | Bold accent field with the cover and a hard shadow, and a footer of stats with the mark |
| Pace overlay    | Large duration and page numbers over a cumulative pace curve, with a cover pill below   |

Pace overlay has three backgrounds: **Theme** uses the active theme's `--bg-color`, `--text-color`, `--main-color`, and `--sub-color`. **Soft cover** fills the card with a blurred, darkened cover; the blur comes from scaling a tiny copy of the cover, which works in every browser. **Transparent** leaves the background empty and adds text shadows, for placing the PNG over a photo.

Formats are Square (1080 × 1080, the default), Story (1080 × 1920), and Landscape (1200 × 630). Story cards keep the top 260 and bottom 300 pixels clear of text, where story apps draw their own controls.

## Cover palette

[shareCardPalette.ts](../../../app/utils/shareCardPalette.ts) samples the cover at 36 × 54 pixels and clusters the colors in OKLab with a deterministic k-means. The largest colorful cluster sets the background hue, and the most vivid cluster that covers at least 3% of the cover sets the accent. Each role, such as dark background, paper, ink, or duotone field, has a fixed OKLab lightness, so text contrast holds for very light and very dark covers. The unit tests check WCAG contrast for the main text and background pairings. Covers load from the same origin, so the canvas stays exportable. Without a cover, the palette derives from the theme's main color.

## Export

[shareCardExport.ts](../../../app/utils/shareCardExport.ts) offers three actions:

- **Download PNG** saves the canvas as `delb-<title>-<format>.png`.
- **Copy image** writes a `ClipboardItem` whose value is a promise of the PNG. Safari only allows clipboard writes that start during the click, so the item is created before the PNG exists. The button is hidden where the Clipboard API cannot write images.
- **Share** passes the PNG as a `File` to `navigator.share` with the book title and no URL. The button appears only when `navigator.canShare` accepts a PNG file.

## Entry points

- The book detail page shows **Share card** next to the status when the reader's status is Finished.
- Choosing **Finished** for one book, on the book detail page or from a cover's **Reading status** menu, shows a toast: "Finished _Title_ · Share card". It closes after about nine seconds and stays while the pointer or focus is on it. **Don't ask again** sets `shareCard.promptOnFinish` to `false` (see [settings](settings.md#share-cards)). Bulk status changes, Goodreads imports, and editing only the finish date show no toast.

The [share card store](../../../app/stores/shareCard.ts) holds the open book and the toast. The [dialog](../../../app/components/ShareCard/ShareCardModal.vue) and [toast](../../../app/components/ShareCard/ShareCardToast.vue) are mounted once in `app.vue`, so either entry point works on any page.
