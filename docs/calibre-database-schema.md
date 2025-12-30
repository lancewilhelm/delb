# Calibre database schema reference (SQLite)

This document captures a **reference** view of the SQLite schemas Calibre uses, primarily to inform Delb’s future import/migration planning.

Sources:
- The schema listing in this doc is based on an extracted summary (provided in the project discussion) from Calibre’s repository code and SQL resources.
- Calibre upstream code search: https://github.com/kovidgoyal/calibre/search?q=CREATE+TABLE&type=code

## Important notes / caveats

- **This may be incomplete.** Calibre evolves schemas over time and applies upgrades based on `PRAGMA user_version`.
- Many elements are **implementation-dependent** (views, triggers, indexes, tokenizers, custom functions).
- Calibre supports **dynamic custom columns**, which can cause additional tables/triggers to exist beyond the “core” tables listed below.
- Calibre may **clone/backup** databases or create temporary databases for various operations; those generally reuse the same schema patterns.
- **Delb MVP upload limitation (known):** uploading the same book more than once (same author + title) does not currently deconflict. The upload will overwrite the stored file on disk (since the storage path is deterministic) and insert another row in the database. A future improvement is to add a deconfliction flow (prompt user: replace, keep both, cancel) and/or enforce a uniqueness constraint.

---

## 1) `metadata.db` — core library database

This is the main library database in a Calibre library folder. It stores books, authors, tags, series, formats, covers, identifiers, etc.

### Core entity tables

#### `books`
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `title` TEXT NOT NULL DEFAULT 'Unknown' COLLATE NOCASE
- `sort` TEXT COLLATE NOCASE
- `timestamp` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
- `uri` TEXT
- `series_index` INTEGER NOT NULL DEFAULT 1
- `author_sort` TEXT COLLATE NOCASE *(added later via upgrades)*
- `isbn` TEXT DEFAULT "" COLLATE NOCASE *(added later via upgrades)*
- Other columns may be added by later upgrades (example: `last_modified`) depending on Calibre version.

#### `authors`
- `id` INTEGER PRIMARY KEY
- `name` TEXT NOT NULL COLLATE NOCASE
- `sort` TEXT COLLATE NOCASE
- UNIQUE(`name`)

#### `publishers`
- `id` INTEGER PRIMARY KEY
- `name` TEXT NOT NULL COLLATE NOCASE
- `sort` TEXT COLLATE NOCASE
- UNIQUE(`name`)

#### `tags`
- `id` INTEGER PRIMARY KEY
- `name` TEXT NOT NULL COLLATE NOCASE
- UNIQUE(`name`)

#### `series`
- `id` INTEGER PRIMARY KEY
- `name` TEXT NOT NULL COLLATE NOCASE
- `sort` TEXT COLLATE NOCASE
- UNIQUE(`name`)

#### `ratings`
- `id` INTEGER PRIMARY KEY
- `rating` INTEGER CHECK(`rating` > -1 AND `rating` < 11)
- UNIQUE(`rating`)
- Typically pre-populated with values 0..10.

---

### Link tables (many-to-many and one-to-many modeling)

#### `books_authors_link`
- `id` INTEGER PRIMARY KEY
- `book` INTEGER NOT NULL
- `author` INTEGER NOT NULL
- UNIQUE(`book`, `author`)
- Indexes typically exist on `book` and `author`.

#### `books_publishers_link`
- `id` INTEGER PRIMARY KEY
- `book` INTEGER NOT NULL
- `publisher` INTEGER NOT NULL
- UNIQUE(`book`)
  - Note: this design implies **one publisher per book** at the link level.
- Indexes typically exist on `book` and `publisher`.

#### `books_tags_link`
- `id` INTEGER PRIMARY KEY
- `book` INTEGER NOT NULL
- `tag` INTEGER NOT NULL
- UNIQUE(`book`, `tag`)
- Indexes typically exist on `book` and `tag`.

#### `books_series_link`
- `id` INTEGER PRIMARY KEY
- `book` INTEGER NOT NULL
- `series` INTEGER NOT NULL
- UNIQUE(`book`)
- Indexes typically exist on `book` and `series`.

#### `books_ratings_link`
- `id` INTEGER PRIMARY KEY
- `book` INTEGER NOT NULL
- `rating` INTEGER NOT NULL
- UNIQUE(`book`, `rating`)
- Indexes typically exist on `book` and `rating`.

---

### Content storage / per-book resources

#### `data` (per-book formats)
Stores the actual format payloads (depending on how Calibre is configured/used).

- `id` INTEGER PRIMARY KEY
- `book` INTEGER NOT NULL
- `format` TEXT NOT NULL COLLATE NOCASE
- `uncompressed_size` INTEGER NOT NULL
- `data` BLOB NOT NULL
- UNIQUE(`book`, `format`)
- Index typically exists on `book`.

