///Users/lancewilhelm/projects/delb/server/utils/import/calibre/calibre-reader.ts
import path from "node:path";
import { existsSync } from "node:fs";

import Database from "better-sqlite3";
import { logger } from "~/utils/logger";

/**
 * Calibre metadata.db reader (import helper)
 *
 * Assumptions for Delb v1 import-in-place:
 * - Calibre library is mounted at Delb's `library/` folder.
 * - Calibre's `metadata.db` exists at `library/metadata.db`.
 *
 * Design goals:
 * - Be resilient across Calibre versions by:
 *   - Checking for table/column existence before querying
 *   - Avoiding reliance on Calibre custom SQLite functions / FTS
 * - Prefer file-based formats on disk (Calibre's "library folder") rather than BLOB-based tables.
 *
 * Note:
 * - Calibre schemas vary. This reader focuses on common tables described in `docs/calibre-database-schema.md`.
 * - For formats: Calibre versions differ. Some have a `data` table with BLOBs, others store file info in a
 *   formats table (e.g. `books_data_link`), and the canonical on-disk structure is typically:
 *     library/<books.path>/<title> - <authors>.<ext>
 *   Since we are import-in-place and Delb already resolves `library/...` paths safely, we prefer:
 *   - a best-effort query for known "formats link" tables
 *   - a safe fallback to scanning the book directory on disk (optional, controlled by caller)
 */

export type CalibreReaderOptions = {
  /** Absolute path to Calibre library root. Typically `<projectRoot>/library`. */
  libraryRootAbs: string;

  /** Optional override for the metadata db filename (default: metadata.db). */
  metadataDbFilename?: string;

  /** Open the DB read-only by default. */
  readonly?: boolean;
};

export type CalibreBookRow = {
  calibreBookId: number;
  title: string;
  sort?: string | null;
  timestamp?: string | null;
  pubdate?: string | null;
  lastModified?: string | null;

  // Calibre book folder relative path under library root (common in many versions)
  // e.g. "Terry Pratchett/Guards! Guards! (123)"
  path?: string | null;

  seriesIndex?: number | null;

  // We attach these via joins in higher-level getters
};

export type CalibreAuthorRow = {
  calibreAuthorId: number;
  name: string;
  sort?: string | null;
};

export type CalibreTagRow = {
  calibreTagId: number;
  name: string;
};

export type CalibrePublisherRow = {
  calibrePublisherId: number;
  name: string;
  sort?: string | null;
};

export type CalibreSeriesRow = {
  calibreSeriesId: number;
  name: string;
  sort?: string | null;
};

export type CalibreCommentRow = {
  calibreBookId: number;
  text: string;
};

export type CalibreIdentifierRow = {
  calibreBookId: number;
  type: string;
  value: string;
};

export type CalibreBookAuthorLinkRow = {
  calibreBookId: number;
  calibreAuthorId: number;
};

export type CalibreBookTagLinkRow = {
  calibreBookId: number;
  calibreTagId: number;
};

export type CalibreBookPublisherLinkRow = {
  calibreBookId: number;
  calibrePublisherId: number;
};

export type CalibreBookSeriesLinkRow = {
  calibreBookId: number;
  calibreSeriesId: number;
};

export type CalibreLanguageLinkRow = {
  calibreBookId: number;
  langCode: string;
};

/**
 * Represents a format file on disk for a Calibre book.
 * `relativePath` is intended to be a Delb-style stored path (POSIX-ish):
 *   library/<calibre-book-dir>/<filename.ext>
 */
export type CalibreFormatFile = {
  calibreBookId: number;
  format: string; // normalized lower-case extension (e.g. "epub")
  filename: string;
  relativePath: string; // includes leading "library/..."
};

type TableInfoRow = { name: string };
type ColumnInfoRow = { name: string };

