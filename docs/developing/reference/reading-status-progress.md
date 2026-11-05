# Reading Status & Progress Rules

This document describes how per-user status dates and progress logs work.

## Status metadata

Status metadata lives on `user_book_status` and is user-scoped:

- `status`: `to_be_read | reading | finished | dnf`
- `startedAt`: first read date (historical)
- `finishedAt`: finished date
- `dnfAt`: did-not-finish date
- `tbrRank`: ordering value for `to_be_read`

### Behavior rules

- Setting status to `reading` auto-fills `startedAt` if missing.
- Setting status to `finished` auto-fills `finishedAt` if missing, and sets
  `startedAt` if missing (same date as `finishedAt`).
- Setting status to `dnf` auto-fills `dnfAt` if missing, and sets
  `startedAt` if missing (same date as `dnfAt`).
- Leaving `finished` clears `finishedAt`; leaving `dnf` clears `dnfAt`.
- Switching to `to_be_read` clears `startedAt`, `finishedAt`, and `dnfAt`.
- `startedAt` is kept as historical data when status changes away from reading.
- Manual date edits set status to the matching state:
  - `finishedAt` → status `finished`
  - `dnfAt` → status `dnf`
  - `startedAt` → status `reading` (if current status is `to_be_read`/unset)
- `finishedAt` and `dnfAt` must be on or after `startedAt`.
- DNF does not create a progress log.
- Finished creates a 100% progress log.
- Setting a TBR rank keeps the list contiguous:
  - Moving a book down shifts intermediate ranks up.
  - Moving a book up shifts intermediate ranks down.
  - Removing a ranked TBR book shifts higher ranks down.
  - Ranks are capped to the current TBR list size.
  - The queue spans all accessible collections and deduplicates books.
  - Newly added and re-added books append at the end.
  - Losing all collection access clears the rank and closes gaps. Restored access appends the book if its status is still `to_be_read`.

## TBR rationale and visibility

`user_book_rationale` stores one private plain-text rationale per user and book, independently of `user_book_status`. Clearing status retains the rationale. Reads and writes require current book visibility and use the authenticated user's identity.

The dedicated TBR page loads the full ranked queue. Its inline editor and book details use the same rationale endpoints. The dashboard TBR count is global to the reader, while other counts retain their selected collection scope.

Migration `0006_tbr_queue` normalizes existing accessible ranks and installs access-change triggers on `collection_members` and `collection_books`. These triggers observe loss and restoration in the same transaction as sharing changes, including cascades. A revoke-and-restore cycle therefore appends the book even when no queue request occurs between the two operations. A book remains ranked while any collection still grants access.

The status transition service handles numeric moves and single/bulk status changes transactionally. Access-change triggers use a materialized ranked sequence through SQLite `UPDATE FROM` so rank compaction preserves the existing order.

The four access triggers share the same visibility and rank-order rule. A future migration that rebuilds `collection_members` or `collection_books` must recreate their triggers; SQLite drops triggers attached to a dropped table, and Drizzle's generated table snapshot does not preserve these custom triggers. Exercise membership insert/delete and book-link insert/delete with the production migrations after such a change.

## Cover context menu

Book grid and list covers offer **Reading status** with **To be read**, **Reading**, **Finished**, **DNF**, and **No status**. The dashboard Continue reading covers offer the same menu. Choices apply to the signed-in user, including on reference-only books.

Opening the menu fetches the current status. Saving uses the single-book status endpoint and the transition rules above. The menu marks the current choice, disables actions while saving, and retains errors for retry. A successful save refreshes the enclosing view so status fields, status filters, and dashboard totals reflect the saved value. Bulk selection mode keeps its existing separate status action.

## Progress logging

Progress logs live in `user_book_progress_log` to support charting and history.

- Manual entries accept percent or page number.
- Page-number logging requires `books.pages` to be set so percent can be computed.
- Reader sync is per book and off by default; when enabled it appends
  `source=reader` logs.

## UI/UX entry points

- Book detail page: edit status and dates, log manual progress, toggle sync.
- To be read page: reorder with mouse/touch handles or row arrows, and edit private rationale inline.

## Implementation references

- Schema: `app/utils/db/schema.ts`
- Status API: `server/api/books/[id]/status.post.ts`
- Progress logs API: `server/api/books/[id]/progress-logs.get.ts`, `server/api/books/[id]/progress-logs.post.ts`
- Progress sync toggle: `server/api/books/[id]/progress-sync.put.ts`
- Book detail UI: `app/pages/books/[id]/index.vue`
- Reader sync: `app/pages/books/[id]/read.vue`