#### `covers`
- `id` INTEGER PRIMARY KEY
- `book` INTEGER NOT NULL
- `uncompressed_size` INTEGER NOT NULL
- `data` BLOB NOT NULL
- UNIQUE(`book`)
- Index typically exists on `book`.

#### `comments`
- `id` INTEGER PRIMARY KEY
- `book` INTEGER NOT NULL
- `text` TEXT NOT NULL COLLATE NOCASE
- UNIQUE(`book`)
- Index typically exists on `book`.

#### `conversion_options`
- `id` INTEGER PRIMARY KEY
- `format` TEXT NOT NULL COLLATE NOCASE
- `book` INTEGER
- `data` BLOB NOT NULL
- UNIQUE(`format`, `book`)
- Indexes typically exist on `format` and `book`.

#### `feeds`
- `id` INTEGER PRIMARY KEY
- `title` TEXT NOT NULL
- `script` TEXT NOT NULL
- UNIQUE(`title`)

---

### Custom columns (dynamic schema)

Calibre’s “custom columns” can be created by users at runtime. The schema is **not fixed**.

A common normalized pattern (conceptual) for a custom column is:
- A master values table:
  - `id`, `value` (and optional extra columns for series-like data)
  - UNIQUE(`value`)
- A link table:
  - `id`, `book` INTEGER NOT NULL, `value` INTEGER NOT NULL
  - optional extra column (e.g. `extra` REAL)
  - UNIQUE(`book`, `value`)
- Plus indexes and triggers.
- Denormalized patterns also exist depending on custom column type/config.

For import planning in Delb: expect that a Calibre `metadata.db` may contain *many extra tables* related to custom columns.

---

### Support / plugin tables (examples)

#### `books_plugin_data`
- `id` INTEGER PRIMARY KEY
- `book` INTEGER NOT NULL
- `name` TEXT NOT NULL
- `val` TEXT NOT NULL
- UNIQUE(`book`, `name`)

#### `metadata_dirtied`
- `id` INTEGER PRIMARY KEY
- `book` INTEGER NOT NULL
- UNIQUE(`book`)

---

### Schema-upgrade-added tables (examples)

#### `library_id`
- `id` INTEGER PRIMARY KEY
- `uuid` TEXT NOT NULL
- UNIQUE(`uuid`)

#### `identifiers`
- `id` INTEGER PRIMARY KEY
- `book` INTEGER NOT NULL
- `type` TEXT NOT NULL DEFAULT "isbn" COLLATE NOCASE
- `val` TEXT NOT NULL COLLATE NOCASE
- UNIQUE(`book`, `type`)

#### `languages`
- `id` INTEGER PRIMARY KEY
- `lang_code` TEXT NOT NULL COLLATE NOCASE
- UNIQUE(`lang_code`)

#### `books_languages_link`
- `id` INTEGER PRIMARY KEY
- `book` INTEGER NOT NULL
- `language` INTEGER NOT NULL
- Likely UNIQUE(`book`, `language`) plus indexes (exact definitions depend on upgrade scripts).

---

### Views

#### `meta` (view)
Calibre commonly provides a `meta` view that aggregates `books` plus related data (authors, tags, series, formats, comments, rating, publisher, isbn, etc.). The exact columns can vary across versions, but commonly include:

- `id`, `title`, `authors`, `publisher`, `rating`, `timestamp`, `size`, `tags`,
  `comments`, `series`, `series_index`, `sort`, `author_sort`, `formats`, `isbn`

---

## 2) Full-text search DB (`full-text-search.db` / attached as `fts_db`)

Calibre maintains a separate database for full-text search indexing of book text.

### Tables

#### `fts_db.dirtied_formats`
- `id` INTEGER PRIMARY KEY
- `book` INTEGER NOT NULL
- `format` TEXT NOT NULL COLLATE NOCASE
- `in_progress` INTEGER NOT NULL DEFAULT FALSE
- UNIQUE(`book`, `format`)

#### `fts_db.books_text`
- `id` INTEGER PRIMARY KEY
- `book` INTEGER NOT NULL
- `timestamp` REAL NOT NULL
- `format` TEXT NOT NULL COLLATE NOCASE
- `format_hash` TEXT NOT NULL COLLATE NOCASE
- `format_size` INTEGER NOT NULL DEFAULT 0
- `searchable_text` TEXT NOT NULL DEFAULT ''
- `text_size` INTEGER NOT NULL DEFAULT 0
- `text_hash` TEXT NOT NULL COLLATE NOCASE DEFAULT ''
- `err_msg` TEXT DEFAULT ''
- UNIQUE(`book`, `format`)

### FTS virtual tables (FTS5)

- `fts_db.books_fts` USING `fts5(...)`
  - Uses `content='books_text'` and `content_rowid='id'`
  - Tokenizer: `calibre remove_diacritics 2` (custom tokenizer behavior)