function normalizeFormat(input: string): string {
  return (input ?? "").toString().trim().toLowerCase();
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function safeString(v: unknown): string {
  return (v ?? "").toString();
}

/**
 * CalibreReader wraps a read-only connection to `metadata.db`.
 * Call `close()` when you're done.
 */
export class CalibreReader {
  private readonly db: Database.Database;
  private readonly libraryRootAbs: string;

  constructor(opts: CalibreReaderOptions) {
    this.libraryRootAbs = opts.libraryRootAbs;

    const filename = opts.metadataDbFilename ?? "metadata.db";
    const dbAbs = path.resolve(opts.libraryRootAbs, filename);

    if (!existsSync(dbAbs)) {
      throw createError({
        statusCode: 400,
        statusMessage: `Calibre metadata database not found at: ${dbAbs}`,
      });
    }

    // better-sqlite3 `readonly` option exists; keep conservative.
    this.db = new Database(dbAbs, {
      readonly: opts.readonly ?? true,
      fileMustExist: true,
    });

    // Some Calibre DBs can be busy if Calibre is running.
    // This makes reads more tolerant in practice.
    try {
      this.db.pragma("busy_timeout = 5000");
    } catch {
      // ignore
    }
  }

  close() {
    this.db.close();
  }

  /** Return true if `metadata.db` has a given table. */
  hasTable(tableName: string): boolean {
    const row = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
      )
      .get(tableName) as TableInfoRow | undefined;

    return !!row?.name;
  }

  /** Return true if a table has a given column. */
  hasColumn(tableName: string, columnName: string): boolean {
    if (!this.hasTable(tableName)) return false;

    const rows = this.db
      .prepare(`PRAGMA table_info(${this.escapeIdent(tableName)})`)
      .all() as ColumnInfoRow[];

    return rows.some((r) => r?.name === columnName);
  }

  /** Very small identifier escaper for PRAGMA uses (table names only). */
  private escapeIdent(ident: string): string {
    // SQLite identifiers can be quoted with double quotes; double quotes inside are doubled.
    const safe = (ident ?? "").toString().replace(/"/g, '""');
    return `"${safe}"`;
  }

  /**
   * Read all books from Calibre.
   *
   * Fields vary by Calibre version; we include common ones when present:
   * - books.id (required)
   * - books.title (required)
   * - books.sort (optional)
   * - books.timestamp (optional)
   * - books.pubdate (optional)
   * - books.last_modified (optional)
   * - books.path (optional but very useful)
   * - books.series_index (optional)
   */
  getBooks(): CalibreBookRow[] {
    if (!this.hasTable("books")) {
      throw createError({
        statusCode: 400,
        statusMessage: "Calibre metadata.db is missing required table: books",
      });
    }

    const fields: string[] = ["id as calibreBookId", "title as title"];

    if (this.hasColumn("books", "sort")) fields.push("sort as sort");
    if (this.hasColumn("books", "timestamp"))
      fields.push("timestamp as timestamp");
    if (this.hasColumn("books", "pubdate")) fields.push("pubdate as pubdate");
    if (this.hasColumn("books", "last_modified"))
      fields.push("last_modified as lastModified");
    if (this.hasColumn("books", "path")) fields.push("path as path");
    if (this.hasColumn("books", "series_index"))
      fields.push("series_index as seriesIndex");

    const sql = `SELECT ${fields.join(", ")} FROM books ORDER BY id ASC`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      calibreBookId: asNumber(r.calibreBookId) ?? 0,
      title: safeString(r.title) || "Unknown",
      sort: r.sort !== undefined ? (r.sort as string | null) : undefined,
      timestamp:
        r.timestamp !== undefined ? (r.timestamp as string | null) : undefined,
      pubdate:
        r.pubdate !== undefined ? (r.pubdate as string | null) : undefined,
      lastModified:
        r.lastModified !== undefined
          ? (r.lastModified as string | null)
          : undefined,
      path: r.path !== undefined ? (r.path as string | null) : undefined,
      seriesIndex:
        r.seriesIndex !== undefined
          ? typeof r.seriesIndex === "number"
            ? r.seriesIndex
            : (asNumber(r.seriesIndex) as number | null)
          : undefined,
    }));
  }

  getAuthors(): CalibreAuthorRow[] {
    if (!this.hasTable("authors")) return [];

    const fields: string[] = ["id as calibreAuthorId", "name as name"];
    if (this.hasColumn("authors", "sort")) fields.push("sort as sort");

    const sql = `SELECT ${fields.join(", ")} FROM authors ORDER BY name COLLATE NOCASE ASC`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      calibreAuthorId: asNumber(r.calibreAuthorId) ?? 0,
      name: safeString(r.name),
      sort: r.sort !== undefined ? (r.sort as string | null) : undefined,
    }));
  }

  getTags(): CalibreTagRow[] {
    if (!this.hasTable("tags")) return [];

    const sql = `SELECT id as calibreTagId, name as name FROM tags ORDER BY name COLLATE NOCASE ASC`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      calibreTagId: asNumber(r.calibreTagId) ?? 0,
      name: safeString(r.name),
    }));
  }

  getPublishers(): CalibrePublisherRow[] {
    if (!this.hasTable("publishers")) return [];

    const fields: string[] = ["id as calibrePublisherId", "name as name"];
    if (this.hasColumn("publishers", "sort")) fields.push("sort as sort");

    const sql = `SELECT ${fields.join(", ")} FROM publishers ORDER BY name COLLATE NOCASE ASC`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      calibrePublisherId: asNumber(r.calibrePublisherId) ?? 0,
      name: safeString(r.name),
      sort: r.sort !== undefined ? (r.sort as string | null) : undefined,
    }));
  }

  getSeries(): CalibreSeriesRow[] {
    if (!this.hasTable("series")) return [];

    const fields: string[] = ["id as calibreSeriesId", "name as name"];
    if (this.hasColumn("series", "sort")) fields.push("sort as sort");

    const sql = `SELECT ${fields.join(", ")} FROM series ORDER BY name COLLATE NOCASE ASC`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      calibreSeriesId: asNumber(r.calibreSeriesId) ?? 0,
      name: safeString(r.name),
      sort: r.sort !== undefined ? (r.sort as string | null) : undefined,
    }));
  }

  /**
   * Book -> author links.
   *
   * Calibre commonly uses `books_authors_link` with columns:
   * - book (int)
   * - author (int)
   */
  getBookAuthorsLinks(): CalibreBookAuthorLinkRow[] {
    if (!this.hasTable("books_authors_link")) return [];

    const sql = `SELECT book as calibreBookId, author as calibreAuthorId FROM books_authors_link`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;

    return rows
      .map((r) => ({
        calibreBookId: asNumber(r.calibreBookId) ?? 0,
        calibreAuthorId: asNumber(r.calibreAuthorId) ?? 0,
      }))
      .filter((r) => r.calibreBookId > 0 && r.calibreAuthorId > 0);
  }

  /**
   * Book -> tag links.
   *
   * Calibre commonly uses `books_tags_link` with columns:
   * - book (int)
   * - tag (int)
   */
  getBookTagsLinks(): CalibreBookTagLinkRow[] {
    if (!this.hasTable("books_tags_link")) return [];

    const sql = `SELECT book as calibreBookId, tag as calibreTagId FROM books_tags_link`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;

    return rows
      .map((r) => ({
        calibreBookId: asNumber(r.calibreBookId) ?? 0,
        calibreTagId: asNumber(r.calibreTagId) ?? 0,
      }))
      .filter((r) => r.calibreBookId > 0 && r.calibreTagId > 0);
  }

  /**
   * Book -> publisher link.
   *
   * Calibre commonly uses `books_publishers_link` with columns:
   * - book (int)
   * - publisher (int)
   */
  getBookPublishersLinks(): CalibreBookPublisherLinkRow[] {
    if (!this.hasTable("books_publishers_link")) return [];

    const sql = `SELECT book as calibreBookId, publisher as calibrePublisherId FROM books_publishers_link`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;

    return rows
      .map((r) => ({
        calibreBookId: asNumber(r.calibreBookId) ?? 0,
        calibrePublisherId: asNumber(r.calibrePublisherId) ?? 0,
      }))
      .filter((r) => r.calibreBookId > 0 && r.calibrePublisherId > 0);
  }

  /**
   * Book -> series link.
   *
   * Calibre commonly uses `books_series_link` with columns:
   * - book (int)
   * - series (int)
   */
  getBookSeriesLinks(): CalibreBookSeriesLinkRow[] {
    if (!this.hasTable("books_series_link")) return [];

    const sql = `SELECT book as calibreBookId, series as calibreSeriesId FROM books_series_link`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;

    return rows
      .map((r) => ({
        calibreBookId: asNumber(r.calibreBookId) ?? 0,
        calibreSeriesId: asNumber(r.calibreSeriesId) ?? 0,
      }))
      .filter((r) => r.calibreBookId > 0 && r.calibreSeriesId > 0);
  }

  /**
   * Book comments/description.
   *
   * Calibre commonly uses `comments` with columns:
   * - book (int)
   * - text (text)
   */
  getComments(): CalibreCommentRow[] {
    if (!this.hasTable("comments")) return [];

    const sql = `SELECT book as calibreBookId, text as text FROM comments`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;

    return rows
      .map((r) => ({
        calibreBookId: asNumber(r.calibreBookId) ?? 0,
        text: safeString(r.text),
      }))
      .filter((r) => r.calibreBookId > 0 && r.text.length > 0);
  }

  /**
   * Book identifiers (isbn, amazon, etc).
   *
   * Calibre commonly uses `identifiers` with columns:
   * - book (int)
   * - type (text)
   * - val (text)
   */
  getIdentifiers(): CalibreIdentifierRow[] {
    if (!this.hasTable("identifiers")) return [];

    const sql = `SELECT book as calibreBookId, type as type, val as value FROM identifiers`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;

    return rows
      .map((r) => ({
        calibreBookId: asNumber(r.calibreBookId) ?? 0,
        type: normalizeFormat(safeString(r.type)),
        value: safeString(r.value),
      }))
      .filter(
        (r) => r.calibreBookId > 0 && r.type.length > 0 && r.value.length > 0,
      );
  }

  /**
   * Languages are upgrade-added in some Calibre versions:
   * - languages(lang_code)
   * - books_languages_link(book, language)  (common)
   *
   * However, the link column name can vary across versions. This helper detects the
   * correct column name and then performs the join.
   *
   * We'll return (bookId, langCode) pairs.
   */
  getLanguages(): CalibreLanguageLinkRow[] {
    if (!this.hasTable("languages") || !this.hasTable("books_languages_link")) {
      return [];
    }

    // Calibre schema variation: the FK column on `books_languages_link` is not
    // universally named `language`. Detect what exists.
    const linkCandidates = [
      "language",
      "lang",
      "languages",
      "lang_code",
      "langId",
    ];
    const linkCol =
      linkCandidates.find((c) => this.hasColumn("books_languages_link", c)) ??
      null;

    if (!linkCol) return [];

    // Calibre schema variation: `languages` has `lang_code` in most versions,
    // but be defensive.
    const codeColCandidate = this.hasColumn("languages", "lang_code")
      ? "lang_code"
      : this.hasColumn("languages", "code")
        ? "code"
        : null;

    if (!codeColCandidate) return [];

    const sql = `
      SELECT
        bl.book as calibreBookId,
        l.${codeColCandidate} as langCode
      FROM books_languages_link bl
      INNER JOIN languages l ON l.id = bl.${linkCol}
    `;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;

    return rows
      .map((r) => ({
        calibreBookId: asNumber(r.calibreBookId) ?? 0,
        langCode: normalizeFormat(safeString(r.langCode)),
      }))
      .filter((r) => r.calibreBookId > 0 && r.langCode.length > 0);
  }

  /**
   * Best-effort: query format information from common Calibre tables.
   *
   * Calibre schemas vary significantly here. This method implements detectors for a few
   * common patterns and returns filename+format when possible.
   *
   * When this fails or returns empty, callers can optionally fall back to scanning the
   * on-disk book directories (requires knowing `books.path`).
   */
  getFormatFilesFromDb(): CalibreFormatFile[] {
    // Pattern A (common in older docs): `data` table stores BLOBs, not file paths -> not useful for import-in-place.
    // Pattern B (common in newer versions): `books_data_link` linking to `data` rows that contain name/format.
    // Pattern C: `book_formats` or `formats` tables (varies).
    //
    // Because we cannot be sure, we try a couple known shapes.

    const out: CalibreFormatFile[] = [];

    // Helper to build Delb-style relative path under `library/`
    const booksById = new Map<number, CalibreBookRow>();
    try {
      for (const b of this.getBooks()) booksById.set(b.calibreBookId, b);
    } catch (e) {
      logger.warn(
        e,
        "CalibreReader: failed to load books while resolving formats",
      );
    }

    // Detector 1: books_data_link + data (with format + name)
    if (this.hasTable("books_data_link") && this.hasTable("data")) {
      const hasDataFormat =
        this.hasColumn("data", "format") ||
        this.hasColumn("data", "format_col");
      const hasDataName = this.hasColumn("data", "name");

      if (hasDataName && hasDataFormat) {
        const formatCol = this.hasColumn("data", "format")
          ? "format"
          : "format_col";

        const sql = `
          SELECT
            bdl.book as calibreBookId,
            d.${formatCol} as format,
            d.name as filename
          FROM books_data_link bdl
          INNER JOIN data d ON d.id = bdl.data
        `;

        const rows = this.db.prepare(sql).all() as Array<
          Record<string, unknown>
        >;

        for (const r of rows) {
          const calibreBookId = asNumber(r.calibreBookId) ?? 0;
          const b = booksById.get(calibreBookId);
          const calibreRelDir = (b?.path ?? "").toString().trim();

          const format = normalizeFormat(safeString(r.format));
          const filename = safeString(r.filename).trim();

          if (!calibreBookId || !format || !filename || !calibreRelDir)
            continue;

          out.push({
            calibreBookId,
            format,
            filename,
            relativePath: ["library", calibreRelDir, filename].join("/"),
          });
        }

        if (out.length) return out;
      }
    }

    // Detector 2: data table with non-blob references (rare) - try `data.format` + `data.name` + `data.book`
    if (this.hasTable("data") && this.hasColumn("data", "book")) {
      const hasFormat = this.hasColumn("data", "format");
      const hasName = this.hasColumn("data", "name");
      if (hasFormat && hasName) {
        const sql = `
          SELECT
            book as calibreBookId,
            format as format,
            name as filename
          FROM data
        `;
        const rows = this.db.prepare(sql).all() as Array<
          Record<string, unknown>
        >;

        for (const r of rows) {
          const calibreBookId = asNumber(r.calibreBookId) ?? 0;
          const b = booksById.get(calibreBookId);
          const calibreRelDir = (b?.path ?? "").toString().trim();

          const format = normalizeFormat(safeString(r.format));
          const filename = safeString(r.filename).trim();

          if (!calibreBookId || !format || !filename || !calibreRelDir)
            continue;

          out.push({
            calibreBookId,
            format,
            filename,
            relativePath: ["library", calibreRelDir, filename].join("/"),
          });
        }

        if (out.length) return out;
      }
    }

    // Nothing found by DB-based detectors.
    return [];
  }

  /**
   * Compute the expected on-disk book directory (absolute) for a Calibre book row.
   * Requires `books.path` to exist in the DB for the given book.
   */
  resolveBookDirAbs(book: CalibreBookRow): string | null {
    const rel = (book.path ?? "").toString().trim();
    if (!rel) return null;
    return path.resolve(this.libraryRootAbs, rel);
  }

  /**
   * Compute the expected cover path (relative + absolute) for a Calibre book.
   * Calibre commonly stores `cover.jpg` or `cover.png` inside the book directory.
   */
  getCoverCandidates(book: CalibreBookRow): Array<{
    filename: string;
    relativePath: string; // includes leading library/
    absPath: string;
  }> {
    const relDir = (book.path ?? "").toString().trim();
    if (!relDir) return [];

    const candidates = ["cover.jpg", "cover.jpeg", "cover.png"];
    return candidates.map((filename) => {
      const relativePath = ["library", relDir, filename].join("/");
      const absPath = path.resolve(this.libraryRootAbs, relDir, filename);
      return { filename, relativePath, absPath };
    });
  }

  /**
   * Convenience: fetch everything needed for a Delb import in one call,
   * while keeping each slice queryable independently.
   */
  getSnapshot(): {
    books: CalibreBookRow[];
    authors: CalibreAuthorRow[];
    tags: CalibreTagRow[];
    publishers: CalibrePublisherRow[];
    series: CalibreSeriesRow[];
    bookAuthors: CalibreBookAuthorLinkRow[];
    bookTags: CalibreBookTagLinkRow[];
    bookPublishers: CalibreBookPublisherLinkRow[];
    bookSeries: CalibreBookSeriesLinkRow[];
    comments: CalibreCommentRow[];
    identifiers: CalibreIdentifierRow[];
    languages: CalibreLanguageLinkRow[];
    formatFiles: CalibreFormatFile[];
  } {
    const books = this.getBooks();
    return {
      books,
      authors: this.getAuthors(),
      tags: this.getTags(),
      publishers: this.getPublishers(),
      series: this.getSeries(),
      bookAuthors: this.getBookAuthorsLinks(),
      bookTags: this.getBookTagsLinks(),
      bookPublishers: this.getBookPublishersLinks(),
      bookSeries: this.getBookSeriesLinks(),
      comments: this.getComments(),
      identifiers: this.getIdentifiers(),
      languages: this.getLanguages(),
      formatFiles: this.getFormatFilesFromDb(),
    };
  }
}
