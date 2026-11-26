# Calibre database schema reference (SQLite)

This document summarizes the SQLite schemas that Calibre uses, as a reference for Delb's Calibre importer.

Sources:

- Extracted summary from Calibre's repository code and SQL resources.
- Calibre upstream code search: https://github.com/kovidgoyal/calibre/search?q=CREATE+TABLE&type=code

## Calibre to Delb migration (current behavior)

Delb imports an existing Calibre library as a **one-way migration** (see [Calibre import](../../hosting/calibre-import.md) for setup and troubleshooting):

- The Calibre library is mounted at Delb's `calibre/` directory.
- Calibre's database is read from `calibre/metadata.db` using Delb's pure-Go SQLite driver (`modernc.org/sqlite`).
- Delb writes its own data to `data/delb.db`.
- Delb **copies** Calibre files into its own `library/` structure and manages them thereafter.

### Admin controls

The import runs from **Settings → Admin → Library** (`Import From Calibre`), with an optional **Dry run** preview. It performs a safe, repeatable import of metadata and copied book files into Delb's `library/`.

### Idempotency and linking to Calibre book IDs

To prevent duplicate imports, Delb stores Calibre's `books.id` value in `books.calibre_book_id` with a unique index. Delb does not preserve Calibre's library UUID; it uses only the Calibre book ID to make repeat imports idempotent.

### Files and formats

Calibre stores formats inside each book folder (for example `*.epub`, `*.pdf`, `*.mobi`, `*.azw3`), along with sidecar files such as `metadata.opf` and `cover.jpg` or `cover.png`.

Delb records each discovered supported format (`epub`, `pdf`, `mobi`, `azw3`) in `book_files` with a `library/...` relative path pointing to the copied file. Delb checks Calibre's database tables first and falls back to scanning the on-disk Calibre book directory when the database schema omits or varies format filenames.

### Covers

Delb sets `books.cover_image_path` to the generated thumbnail (`thumb.webp`) in the Delb library and copies the source cover (`cover.<ext>`) alongside it.

## Important notes and caveats

- **This reference may be incomplete.** Calibre evolves its schema over time and applies upgrades based on `PRAGMA user_version`.
- Many elements depend on the Calibre version (views, triggers, indexes, tokenizers, and custom functions).
- Calibre supports dynamic custom columns, which create additional tables and triggers beyond the core tables listed below.
- Calibre may clone or back up databases or create temporary databases for internal operations; those generally follow the same schema patterns.

## 1) `metadata.db` core library database

This is the main library database in a Calibre library folder. It stores books, authors, tags, series, formats, covers, identifiers, etc.

### Core entity tables

#### `books`

- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `title` TEXT NOT NULL DEFAULT 'Unknown' COLLATE NOCASE
- `sort` TEXT COLLATE NOCASE
- `timestamp` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
- `uri` TEXT
- `series_index` INTEGER NOT NULL DEFAULT 1
- `author_sort` TEXT COLLATE NOCASE _(added later via upgrades)_
- `isbn` TEXT DEFAULT "" COLLATE NOCASE _(added later via upgrades)_
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

Calibre's custom columns are created by users at runtime, so their schema is not fixed.

A common normalized pattern for a custom column includes:

- A master values table (`id`, `value`, optional extra columns for series-like data, `UNIQUE(value)`).
- A link table (`id`, `book` INTEGER NOT NULL, `value` INTEGER NOT NULL, optional `extra` REAL, `UNIQUE(book, value)`).
- Associated indexes and triggers.
- Denormalized patterns also exist depending on the custom column type and configuration.

Expect a real Calibre `metadata.db` to contain extra tables for custom columns beyond the core tables above.

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

## 4) Server, caches, and other SQLite files

These databases support Calibre's server features, caches, and state tracking.

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

## 5) Device and external databases

Calibre can read device-specific SQLite databases (such as Kobo). Those are owned by the device ecosystem rather than Calibre itself and are outside this reference.

## 6) SQLite extensions and schema semantics

Some Calibre database features depend on native SQLite extensions:

- Custom aggregates and functions (such as `sortconcat`) provided by a C module.
- A custom FTS5 tokenizer used by the full-text search databases.

Because Delb reads `metadata.db` with a pure-Go SQLite driver (`modernc.org/sqlite`) without Calibre's native extensions, [`internal/admin/calibre_reader.go`](../../../internal/admin/calibre_reader.go) queries core tables directly and computes derived values in Go rather than relying on Calibre views, triggers, or FTS tables.
