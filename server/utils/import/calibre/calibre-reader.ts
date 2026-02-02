import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

import { createClient, type Client, type ResultSet } from '@libsql/client';
import { createError } from 'h3';
import { logger } from '~/utils/logger';

/**
 * Calibre metadata.db reader (import helper)
 *
 * Goals:
 * - Avoid native Node addons (e.g. better-sqlite3) for container portability
 * - Be resilient (schema varies across Calibre versions)
 * - Prefer migration: compute format file paths relative to Calibre library root
 *
 * Note: This is intentionally a *thin* reader, not a full Calibre ORM.
 */

export type CalibreReaderOptions = {
  /** Absolute path to Calibre library root. Typically `<projectRoot>/library`. */
  libraryRootAbs: string;

  /** Optional override for the metadata db filename (default: metadata.db). */
  metadataDbFilename?: string;

  /** Open the DB read-only by default. (SQLite file access is read-only by convention here) */
  readonly?: boolean;
};

export type CalibreBookRow = {
  calibreBookId: number;
  title: string;
  sort?: string | null;
  timestamp?: string | null;
  pubdate?: string | null;
  lastModified?: string | null;
  path?: string | null;
  seriesIndex?: number | null;
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
  link?: string | null;
};

export type CalibreSeriesRow = {
  calibreSeriesId: number;
  name: string;
  sort?: string | null;
  link?: string | null;
};

export type CalibreBookAuthorLink = {
  calibreBookId: number;
  calibreAuthorId: number;
};

export type CalibreBookTagLink = {
  calibreBookId: number;
  calibreTagId: number;
};

export type CalibreBookPublisherLink = {
  calibreBookId: number;
  calibrePublisherId: number;
};

export type CalibreBookSeriesLink = {
  calibreBookId: number;
  calibreSeriesId: number;
  seriesIndex?: number | null;
};

export type CalibreCommentRow = {
  calibreBookId: number;
  text: string | null;
};

export type CalibreIdentifierRow = {
  calibreBookId: number;
  type: string;
  value: string;
};

export type CalibreLanguageRow = {
  calibreBookId: number;
  langCode: string;
};

export type CalibreFormatFile = {
  calibreBookId: number;
  format: string;
  /**
   * Path relative to Calibre library root.
   * Example: `Author Name/Title (123)/Title - Author Name.epub`
   */
  relativePath: string;
};

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function safeString(v: unknown): string {
  return (v ?? '').toString();
}

function normalizeFormat(input: string): string {
  return (input ?? '').toString().trim().toLowerCase();
}

type Row = Record<string, unknown>;

function rowsFrom(rs: ResultSet): Row[] {
  // libsql returns rows as objects keyed by column name
  return (rs.rows as unknown as Row[]) ?? [];
}

/**
 * Small helper around @libsql/client for local file sqlite usage.
 * Keeps the CalibreReader code cleaner.
 */
class LibsqlFileDb {
  private readonly client: Client;

  constructor(dbAbs: string) {
    this.client = createClient({ url: `file:${dbAbs}` });
  }

  async execute(
    sql: string,
    args: Array<string | number | bigint | null> = [],
  ): Promise<ResultSet> {
    // `@libsql/client` expects args that are SQLite-compatible scalar values.
    return await this.client.execute({ sql, args });
  }

  async all(
    sql: string,
    args: Array<string | number | bigint | null> = [],
  ): Promise<Row[]> {
    const rs = await this.execute(sql, args);
    return rowsFrom(rs);
  }

  async get(
    sql: string,
    args: Array<string | number | bigint | null> = [],
  ): Promise<Row | undefined> {
    const rs = await this.execute(sql, args);
    const r = rowsFrom(rs)[0];
    return r;
  }

  async close(): Promise<void> {
    try {
      // Not always present in typings / some transports
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = this.client as any;
      if (typeof c.close === 'function') await c.close();
    } catch {
      // ignore
    }
  }
}

/**
 * CalibreReader wraps a read-only connection to `metadata.db`.
 * Call `close()` when you're done.
 */
