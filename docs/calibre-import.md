# Calibre Import (Import-in-Place)

This document describes how Delb imports an existing **Calibre** library when you mount that Calibre library directly at Delb’s `library/` directory.

> Goal: pull in as much metadata as possible while **not moving or renaming any files** in the Calibre library.

---

## Summary

- Delb can import a Calibre library **in place**.
- Calibre must be mounted/copied to Delb’s `library/` folder and must include:
  - `library/metadata.db`
  - The Calibre book directories/files underneath `library/`
- Delb reads Calibre’s database but writes Delb’s database to:
  - `data/delb.db`
- Delb stores **file pointers** (relative paths under `library/`) and uses those pointers for downloads.

---

## Requirements / Expectations

### 1) Library layout

Delb expects your Calibre library root to be mounted at:

- `library/`

And to contain the Calibre DB at:

- `library/metadata.db`

Calibre book directories typically look like:

- `library/<Author>/<Title> (<id>)/...`

And often contain:

- one or more ebook format files (e.g. `.epub`, `.pdf`, `.mobi`, `.azw3`)
- `metadata.opf` (sidecar metadata)
- `cover.jpg` / `cover.jpeg` / `cover.png`

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
- **Re-scan Calibre**
- Optional **Dry run** (preview only)

### Import vs Re-scan

#### Import (`action: "import"`)
- One-time import of Calibre metadata and file pointers
- Requires selecting at least one target collection
- Adds imported books to the selected collection(s)

#### Re-scan (`action: "rescan"`)
- Refreshes Delb data from the current state of Calibre’s `metadata.db`
- Optionally can “import new books discovered during rescan”

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

## Files and formats (import-in-place)

Delb does **not** copy or move book files during import-in-place.

Instead, Delb records each discovered format as a row in `book_files`:

- `book_files.format` (lowercased extension, e.g. `epub`, `pdf`)
- `book_files.relative_path` (a `library/...` relative path pointing to the existing file)

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

This is intentional: for import-in-place, the filesystem is the most reliable source of “what is actually present”.

---

## Covers

Delb sets `books.cover_image_path` by checking for a cover file inside the Calibre book folder:

- `cover.jpg`
- `cover.jpeg`
- `cover.png`

Delb does **not** convert Calibre covers to `cover.webp` during import-in-place.

---

## Idempotency and `calibre_book_id`

To avoid duplicate imports and enable re-scan updates, Delb stores Calibre’s per-book ID:

- Delb: `books.calibre_book_id`
- Calibre: `metadata.db` table `books.id`

This enables Delb to update the existing Delb book record even if the title/authors/folder names change.

### Uniqueness

Delb enforces uniqueness so that a single Calibre book maps to a single Delb book:

- `books.calibre_book_id` has a unique index (nullable; non-Calibre books can still exist)

---

## Caveats / Risks / “Can I go back to Calibre?”

### Safe scenario (recommended): Delb does not modify Calibre files
If you run import-in-place and then edit metadata in Delb, and Delb is only updating `data/delb.db`:

- Calibre’s `library/metadata.db` and file layout remain unchanged
- You can stop using Delb and open the same library in Calibre without surprises

### Risky scenario: moving/renaming files under `library/`
If Delb (or a user action) moves/renames Calibre’s book directories or files inside `library/` without also updating Calibre’s DB:

- Calibre may show missing books/formats/covers
- Returning to Calibre becomes harder (may require repairing the library or restoring from backup)

**Practical guidance:** treat `library/` as Calibre-owned when using import-in-place.

### Backup guidance
Even with import-in-place, it’s wise to keep backups of:

- `library/` (Calibre library folder, including `metadata.db`)
- `data/` (Delb database)

If you plan to experiment with file moves/renames under `library/`, you should duplicate the Calibre library first.

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
- Re-scan in Delb
- Verify the file exists under `library/` on disk
- Confirm the file extension is supported

---

## Operational notes (Docker)

Typical deployment expectation:

- mount Calibre library into the container at `/app/library` (or wherever Delb expects `library/`)
- mount Delb data volume for `/app/data`

Delb reads from `library/metadata.db` and writes to `data/delb.db`.

---