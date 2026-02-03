# EPUB Reader

This document covers the initial EPUB reader implementation and how reading position is stored.

## Overview

The EPUB reader is a full-screen experience powered by `epubjs`. It is accessible from the book detail page when an EPUB file is available.

Key features:

- Full-screen reader layout
- Previous/Next navigation
- Keyboard navigation (Left/Right arrows)
- Escape key to return to book details
- Table of contents sidebar (EPUB navigation)
- Reading position stored per user in the database

## Reader Route

The reader lives at:

- `app/pages/books/[id]/read.vue`

This page:

- Loads the EPUB from the download endpoint using `format=epub` (and `fileId` when available)
- Restores the last saved reading position (if any)
- Saves position automatically when the reader relocates

## Read Button Visibility

The **Read** button appears on a book detail page only if the book has an EPUB file:

- Source: `app/pages/books/[id]/index.vue`
- Logic: looks for `book.files` with `format === 'epub'`

## Reading Position Storage

Reading position is stored per user and per book.

### Table: `user_book_reading_position`

Fields:

- `userId` (string, required)
- `bookId` (string, required)
- `location` (string, required)
- `progress` (number, optional)
- `updatedAt` (timestamp)

Notes:

- `location` stores the EPUB.js CFI (or other serialized location)
- `progress` is a percentage (0..100) when available

### Table: `user_book_progress_log`

Progress logs are stored separately so manual updates or reader updates can be charted over time.

Fields:

- `id` (string, required)
- `userId` (string, required)
- `bookId` (string, required)
- `progressPercent` (number, required)
- `pageNumber` (number, optional)
- `location` (string, optional)
- `source` (string, required: `reader`, `manual`, or `status-finished`)
- `occurredAt` (timestamp)
- `createdAt` (timestamp)

Notes:

- When progress sync is enabled, reader saves may append `source=reader` logs.
- Finished status writes a `source=status-finished` 100% log.

### Table: `user_book_preferences`

Per-user, per-book settings.

Fields:

- `userId` (string, required)
- `bookId` (string, required)
- `progressSyncEnabled` (boolean, default `false`)
- `updatedAt` (timestamp)

## API Endpoints

### Download book file (used by reader)

`GET /api/books/:id/download`

Query params:

- `format`: when set to `epub`, forces an EPUB response (reader requirement)
- `fileId`: optionally downloads a specific stored file for the book (used to disambiguate when multiple files exist)

### Get reading position

`GET /api/books/:id/reading-position`

Response:

- `{ success: true, data: { location: string | null, progress: number | null } }`

### Update reading position

`PUT /api/books/:id/reading-position`

Request:

- `{ location: string | null, progress?: number | null }`

Behavior:

- If `location` is null/empty, the position is cleared.
- Otherwise, it upserts the record.
- If progress sync is enabled for the book, a progress log may be appended.

### Progress logs

`GET /api/books/:id/progress-logs`

Returns the user's progress log entries for the book.

`POST /api/books/:id/progress-logs`

Adds a manual progress log entry (percent or page number).

### Progress sync toggle

`PUT /api/books/:id/progress-sync`

Enables or disables reader↔log syncing for the current user and book.

## File References

- Schema: `app/utils/db/schema.ts`
- Reader UI: `app/pages/books/[id]/read.vue`
- Book detail "Read" action: `app/pages/books/[id]/index.vue`
- API: `server/api/books/[id]/reading-position.get.ts`, `server/api/books/[id]/reading-position.put.ts`, `server/api/books/[id]/progress-logs.get.ts`, `server/api/books/[id]/progress-logs.post.ts`, `server/api/books/[id]/progress-sync.put.ts`

## Future Enhancements

Potential upgrades:

- Persisting position on `beforeunload`
- Font size / theme controls
- Highlights, notes, and bookmarks
