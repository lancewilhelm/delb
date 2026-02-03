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

## Progress logging

Progress logs live in `user_book_progress_log` to support charting and history.

- Manual entries accept percent or page number.
- Page-number logging requires `books.pages` to be set so percent can be computed.
- Reader sync is per book and off by default; when enabled it appends
  `source=reader` logs.

## UI/UX entry points

- Book detail page: edit status and dates, log manual progress, toggle sync.
- Future list view: may expose columns for quick date edits and TBR ordering.

## Implementation references

- Schema: `app/utils/db/schema.ts`
- Status API: `server/api/books/[id]/status.post.ts`
- Progress logs API: `server/api/books/[id]/progress-logs.get.ts`, `server/api/books/[id]/progress-logs.post.ts`
- Progress sync toggle: `server/api/books/[id]/progress-sync.put.ts`
- Book detail UI: `app/pages/books/[id]/index.vue`
- Reader sync: `app/pages/books/[id]/read.vue`