export class CalibreReader {
  private readonly db: LibsqlFileDb;
  private readonly libraryRootAbs: string;

  constructor(opts: CalibreReaderOptions) {
    this.libraryRootAbs = opts.libraryRootAbs;

    const filename = opts.metadataDbFilename ?? 'metadata.db';
    const dbAbs = path.resolve(opts.libraryRootAbs, filename);

    if (!existsSync(dbAbs)) {
      throw createError({
        statusCode: 400,
        statusMessage: `Calibre metadata database not found at: ${dbAbs}`,
      });
    }

    // readonly is enforced by us (we never write), and by mounting the library read-only in Docker.
    // @libsql/client uses SQLite under the hood for file: URLs.
    this.db = new LibsqlFileDb(dbAbs);
  }

  async close() {
    await this.db.close();
  }

  /** Very small identifier escaper for PRAGMA uses (table names/columns only). */
  private escapeIdent(ident: string): string {
    const safe = (ident ?? '').toString().replace(/"/g, '""');
    return `"${safe}"`;
  }

  /** Return true if `metadata.db` has a given table. */
  async hasTable(tableName: string): Promise<boolean> {
    const row = await this.db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
      [tableName],
    );
    return !!row?.name;
  }

  /** Return true if a table has a given column. */
  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    if (!(await this.hasTable(tableName))) return false;

