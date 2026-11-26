# Reading status and progress rules

This document describes how per-user status dates and progress logs work.

## Status metadata

Status metadata lives on `user_book_status` and is user-scoped:

- `status`: `to_be_read | reading | finished | dnf`
- `startedAt`: first read date (historical)
- `finishedAt`: finished date
- `dnfAt`: did-not-finish date
- `tbrRank`: ordering value for `to_be_read`

### Behavior rules

Every date is optional. A reader can record no dates, some dates, or all dates.

- Entering `reading` sets `startedAt` to today if it is empty, unless the request includes `startedAt`. Entering `finished` does the same for `finishedAt`, and entering `dnf` does the same for `dnfAt`. A request can send `null` for that date to record the status without a date.
- Choosing the status that a book already has fills no dates.
- Entering `finished` or `dnf` never fills `startedAt`.
- Clearing any date (sending `null`) keeps the status.
- Leaving `finished` clears `finishedAt`; leaving `dnf` clears `dnfAt`.
- Switching to `to_be_read` clears `startedAt`, `finishedAt`, and `dnfAt`.
- `startedAt` is kept as historical data when status changes away from reading.
- Setting a date sets the matching status:
  - Setting `finishedAt` sets status to `finished`.
  - Setting `dnfAt` sets status to `dnf`.
  - Setting `startedAt` sets status to `reading` when the current status is `to_be_read` or unset.
- When both are set, `finishedAt` and `dnfAt` must be on or after `startedAt`.
- DNF does not create a progress log.
- Finished with a finish date creates or updates a 100% progress log on that date. Clearing the finish date removes that log entry.
- Setting a TBR rank keeps the list contiguous:
  - Moving a book down shifts intermediate ranks up.
  - Moving a book up shifts intermediate ranks down.
  - Removing a ranked TBR book shifts higher ranks down.
  - Ranks are capped to the current TBR list size.
  - The queue contains only books that the reader can see.
  - Newly added and re-added books append at the end.
  - A book hidden by a tag visibility rule leaves every queue response. Each renumbering gives visible books ranks 1 through N and moves hidden queued books after them in their previous order, so ranks never repeat. A book that becomes visible again rejoins at the end of the queue.

## TBR rationale and visibility

`user_book_rationale` stores one private plain-text rationale per user and book, independently of `user_book_status`. Clearing status retains the rationale. Reads and writes require current book visibility and use the authenticated user's identity.

The dedicated TBR page loads the full ranked queue. Its inline editor and book details use the same rationale endpoints. On the dashboard, all counts, including **To be read**, describe the books that the reader can see.

The status transition service handles numeric moves and single/bulk status changes transactionally. The pre-1.0 migration `0022_single_library` removed the earlier access-change triggers, which compacted ranks when collection membership changed; tag visibility rules change through ordinary queries instead.

## Reviews and notes

`user_book_reviews` stores one private review per user and book, with a `contains_spoilers` flag. `PUT /api/books/{id}/review` saves the review, and saving blank text deletes it. `book_notes` stores any number of private notes per user and book, through `GET` and `POST /api/books/{id}/notes` and `PUT` and `DELETE /api/books/{id}/notes/{noteId}`. Every endpoint requires current book visibility and uses the authenticated user's identity. Reviews and notes are independent of status, so clearing a status keeps them.

## Goodreads import

The import in `internal/goodreads` reads a Goodreads library export (CSV). It has three endpoints:

- `POST /api/import/goodreads/preview` parses the file and matches each row against the books that the user can see. Matching uses a recorded `goodreads` identifier first, then the ISBN (an ISBN-10 is compared in its ISBN-13 form), then the fuzzy title and author score from duplicate detection. A score of at least 0.95 is a match, a score of at least 0.82 asks the user to confirm, and lower candidates are offered but not chosen. The response includes the user's existing status, rating, and review for every candidate. It writes nothing.
- `POST /api/import/goodreads/books` creates up to 50 catalog entries per request in the library. It requires the Editor or Admin role and returns 403 for Readers. Each entry carries `isbn13`, `isbn10`, and `goodreads` identifiers. With `enrich`, the default metadata provider supplies the description, cover, and other missing fields when its top result matches the title and author. A row whose Goodreads ID already exists on a visible book reuses that book.
- `POST /api/import/goodreads/apply` writes statuses, ratings, reviews, and notes in one transaction through `books.ApplyImportedReading`. Then, for Editors and Admins only, it records Goodreads IDs on matched visible books, and it adds books to personal shelves.

