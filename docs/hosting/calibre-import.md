# Calibre import

Delb can perform a one-way migration from an existing Calibre library by reading `calibre/metadata.db` and copying supported book files and covers into Delb's managed `library/` directory. After import, Delb manages its own database (`data/delb.db`) and files in `library/`, and changes in Delb do not write back to Calibre. Keep your original Calibre library mounted read-only as an archive if you want a path back to Calibre.

## How Delb reads Calibre

Delb reads `calibre/metadata.db` with its pure-Go SQLite driver (`modernc.org/sqlite`), so no CGO or external native packages are required. It never modifies `calibre/metadata.db` or any files under `calibre/`.

## Directory layout

Mount or place the directories as follows:

- `calibre/` (read-only in Docker at `/app/calibre`): Your Calibre library root containing `metadata.db` and Calibre's `<Author>/<Title> (<id>)/` book folders.
- `library/` (writable in Docker at `/app/library`): Delb's managed storage root, where imported books are copied into `library/<Author>/<Title> (<id8>)/`.
- `data/` (writable in Docker at `/app/data`): Delb's SQLite database (`data/delb.db`).

## Run the import

1. Open **Settings → Admin → Library**.
2. Optionally select **Dry run** to preview the import without writing to the database or copying files.
3. Select **Import From Calibre**.

The import adds new entries to the shared library and updates existing Calibre-linked entries in place. You can run it again safely against the same Calibre library because Delb links each entry by Calibre's book ID.

## What Delb imports

### Metadata

Delb imports common Calibre fields:

- **Books:** title, description (from comments), language (best-effort across Calibre schema versions), publication date and timestamp, series name and index, and publisher.
- **Authors:** name, sort name, and author order (`book_authors.position`).
- **Tags:** shared catalog tags.
- **Identifiers:** stored in `book_identifiers` (such as `isbn`, `google`, and `amazon`).

Calibre custom columns and plugin-specific tables are not guaranteed to import. See [Calibre's schema reference](../developing/reference/calibre-schema.md) for table details.

### Book files and formats

Delb copies supported format files into `library/` and records each file in `book_files` with its lowercased format and relative `library/...` path. Supported formats are:

- `epub`
- `pdf`
- `mobi`
- `azw3`

Because Calibre's file schema varies across versions, Delb first checks Calibre's database tables for format records and falls back to scanning the on-disk Calibre book directory for supported extensions.

### Covers

Delb uses a two-file cover model:

- **Source cover:** The original Calibre cover (`cover.jpg`, `cover.jpeg`, or `cover.png`) copied into the Delb book folder at full resolution.
- **Thumbnail:** A 320px-wide `thumb.webp` generated alongside the source cover.

Delb points `books.cover_image_path` to `thumb.webp`. Lists and grids request the thumbnail, and opening the cover on the book detail page loads the full-resolution source cover on demand. Thumbnails are generated only when missing so repeat imports stay fast. If a cover image is corrupt or unsupported, Delb skips the cover and continues importing the book.

## Idempotency and backups

Delb stores Calibre's `books.id` in `books.calibre_book_id` with a unique index. Re-running the import updates the matching Delb record even if titles, authors, or folder names changed.

Keep backups of `calibre/`, `library/`, and `data/` before running large imports or reorganizations.

## Troubleshooting

### Schema mismatch errors

Calibre schemas vary across versions. If an import fails with a SQLite error referencing a missing table or column, your `metadata.db` likely omits an optional table or uses an older column layout that the importer does not yet handle.

### Missing book files after import

If a book imports without its file, check the following:

- Confirm that the file exists under `calibre/` and that `metadata.db` points to the actual path.
- Confirm that the file extension is one of `epub`, `pdf`, `mobi`, or `azw3`.
- Re-run the import after fixing the source files or mount permissions.

Each Calibre book stays linked to one Delb entry. For pre-1.0 preview installations that previously copied books between collections, copied entries are unlinked from Calibre and skipped by rescans; see [Upgrade to a single library](single-library-upgrade.md).
