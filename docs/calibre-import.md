# Calibre Import (Migration)

This document describes how Delb imports an existing **Calibre** library by **copying** files into Delb’s own `library/` structure.

> Goal: a **one-way migration** where Delb becomes the source of truth. Calibre remains read-only input.

## How Delb reads `metadata.db`

Delb reads Calibre’s `calibre/metadata.db` using the `@libsql/client` SQLite driver (local `file:` URL). This avoids relying on native Node addons for reading the Calibre database, which improves portability in Docker deployments.

---

## Summary

- Delb imports a Calibre library by **copying** files into its own `library/` structure.
- Calibre must be mounted to Delb’s `calibre/` folder and must include:
  - `calibre/metadata.db`
  - The Calibre book directories/files underneath `calibre/`
- Delb writes its own database to:
  - `data/delb.db`
- After migration, Delb manages files in `library/` and is **not** kept in sync with Calibre.
- If you keep Calibre around, treat it as **read-only** archive input.

---

## Requirements / Expectations

### 1) Library layout

Delb expects your **Calibre** library root to be mounted at:

- `calibre/`

And to contain the Calibre DB at:

- `calibre/metadata.db`

Calibre book directories typically look like:

- `calibre/<Author>/<Title> (<id>)/...`

And often contain:

- one or more ebook format files (e.g. `.epub`, `.pdf`, `.mobi`, `.azw3`)
- `metadata.opf` (sidecar metadata)
- `cover.jpg` / `cover.jpeg` / `cover.png`

### 1a) Delb library layout

Delb writes migrated books into its own storage root:

- `library/`

Example Delb storage (canonical):

- `library/<Author>/<Title> (<id8>)/...`

### 2) Delb database location

Delb uses its own SQLite DB:

- `data/delb.db`

The Calibre import populates/updates Delb’s tables and does **not** change Calibre’s `metadata.db`.

---

## How the import works

### Entry point (Admin UI)

The import is triggered from the Admin settings page:

- **Settings → Admin → Library**

You’ll see controls for:

- **Import from Calibre**
- Optional **Dry run** (preview only)

#### Import (`action: "import"`)

- One-time import of Calibre metadata and **file copies** into Delb’s `library/`
- Requires selecting at least one target collection
- Adds imported books to the selected collection(s)
- Safe to run again if you need to reimport from the same Calibre library (idempotent via `calibre_book_id`)

---

## What metadata is imported

Delb imports the common Calibre entities:

- **Books**
  - title
  - description/comments (when available)
  - language (best-effort; Calibre schema differs across versions)
  - published/timestamp (stored as a raw string in Delb v1)
  - series + series index (when available)
  - publisher (when available)
- **Authors**
  - name
  - sort name (best-effort / Calibre-style sort)
  - ordering: stored as `book_authors.position`
- **Tags**
- **Identifiers**
  - examples: `isbn`, `google`, `amazon`, etc.
  - Delb stores these in `book_identifiers`

Calibre supports many additional fields and “custom columns”; those are not guaranteed to import in the current implementation.

---

## Files and formats (migration)

Delb **copies** supported format files from Calibre into its own `library/` folder.

Delb records each discovered format as a row in `book_files`:

- `book_files.format` (lowercased extension, e.g. `epub`, `pdf`)
- `book_files.relative_path` (a `library/...` relative path pointing to the **copied** file)

### Supported formats today

Delb currently links/serves formats that the app already supports for download:

- `epub`
- `pdf`
- `mobi`
- `azw3`

### How Delb discovers formats

Calibre’s format/file schema varies by version. Delb uses a “best effort” approach:

1. Try to locate format info via Calibre DB tables (when present)
2. If DB discovery is incomplete, Delb falls back to scanning the on-disk Calibre book directory for supported files

This is intentional: the filesystem is the most reliable source of “what is actually present”.

---

## Covers

Delb uses a **two-file cover model**:

- **Thumbnail (default/UI):** `thumb.webp` (320px wide)
- **Source (full resolution):** a copied source cover (typically `cover.jpg` / `cover.png`)

### What gets stored during Calibre import

When a Calibre cover exists, Delb will:

1. Copy the source cover into Delb’s book folder (full resolution), e.g.
   - `cover.jpg`
   - `cover.jpeg`
   - `cover.png`

2. Generate a lightweight thumbnail alongside it:
   - `thumb.webp` (320px wide)

Delb sets `books.cover_image_path` to point to the thumbnail:

- `library/<author>/<title (id8)>/thumb.webp`

### How the UI serves covers

- Most pages (thumbnails, lists, grids) use the path in `books.cover_image_path` (the `thumb.webp`).
- When a user clicks the cover on the book detail page, the UI requests the **source** cover on demand (the true original, not resized).

### Notes and caveats

- Delb does **not** modify Calibre files during migration.
- Thumbnails are generated only when missing (so repeat imports stay fast).
- If cover generation fails for a given book (corrupt/unsupported cover), Delb will continue without a cover for that book.

---

## Idempotency and `calibre_book_id`

To avoid duplicate imports and enable repeatable imports, Delb stores Calibre’s per-book ID:

- Delb: `books.calibre_book_id`
- Calibre: `metadata.db` table `books.id`

This enables Delb to update the existing Delb book record even if the title/authors/folder names change.

### Uniqueness

Delb enforces uniqueness so that a single Calibre book maps to a single Delb book:

- `books.calibre_book_id` has a unique index (nullable; non-Calibre books can still exist)

---

## Caveats / Risks / “Can I go back to Calibre?”

- Calibre’s `calibre/metadata.db` and file layout remain unchanged.
- Delb’s edits **do not** flow back to Calibre after migration.
- If you want a path back to Calibre, keep the original Calibre library as a read-only archive.

### Backup guidance

Even with migration, it’s wise to keep backups of:

- `calibre/` (Calibre library folder, including `metadata.db`)
- `library/` (Delb-managed library)
- `data/` (Delb database)

If you plan to experiment with file moves/renames under `library/`, you should duplicate the Delb library first.

---

## Troubleshooting

### Import fails due to schema differences

Calibre schema varies significantly by version. If an import fails with a SQLite error referencing a missing table/column, it usually means:

- your `metadata.db` uses a different column name than expected
- your Calibre version omits that feature entirely

Delb’s importer is designed to skip optional features when possible, but some schema mismatches may require additional detection logic.

### Import completes but missing files appear in Delb

Common causes:

- Calibre’s `metadata.db` references paths that do not exist on disk
- Formats exist but are not in the supported formats list (`epub|pdf|mobi|azw3`)
- Files are present but not discoverable due to an uncommon Calibre layout

Try:

- Run the import again (it is idempotent)
- Verify the file exists under `calibre/` (source) and `library/` (Delb copy)
- Confirm the file extension is supported

---

## Operational notes (Docker)

Typical deployment expectation:

- mount Calibre library into the container at `/app/calibre` (read-only input)
- mount Delb library into the container at `/app/library` (writable)
- mount Delb data volume for `/app/data`

Delb reads from `calibre/metadata.db` and writes to `data/delb.db`.

---