    const rows = await this.db.all(
      `PRAGMA table_info(${this.escapeIdent(tableName)})`,
    );
    return rows.some((r) => r?.name === columnName);
  }

  /**
   * Compute the expected on-disk book directory (absolute) for a Calibre book row.
   * Requires `books.path` to exist in the DB for the given book.
   */
  resolveBookDirAbs(book: CalibreBookRow): string | null {
    const rel = (book.path ?? '').toString().trim();
    if (!rel) return null;
    return path.resolve(this.libraryRootAbs, rel);
  }

  /**
   * Cover candidates expected by the import route.
   * Returns Delb-style `library/<book.path>/<filename>` relative paths plus absolute paths.
   */
  getCoverCandidates(book: CalibreBookRow): Array<{
    filename: string;
    relativePath: string;
    absPath: string;
  }> {
    const relDir = (book.path ?? '').toString().trim();
    if (!relDir) return [];

    const candidates = [
      'thumb.webp',
      'cover.source.jpg',
      'cover.source.jpeg',
      'cover.source.png',
      'cover.source.webp',
      'source.jpg',
      'source.jpeg',
      'source.png',
      'source.webp',
      'cover.jpg',
      'cover.jpeg',
      'cover.png',
    ];

    return candidates.map((filename) => {
      const relativePath = ['library', relDir, filename].join('/');
      const absPath = path.resolve(this.libraryRootAbs, relDir, filename);
      return { filename, relativePath, absPath };
    });
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
  async getBooks(): Promise<CalibreBookRow[]> {
    if (!(await this.hasTable('books'))) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Calibre metadata.db is missing required table: books',
      });
    }

    const fields: string[] = ['id as calibreBookId', 'title as title'];

    if (await this.hasColumn('books', 'sort')) fields.push('sort as sort');
    if (await this.hasColumn('books', 'timestamp'))
      fields.push('timestamp as timestamp');
    if (await this.hasColumn('books', 'pubdate'))
      fields.push('pubdate as pubdate');
    if (await this.hasColumn('books', 'last_modified'))
      fields.push('last_modified as lastModified');
    if (await this.hasColumn('books', 'path')) fields.push('path as path');
    if (await this.hasColumn('books', 'series_index'))
      fields.push('series_index as seriesIndex');

    const sql = `SELECT ${fields.join(', ')} FROM books ORDER BY id ASC`;
    const rows = await this.db.all(sql);

    return rows.map((r) => ({
      calibreBookId: asNumber(r.calibreBookId) ?? 0,
      title: safeString(r.title) || 'Unknown',
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
          ? typeof r.seriesIndex === 'number'
            ? r.seriesIndex
            : asNumber(r.seriesIndex)
          : undefined,
    }));
  }

  /** Read a single Calibre book by id (best-effort; returns null if missing). */
  async getBookById(calibreBookId: number): Promise<CalibreBookRow | null> {
    const id = asNumber(calibreBookId);
    if (!id || id <= 0) return null;

    if (!(await this.hasTable('books'))) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Calibre metadata.db is missing required table: books',
      });
    }

    const fields: string[] = ['id as calibreBookId', 'title as title'];
    if (await this.hasColumn('books', 'sort')) fields.push('sort as sort');
    if (await this.hasColumn('books', 'timestamp'))
      fields.push('timestamp as timestamp');
    if (await this.hasColumn('books', 'pubdate'))
      fields.push('pubdate as pubdate');
    if (await this.hasColumn('books', 'last_modified'))
      fields.push('last_modified as lastModified');
    if (await this.hasColumn('books', 'path')) fields.push('path as path');
    if (await this.hasColumn('books', 'series_index'))
      fields.push('series_index as seriesIndex');

    const sql = `SELECT ${fields.join(', ')} FROM books WHERE id = ? LIMIT 1`;
    const row = await this.db.get(sql, [id]);
    if (!row) return null;

    return {
      calibreBookId: asNumber(row.calibreBookId) ?? id,
      title: safeString(row.title) || 'Unknown',
      sort: row.sort !== undefined ? (row.sort as string | null) : undefined,
      timestamp:
        row.timestamp !== undefined ? (row.timestamp as string | null) : undefined,
      pubdate:
        row.pubdate !== undefined ? (row.pubdate as string | null) : undefined,
      lastModified:
        row.lastModified !== undefined
          ? (row.lastModified as string | null)
          : undefined,
      path: row.path !== undefined ? (row.path as string | null) : undefined,
      seriesIndex:
        row.seriesIndex !== undefined
          ? typeof row.seriesIndex === 'number'
            ? row.seriesIndex
            : asNumber(row.seriesIndex)
          : undefined,
    };
  }

  /** Read all authors. */
  async getAuthors(): Promise<CalibreAuthorRow[]> {
    if (!(await this.hasTable('authors'))) return [];

    const fields: string[] = ['id as calibreAuthorId', 'name as name'];
    if (await this.hasColumn('authors', 'sort')) fields.push('sort as sort');

    const sql = `SELECT ${fields.join(', ')} FROM authors ORDER BY id ASC`;
    const rows = await this.db.all(sql);

    return rows.map((r) => ({
      calibreAuthorId: asNumber(r.calibreAuthorId) ?? 0,
      name: safeString(r.name) || 'Unknown',
      sort: r.sort !== undefined ? (r.sort as string | null) : undefined,
    }));
  }

  /** Read all tags. */
  async getTags(): Promise<CalibreTagRow[]> {
    if (!(await this.hasTable('tags'))) return [];

    const sql = `SELECT id as calibreTagId, name as name FROM tags ORDER BY id ASC`;
    const rows = await this.db.all(sql);

    return rows.map((r) => ({
      calibreTagId: asNumber(r.calibreTagId) ?? 0,
      name: safeString(r.name) || 'Unknown',
    }));
  }

  /** Read all publishers. */
  async getPublishers(): Promise<CalibrePublisherRow[]> {
    if (!(await this.hasTable('publishers'))) return [];

    const fields: string[] = ['id as calibrePublisherId', 'name as name'];
    if (await this.hasColumn('publishers', 'sort')) fields.push('sort as sort');
    if (await this.hasColumn('publishers', 'link')) fields.push('link as link');

    const sql = `SELECT ${fields.join(', ')} FROM publishers ORDER BY id ASC`;
    const rows = await this.db.all(sql);

    return rows.map((r) => ({
      calibrePublisherId: asNumber(r.calibrePublisherId) ?? 0,
      name: safeString(r.name) || 'Unknown',
      sort: r.sort !== undefined ? (r.sort as string | null) : undefined,
      link: r.link !== undefined ? (r.link as string | null) : undefined,
    }));
  }

  /** Read all series. */
  async getSeries(): Promise<CalibreSeriesRow[]> {
    if (!(await this.hasTable('series'))) return [];

    const fields: string[] = ['id as calibreSeriesId', 'name as name'];
    if (await this.hasColumn('series', 'sort')) fields.push('sort as sort');
    if (await this.hasColumn('series', 'link')) fields.push('link as link');

    const sql = `SELECT ${fields.join(', ')} FROM series ORDER BY id ASC`;
    const rows = await this.db.all(sql);

    return rows.map((r) => ({
      calibreSeriesId: asNumber(r.calibreSeriesId) ?? 0,
      name: safeString(r.name) || 'Unknown',
      sort: r.sort !== undefined ? (r.sort as string | null) : undefined,
      link: r.link !== undefined ? (r.link as string | null) : undefined,
    }));
  }

  /**
   * Read book-author join.
   * Calibre usually stores this in `books_authors_link` with columns:
   * - book (books.id)
   * - author (authors.id)
   */
  async getBookAuthorLinks(): Promise<CalibreBookAuthorLink[]> {
    const table = 'books_authors_link';
    if (!(await this.hasTable(table))) return [];

    const bookCol = (await this.hasColumn(table, 'book'))
      ? 'book'
      : (await this.hasColumn(table, 'book_id'))
        ? 'book_id'
        : null;
    const authorCol = (await this.hasColumn(table, 'author'))
      ? 'author'
      : (await this.hasColumn(table, 'author_id'))
        ? 'author_id'
        : null;

    if (!bookCol || !authorCol) return [];

    const sql = `SELECT ${this.escapeIdent(bookCol)} as calibreBookId, ${this.escapeIdent(authorCol)} as calibreAuthorId FROM ${this.escapeIdent(table)}`;
    const rows = await this.db.all(sql);

    return rows
      .map((r) => ({
        calibreBookId: asNumber(r.calibreBookId) ?? 0,
        calibreAuthorId: asNumber(r.calibreAuthorId) ?? 0,
      }))
      .filter((r) => r.calibreBookId > 0 && r.calibreAuthorId > 0);
  }

  /**
   * Read book-tag join.
   * Usually `books_tags_link` with columns:
   * - book
   * - tag
   */
  async getBookTagLinks(): Promise<CalibreBookTagLink[]> {
    const table = 'books_tags_link';
    if (!(await this.hasTable(table))) return [];

    const bookCol = (await this.hasColumn(table, 'book'))
      ? 'book'
      : (await this.hasColumn(table, 'book_id'))
        ? 'book_id'
        : null;
    const tagCol = (await this.hasColumn(table, 'tag'))
      ? 'tag'
      : (await this.hasColumn(table, 'tag_id'))
        ? 'tag_id'
        : null;

    if (!bookCol || !tagCol) return [];

    const sql = `SELECT ${this.escapeIdent(bookCol)} as calibreBookId, ${this.escapeIdent(tagCol)} as calibreTagId FROM ${this.escapeIdent(table)}`;
    const rows = await this.db.all(sql);

    return rows
      .map((r) => ({
        calibreBookId: asNumber(r.calibreBookId) ?? 0,
        calibreTagId: asNumber(r.calibreTagId) ?? 0,
      }))
      .filter((r) => r.calibreBookId > 0 && r.calibreTagId > 0);
  }

  /**
   * Read book-publisher mapping.
   *
   * Calibre commonly models this via `books_publishers_link` with columns:
   * - book (books.id)
   * - publisher (publishers.id)
   *
   * Some Calibre variants also have `books.publisher` as a FK; we fall back to that if the link table isn't present.
   */
  async getBookPublisherLinks(): Promise<CalibreBookPublisherLink[]> {
    const linkTable = 'books_publishers_link';

    // Preferred: link table
    if (await this.hasTable(linkTable)) {
      const bookCol = (await this.hasColumn(linkTable, 'book'))
        ? 'book'
        : (await this.hasColumn(linkTable, 'book_id'))
          ? 'book_id'
          : null;
      const publisherCol = (await this.hasColumn(linkTable, 'publisher'))
        ? 'publisher'
        : (await this.hasColumn(linkTable, 'publisher_id'))
          ? 'publisher_id'
          : null;

      if (bookCol && publisherCol) {
        const sql = `SELECT ${this.escapeIdent(bookCol)} as calibreBookId, ${this.escapeIdent(publisherCol)} as calibrePublisherId FROM ${this.escapeIdent(linkTable)}`;
        const rows = await this.db.all(sql);

        return rows
          .map((r) => ({
            calibreBookId: asNumber(r.calibreBookId) ?? 0,
            calibrePublisherId: asNumber(r.calibrePublisherId) ?? 0,
          }))
          .filter((r) => r.calibreBookId > 0 && r.calibrePublisherId > 0);
      }

      return [];
    }

    // Fallback: books.publisher FK (older/alternate schema assumptions)
    if (!(await this.hasTable('books'))) return [];
    if (!(await this.hasColumn('books', 'publisher'))) return [];

    const sql = `SELECT id as calibreBookId, publisher as calibrePublisherId FROM books WHERE publisher IS NOT NULL`;
    const rows = await this.db.all(sql);

    return rows
      .map((r) => ({
        calibreBookId: asNumber(r.calibreBookId) ?? 0,
        calibrePublisherId: asNumber(r.calibrePublisherId) ?? 0,
      }))
      .filter((r) => r.calibreBookId > 0 && r.calibrePublisherId > 0);
  }

  /**
   * Read book-series mapping.
   *
   * Calibre commonly models this via `books_series_link` with columns:
   * - book (books.id)
   * - series (series.id)
   *
   * Series index is often stored on `books.series_index`.
   * Some Calibre variants also have `books.series` as a FK; we fall back to that if the link table isn't present.
   */
  async getBookSeriesLinks(): Promise<CalibreBookSeriesLink[]> {
    const linkTable = 'books_series_link';

    const indexCol =
      (await this.hasTable('books')) &&
      (await this.hasColumn('books', 'series_index'))
        ? 'series_index'
        : null;

    // Preferred: link table
    if (await this.hasTable(linkTable)) {
      const bookCol = (await this.hasColumn(linkTable, 'book'))
        ? 'book'
        : (await this.hasColumn(linkTable, 'book_id'))
          ? 'book_id'
          : null;
      const seriesCol = (await this.hasColumn(linkTable, 'series'))
        ? 'series'
        : (await this.hasColumn(linkTable, 'series_id'))
          ? 'series_id'
          : null;

      if (!bookCol || !seriesCol) return [];

      const sql = `SELECT ${this.escapeIdent(bookCol)} as calibreBookId, ${this.escapeIdent(seriesCol)} as calibreSeriesId FROM ${this.escapeIdent(linkTable)}`;
      const rows = await this.db.all(sql);

      // If we can, enrich with series_index from books table
      let seriesIndexByBookId: Map<number, number | null> | null = null;
      if (indexCol && (await this.hasTable('books'))) {
        const idxRows = await this.db.all(
          `SELECT id as calibreBookId, ${this.escapeIdent(indexCol)} as seriesIndex FROM books`,
        );

        const entries: Array<[number, number | null]> = [];
        for (const r of idxRows) {
          const bookId = asNumber(r.calibreBookId);
          if (!bookId || bookId <= 0) continue;

          const seriesIndex =
            r.seriesIndex !== undefined
              ? typeof r.seriesIndex === 'number'
                ? r.seriesIndex
                : asNumber(r.seriesIndex)
              : null;

          entries.push([bookId, seriesIndex ?? null]);
        }

        seriesIndexByBookId = new Map<number, number | null>(entries);
      }

      return rows
        .map((r) => {
          const calibreBookId = asNumber(r.calibreBookId) ?? 0;
          const calibreSeriesId = asNumber(r.calibreSeriesId) ?? 0;
          const seriesIndex =
            seriesIndexByBookId?.get(calibreBookId) ?? undefined;

          return {
            calibreBookId,
            calibreSeriesId,
            seriesIndex,
          };
        })
        .filter((r) => r.calibreBookId > 0 && r.calibreSeriesId > 0);
    }

    // Fallback: books.series FK
    if (!(await this.hasTable('books'))) return [];
    if (!(await this.hasColumn('books', 'series'))) return [];

    const fields = [
      'id as calibreBookId',
      'series as calibreSeriesId',
      ...(indexCol ? [`${this.escapeIdent(indexCol)} as seriesIndex`] : []),
    ];

    const sql = `SELECT ${fields.join(', ')} FROM books WHERE series IS NOT NULL`;
    const rows = await this.db.all(sql);

    return rows
      .map((r) => ({
        calibreBookId: asNumber(r.calibreBookId) ?? 0,
        calibreSeriesId: asNumber(r.calibreSeriesId) ?? 0,
        seriesIndex:
          r.seriesIndex !== undefined
            ? typeof r.seriesIndex === 'number'
              ? r.seriesIndex
              : asNumber(r.seriesIndex)
            : undefined,
      }))
      .filter((r) => r.calibreBookId > 0 && r.calibreSeriesId > 0);
  }

  /**
   * Read comments/description.
   * Calibre commonly stores HTML comments in `comments` with:
   * - book (books.id)
   * - text
   */
  async getComments(): Promise<CalibreCommentRow[]> {
    const table = 'comments';
    if (!(await this.hasTable(table))) return [];

    const bookCol = (await this.hasColumn(table, 'book'))
      ? 'book'
      : (await this.hasColumn(table, 'book_id'))
        ? 'book_id'
        : null;
    const textCol = (await this.hasColumn(table, 'text')) ? 'text' : null;

    if (!bookCol || !textCol) return [];

    const sql = `SELECT ${this.escapeIdent(bookCol)} as calibreBookId, ${this.escapeIdent(textCol)} as text FROM ${this.escapeIdent(table)}`;
    const rows = await this.db.all(sql);

    return rows
      .map((r) => ({
        calibreBookId: asNumber(r.calibreBookId) ?? 0,
        text: r.text !== undefined ? (r.text as string | null) : null,
      }))
      .filter((r) => r.calibreBookId > 0);
  }

  /**
   * Read identifiers.
   * Calibre commonly:
   * - table: identifiers
   * - columns: book, type, val
   */
  async getIdentifiers(): Promise<CalibreIdentifierRow[]> {
    const table = 'identifiers';
    if (!(await this.hasTable(table))) return [];

    const bookCol = (await this.hasColumn(table, 'book'))
      ? 'book'
      : (await this.hasColumn(table, 'book_id'))
        ? 'book_id'
        : null;
    const typeCol = (await this.hasColumn(table, 'type')) ? 'type' : null;
    const valCol = (await this.hasColumn(table, 'val'))
      ? 'val'
      : (await this.hasColumn(table, 'value'))
        ? 'value'
        : null;

    if (!bookCol || !typeCol || !valCol) return [];

    const sql = `SELECT ${this.escapeIdent(bookCol)} as calibreBookId, ${this.escapeIdent(typeCol)} as type, ${this.escapeIdent(valCol)} as value FROM ${this.escapeIdent(table)}`;
    const rows = await this.db.all(sql);

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
   * Read book languages.
   * Calibre schemas vary:
   * - some have `books_languages_link` + `languages` tables
   * - some embed language code in link table
   *
   * Returns list of (bookId, langCode).
   */
  async getLanguages(): Promise<CalibreLanguageRow[]> {
    const linkTable = 'books_languages_link';
    if (!(await this.hasTable(linkTable))) return [];

    const bookCol = (await this.hasColumn(linkTable, 'book'))
      ? 'book'
      : (await this.hasColumn(linkTable, 'book_id'))
        ? 'book_id'
        : null;

    const directLangCol = (await this.hasColumn(linkTable, 'lang_code'))
      ? 'lang_code'
      : (await this.hasColumn(linkTable, 'lang'))
        ? 'lang'
        : null;

    // Direct language code stored in the link table
    if (bookCol && directLangCol) {
      const sql = `SELECT ${this.escapeIdent(bookCol)} as calibreBookId, ${this.escapeIdent(directLangCol)} as langCode FROM ${this.escapeIdent(linkTable)}`;
      const rows = await this.db.all(sql);
      return rows
        .map((r) => ({
          calibreBookId: asNumber(r.calibreBookId) ?? 0,
          langCode: safeString(r.langCode),
        }))
        .filter((r) => r.calibreBookId > 0 && r.langCode.length > 0);
    }

    // Link table references a languages table
    const langIdCol = (await this.hasColumn(linkTable, 'language'))
      ? 'language'
      : (await this.hasColumn(linkTable, 'lang_id'))
        ? 'lang_id'
        : null;

    if (!bookCol || !langIdCol || !(await this.hasTable('languages')))
      return [];

    const languagesTable = 'languages';
    const langPk = (await this.hasColumn(languagesTable, 'id')) ? 'id' : null;
    const codeCol = (await this.hasColumn(languagesTable, 'lang_code'))
      ? 'lang_code'
      : (await this.hasColumn(languagesTable, 'code'))
        ? 'code'
        : (await this.hasColumn(languagesTable, 'lang'))
          ? 'lang'
          : null;

    if (!langPk || !codeCol) return [];

    const sql = `
      SELECT bl.${this.escapeIdent(bookCol)} as calibreBookId, l.${this.escapeIdent(codeCol)} as langCode
      FROM ${this.escapeIdent(linkTable)} bl
      JOIN ${this.escapeIdent(languagesTable)} l
        ON l.${this.escapeIdent(langPk)} = bl.${this.escapeIdent(langIdCol)}
    `;
    const rows = await this.db.all(sql);
    return rows
      .map((r) => ({
        calibreBookId: asNumber(r.calibreBookId) ?? 0,
        langCode: safeString(r.langCode),
      }))
      .filter((r) => r.calibreBookId > 0 && r.langCode.length > 0);
  }

  /**
   * Best-effort discovery of format files.
   *
   * Strategy:
   * 1) Try a common-ish DB-derived mapping (books_data_link + data) when present.
   * 2) Optionally fall back to scanning each book folder for known extensions.
   *
   * Note: For migration we store paths relative to the Calibre library root.
   */
  async getFormatFiles(opts?: {
    scanDiskFallback?: boolean;
  }): Promise<CalibreFormatFile[]> {
    const out: CalibreFormatFile[] = [];

    // DB-derived attempt (best-effort)
    try {
      const linkTable = 'books_data_link';
      if (await this.hasTable(linkTable)) {
        const bookCol = (await this.hasColumn(linkTable, 'book'))
          ? 'book'
          : (await this.hasColumn(linkTable, 'book_id'))
            ? 'book_id'
            : null;
        const dataCol = (await this.hasColumn(linkTable, 'data'))
          ? 'data'
          : (await this.hasColumn(linkTable, 'data_id'))
            ? 'data_id'
            : null;
        const formatCol = (await this.hasColumn(linkTable, 'format'))
          ? 'format'
          : null;

        if (bookCol && dataCol && formatCol && (await this.hasTable('data'))) {
          const dataTable = 'data';
          const dataPk = (await this.hasColumn(dataTable, 'id')) ? 'id' : null;
          const nameCol = (await this.hasColumn(dataTable, 'name'))
            ? 'name'
            : null;

          if (dataPk && nameCol) {
            const sql = `
              SELECT bdl.${this.escapeIdent(bookCol)} as calibreBookId,
                     bdl.${this.escapeIdent(formatCol)} as format,
                     d.${this.escapeIdent(nameCol)} as name
              FROM ${this.escapeIdent(linkTable)} bdl
              JOIN ${this.escapeIdent(dataTable)} d
                ON d.${this.escapeIdent(dataPk)} = bdl.${this.escapeIdent(dataCol)}
            `;
            const rows = await this.db.all(sql);

            const booksById = new Map<number, CalibreBookRow>();
            for (const b of await this.getBooks())
              booksById.set(b.calibreBookId, b);

            for (const r of rows) {
              const calibreBookId = asNumber(r.calibreBookId) ?? 0;
              const format = safeString(r.format).toUpperCase();
              const name = safeString(r.name);
              const book = booksById.get(calibreBookId);

              if (!book?.path || !name || !format || !calibreBookId) continue;

              const rel = path.posix.join(
                book.path.replaceAll('\\', '/'),
                name.replaceAll('\\', '/'),
              );

              out.push({ calibreBookId, format, relativePath: rel });
            }
          }
        }
      }
    } catch (e) {
      logger.warn(e, 'CalibreReader: failed to load formats from DB');
    }

    if (out.length > 0) return out;
    if (!opts?.scanDiskFallback) return [];

    // Disk fallback: scan each book directory under books.path for typical format extensions.
    const books = await this.getBooks();
    for (const b of books) {
      if (!b.path) continue;

      const bookDirAbs = path.resolve(this.libraryRootAbs, b.path);
      let entries: string[] = [];
      try {
        entries = readdirSync(bookDirAbs, { withFileTypes: true })
          .filter((d) => d.isFile())
          .map((d) => d.name);
      } catch {
        continue;
      }

      for (const file of entries) {
        const ext = path.extname(file).replace(/^\./, '').toUpperCase();
        if (!ext) continue;

        const isKnown =
          ext === 'EPUB' ||
          ext === 'MOBI' ||
          ext === 'AZW' ||
          ext === 'AZW3' ||
          ext === 'PDF' ||
          ext === 'CBZ' ||
          ext === 'CBR' ||
          ext === 'TXT' ||
          ext === 'RTF' ||
          ext === 'DJVU' ||
          ext === 'DOC' ||
          ext === 'DOCX' ||
          ext === 'HTML' ||
          ext === 'HTM';

        if (!isKnown) continue;

        out.push({
          calibreBookId: b.calibreBookId,
          format: ext,
          relativePath: path.posix.join(
            b.path.replaceAll('\\', '/'),
            file.replaceAll('\\', '/'),
          ),
        });
      }
    }

    return out;
  }

  /**
   * Convenience helper used by the admin import route.
   * Keeps route logic simple by returning all related slices at once.
   */
  async getSnapshot(): Promise<{
    books: CalibreBookRow[];
    authors: CalibreAuthorRow[];
    tags: CalibreTagRow[];
    publishers: CalibrePublisherRow[];
    series: CalibreSeriesRow[];
    bookAuthors: CalibreBookAuthorLink[];
    bookTags: CalibreBookTagLink[];
    bookPublishers: CalibreBookPublisherLink[];
    bookSeries: CalibreBookSeriesLink[];
    comments: CalibreCommentRow[];
    identifiers: CalibreIdentifierRow[];
    languages: CalibreLanguageRow[];
    formatFiles: CalibreFormatFile[];
  }> {
    const books = await this.getBooks();

    return {
      books,
      authors: await this.getAuthors(),
      tags: await this.getTags(),
      publishers: await this.getPublishers(),
      series: await this.getSeries(),
      bookAuthors: await this.getBookAuthorLinks(),
      bookTags: await this.getBookTagLinks(),
      bookPublishers: await this.getBookPublisherLinks(),
      bookSeries: await this.getBookSeriesLinks(),
      comments: await this.getComments(),
      identifiers: await this.getIdentifiers(),
      languages: await this.getLanguages(),
      formatFiles: await this.getFormatFiles({ scanDiskFallback: true }),
    };
  }
}