`ApplyImportedReading` differs from the status transition service:

- It never fills a missing date with today's date. Goodreads exports no start dates, so an existing start date is kept only when it is not after the imported finish or DNF date.
- An existing value that differs from the imported one is kept unless the item sets `overwrite`. A missing value is always filled in. Finish and DNF dates are compared by calendar day.
- A finished status with a date creates or updates the `status-finished` progress log, like a manual status change.
- Newly queued To be read books are ranked after the existing visible queue. They are ordered by Goodreads queue position, then by the Goodreads date added, then by export order. A book that stays To be read keeps its rank.
- A note is skipped when the book already has a note with identical text.

## Cover context menu

Book grid and list covers offer **Reading status** with **To be read**, **Reading**, **Finished**, **DNF**, and **No status**. The dashboard Continue reading covers offer the same menu. Choices apply to the signed-in user, including on reference-only books.

Opening the menu fetches the current status. Saving uses the single-book status endpoint and the transition rules above. The menu marks the current choice, disables actions while saving, and retains errors for retry. A successful save updates the loaded book and its badge in place. A book that no longer matches a status filter is removed locally. Loaded pages, pagination cursors, and scroll position remain intact. Dashboard counts and the selected shelf update locally. Bulk selection mode keeps its existing separate status action.

## Progress logging

Progress logs live in `user_book_progress_log` to support charting and history.

- Manual entries accept percent or page number.
- Page-number logging requires `books.pages` to be set so percent can be computed.
- Reader sync is per book and off by default; when enabled it appends
  `source=reader` logs.

## Date fields

The Started, Finished, and DNF fields on the book details page use `UiDateInput` (`app/components/ui/UiDateInput.vue`). Browsers report a partly typed date as soon as it is valid; for example, typing the first digit of a year gives year 0002. So the field keeps its own draft while it has focus. It saves on blur, on Enter, or after a short pause once the date is complete (a four-digit year of at least 1000), which also covers dates chosen from the calendar. An incomplete date reverts on blur. The field stays enabled while a save runs, and a saved value does not replace a draft that the reader is still editing. Each field has a clear button. The Books page date filters use the same field.

## UI/UX entry points

- Book detail page: edit status and dates, log manual progress, toggle sync.
- To be read page: reorder with mouse/touch handles or row arrows, and edit private rationale inline.

## Implementation references

- Schema: [`.drizzle/migrations`](../../../.drizzle/migrations)
- Status, reading position, progress logs, and progress sync APIs: [`internal/books/reading_state.go`](../../../internal/books/reading_state.go)
- Reviews and notes APIs: [`internal/books/reviews.go`](../../../internal/books/reviews.go)
- Finish summary API: [`internal/books/finish_summary.go`](../../../internal/books/finish_summary.go)
- Book detail UI: [`app/pages/books/[id]/index.vue`](../../../app/pages/books/[id]/index.vue)
- Reader sync: [`app/pages/books/[id]/read.vue`](../../../app/pages/books/[id]/read.vue)

## Finish summary

`GET /api/books/{id}/finish-summary` returns the reader's finish stats and a daily progress series without the 50- or 200-entry limits above. Share cards draw from it. See the [share cards reference](share-cards.md#finish-summary-endpoint) for its fields and rules.

## Displayed progress

The book details Progress section shows the latest saved reader percentage or progress log and up to 50 recent history entries. The dashboard Continue reading section uses the same latest-progress rule. A log dated on an earlier day stays in history instead of replacing more recent progress; a date-only manual entry for the current day is ordered by when it was saved. Progress history and reader positions remain private to each user. Showing progress does not move the reader position.