- `fts_db.books_fts_stemmed` USING `fts5(...)`
  - Tokenizer: `porter calibre remove_diacritics 2`

Triggers are used to keep `books_fts*` in sync with `books_text`.

---

## 3) Notes DB (`notes.db` / `notes_db`)

Calibre uses a separate notes database with optional full-text search.

### Tables

#### `notes_db.notes`
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `item` INTEGER NOT NULL
- `colname` TEXT NOT NULL COLLATE NOCASE
- `doc` TEXT NOT NULL DEFAULT ''
- `searchable_text` TEXT NOT NULL DEFAULT ''
- `ctime` REAL DEFAULT (unixepoch('subsec'))
- `mtime` REAL DEFAULT (unixepoch('subsec'))
- UNIQUE(`item`, `colname`)

#### `notes_db.resources`
- `hash` TEXT NOT NULL PRIMARY KEY ON CONFLICT FAIL
- `name` TEXT NOT NULL UNIQUE ON CONFLICT FAIL
- Declared `WITHOUT ROWID`

#### `notes_db.notes_resources_link`
- `id` INTEGER PRIMARY KEY
- `note` INTEGER NOT NULL
- `resource` TEXT NOT NULL
- FOREIGN KEY(`note`) REFERENCES `notes`(`id`)
- FOREIGN KEY(`resource`) REFERENCES `resources`(`hash`)
- UNIQUE(`note`, `resource`)

### Notes FTS (FTS5)

- `notes_db.notes_fts` USING `fts5(...)`
- `notes_db.notes_fts_stemmed` USING `fts5(...)`

Triggers maintain the FTS indexes and resource link integrity.

---

## 4) Server / small caches and other SQLite files

These databases support Calibre’s server features, caches, and state tracking.

### `server-users.sqlite` (Calibre server user DB)

#### `users`
- `id` INTEGER PRIMARY KEY
- `name` TEXT NOT NULL
- `pw` TEXT NOT NULL
  - Note: Calibre stores an unhashed password for digest auth (as documented in its code).
- `timestamp` TEXT DEFAULT CURRENT_TIMESTAMP
- `session_data` TEXT NOT NULL DEFAULT "{}"
- `restriction` TEXT NOT NULL DEFAULT "{}"
- `readonly` TEXT NOT NULL DEFAULT "n"
- `misc_data` TEXT NOT NULL DEFAULT "{}"
- UNIQUE(`name`)

### `srv-last-read.sqlite` (last read positions)

#### `last_read_positions`
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `library_id` TEXT NOT NULL
- `book` INTEGER NOT NULL
- `format` TEXT NOT NULL COLLATE NOCASE
- `user` TEXT NOT NULL
- `cfi` TEXT NOT NULL
- `epoch` INTEGER NOT NULL
- `pos_frac` REAL NOT NULL DEFAULT 0
- `tooltip` TEXT NOT NULL
- UNIQUE(`user`, `library_id`, `book`, `format`)
- Index on `user`

### `live.sqlite` (live modules cache)

#### `modules`
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `date` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
- `atime` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
- `full_name` TEXT NOT NULL UNIQUE
- `etag` TEXT NOT NULL
- `module_version` INTEGER NOT NULL DEFAULT 1
- `minimum_calibre_version` TEXT NOT NULL DEFAULT "0,0,0"
- `data` BLOB NOT NULL

---

## 5) Device DBs & external DBs

Calibre can read device-specific SQLite databases (e.g. Kobo). These are created/owned by the device ecosystem, not by Calibre itself, and therefore are not documented here as “Calibre schema”.

---

## 6) SQLite extensions and behavior that affect schema semantics

Some Calibre database behavior depends on SQLite extensions:
- Custom aggregates/functions (e.g. concatenation helpers) via a native module (C).
- A custom FTS5 tokenizer used by the FTS databases.
- Extension module registration and build metadata are defined in Calibre upstream.

For Delb import planning, this matters because:
- Import may need to replicate **derived fields** (e.g. `sortconcat`-like behavior) in application logic rather than relying on SQLite extensions.
- Full-text search ingestion may require re-indexing rather than attempting to import FTS tables directly.

---

## Suggested next steps for Delb (import-oriented)

When you’re ready to implement import:
1. Decide whether Delb will import:
   - only `metadata.db` core tables, or
   - also notes and last-read positions, or
   - also reconstruct FTS indexes.
2. Handle schema variance by reading:
   - `PRAGMA user_version`
   - `PRAGMA table_info(<table>)`
   - presence/absence of upgrade-added tables (`identifiers`, `languages`, etc.)
3. Treat Calibre custom columns as a first-class discovery process:
   - enumerate tables and match Calibre’s custom-column patterns, rather than hardcoding table names.

(Implementation intentionally deferred; this doc is reference-only.)