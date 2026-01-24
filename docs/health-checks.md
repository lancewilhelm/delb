# Health Checks (Library + Database)

This document defines the **minimal, high-signal health checks** Delb should provide to prevent user-facing breakage and avoid **orphaned books** in the database.

Scope notes:

- Delb supports **file-backed books** _and_ **reference-only books** (metadata in DB with **no associated file**). Do not treat “missing book file” as an error unless the DB claims a file exists.
- Metadata parsing/validation is intentionally out of scope for the initial checks.

## Where these checks run

- Admin UI: `Settings → Admin → Library → Health` (on-demand)
- Post-ingest verification: run a small subset immediately after an upload/import completes

Each check should return:

- `status`: `ok | warn | error`
- `message`: human readable summary
- `sampleIds`: optional list of affected IDs (bounded)
- `howToFix`: short remediation guidance

## Minimal checks (v1)

### 1) Orphaned books (not in any collection)

**Why it matters:** Orphaned books often cannot be found/browsed and feel “lost” to users.

**Definition:** A book is “orphaned” if it has **no rows** in `collection_books`.

**Query shape:**

```sql
select b.id, b.title
from books b
left join collection_books cb on cb.book_id = b.id
where cb.book_id is null;
```

**Severity:** `warn` (upgrade to `error` later if ingest always assigns a collection)

**How to fix:** Add the book to at least one collection (typically the uploader’s Personal collection) or delete the orphan row.

### 2) Empty titles

**Why it matters:** Empty titles break list/detail UI and search relevance.

`books.title` is `NOT NULL`, but it can still be `''` if bad data slips in.

**Query shape:**

```sql
select id
from books
where trim(title) = '';
```

**Severity:** `error`

**How to fix:** Edit the book title or delete the record.

### 3) Duplicate identifiers (cross-book)

**Why it matters:** Duplicated identifiers are a strong signal of duplicates and can confuse dedupe and metadata operations.

**Definition:** two or more different books share the same `(type, value)` in `book_identifiers`.

**Query shape:**

```sql
select type, value, count(distinct book_id) as book_count
from book_identifiers
group by type, value
having book_count > 1;
```

**Severity:** `warn`

**How to fix:** Decide whether the records are duplicates; keep both if intentional, otherwise merge/delete one and fix the identifiers.

### 4) Book file pointers that don’t exist on disk (deep)

**Why it matters:** A user clicking “download/read” will fail if a `book_files.relative_path` is missing.

**Definition:** any row in `book_files` whose resolved file path does not exist.

**DB query (to enumerate candidates):**

```sql
select id, book_id, format, relative_path
from book_files;
```

**Filesystem rule:** resolve `relative_path` under the configured library root and `stat()` the file.

**Severity:** `error`

**How to fix:** Restore the file, update the pointer, or delete the `book_files` row (and possibly the book if it is meant to be file-backed).

### 5) Cover/thumbnail invariants (deep)

Delb stores a lightweight thumbnail alongside each book folder:

- Full-size cover (optional): `cover.webp`
- Thumbnail (optional, but preferred): `thumb.webp`

Delb typically stores `books.cover_image_path` pointing at the **thumbnail** (e.g. `library/.../thumb.webp`) for fast list/grid rendering.

**Minimal invariant:** If a cover exists, a thumbnail should exist.

**Checks:**

1. `books.cover_image_path` is set but the referenced file does not exist on disk.
   - **Severity:** `warn` (or `error` if UI relies on it everywhere)
2. `cover.webp` exists in a book directory but `thumb.webp` does not.
   - **Severity:** `warn`

**How to fix:** Regenerate `thumb.webp` (future action), or clear `cover_image_path` if no cover should be shown.

## Post-ingest verification (minimal)

Immediately after ingest completes (upload, Dropbox ingest, Calibre import), verify:

- The new `books.id` is present in at least one collection via `collection_books` (or warn if the ingest flow defers collection assignment).
- Every created `book_files` row points to an existing file on disk.
- If a cover/thumbnail was created or updated, ensure the thumbnail file exists.

## Ingest-time duplicate detection (minimal)

On upload/import, detect possible duplicates and ask the user what to do.

Inputs:

- Strong match: exact `(type, value)` matches in `book_identifiers`
- Weak match: fuzzy match on `books.title` + primary author name(s) (app-level logic)

Output:

- Provide a small ranked list of candidate books (IDs + title + authors + identifiers present).
- Prompt user decision: cancel, continue as new, or (later) merge/replace.

## Future actions (not required for v1 checks)

These are remediation actions that pair naturally with the checks above and likely belong on the book edit page:

- **Regenerate thumbnail**: create `thumb.webp` from the best available source (existing `cover.webp`, embedded EPUB cover, or remote metadata cover).
- **Extract cover from EPUB**: derive `cover.webp` (and `thumb.webp`) from a selected EPUB file in `book_files`.
