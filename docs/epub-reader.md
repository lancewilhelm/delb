# EPUB Reader

This document covers the initial EPUB reader implementation and how reading position is stored.

## Overview

The EPUB reader is a full-screen experience powered by `epubjs`. It is accessible from the book detail page when an EPUB file is available.

Key features:
- Full-screen reader layout
- Previous/Next navigation
- Keyboard navigation (Left/Right arrows)
- Escape key to return to book details
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

## File References

- Schema: `app/utils/db/schema.ts`
- Reader UI: `app/pages/books/[id]/read.vue`
- Book detail "Read" action: `app/pages/books/[id]/index.vue`
- API: `server/api/books/[id]/reading-position.get.ts`, `server/api/books/[id]/reading-position.put.ts`

## Future Enhancements

Potential upgrades:
- Persisting position on `beforeunload`
- TOC navigation
- Font size / theme controls
- Highlights, notes, and bookmarks
