import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

/**
 * Canonical, built-in per-user book statuses (v1).
 *
 * Notes:
 * - Stored as strings for forward compatibility with "custom statuses" later.
 * - API should validate against this list for now.
 * - UI copy should prefer human labels:
 *   - to_be_read => "To be read"
 *   - reading => "Reading"
 *   - finished => "Finished"
 *   - dnf => "DNF"
 */
export const USER_BOOK_STATUSES = [
  'to_be_read',
  'reading',
  'finished',
  'dnf',
] as const;

export type UserBookStatusValue = (typeof USER_BOOK_STATUSES)[number];

// Users table for better-auth
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull(),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  role: text('role').notNull(),
  banned: integer('banned', { mode: 'boolean' }),
  banReason: text('ban_reason'),
  banExpires: integer('ban_expires', { mode: 'timestamp' }),
});

// Session table for better-auth
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  impersonatedBy: text('impersonated_by'),
});

// Accounts table for better-auth
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', {
    mode: 'timestamp',
  }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', {
    mode: 'timestamp',
  }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// Verifications table for better-auth
export const verifications = sqliteTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

/**
 * COLLECTIONS (shareable containers)
 *
 * - The entire app is the user's "library"
 * - Collections are shareable groupings of books (like photo albums)
 * - Users can collaborate via collection membership + roles
 */

export const collections = sqliteTable(
  'collections',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * Marks a user's default "Personal" collection.
     * - Exactly one per user (enforced at the app layer for now).
     * - Non-deletable.
     * - Not shareable.
     */
    isPersonal: integer('is_personal', { mode: 'boolean' })
      .notNull()
      .$defaultFn(() => false),

    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // Helpful for quickly finding a user's personal collection (and enforcing uniqueness in app logic).
    collectionsOwnerIsPersonalIdx: index(
      'collections_owner_is_personal_idx',
    ).on(t.ownerUserId, t.isPersonal),
  }),
);

export const collectionMembers = sqliteTable('collection_members', {
  collectionId: text('collection_id')
    .notNull()
    .references(() => collections.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // "owner" | "editor" | "viewer"
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const publishers = sqliteTable('publishers', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const series = sqliteTable('series', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const authors = sqliteTable('authors', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),

  // Stored sort key (Calibre-style): used for deterministic sorting (e.g. by last name).
  sortName: text('sort_name').notNull().default(''),

  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// BOOKS TABLE (canonical metadata; shared across collections)
export const books = sqliteTable(
  'books',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),

    // Stored sort key (Calibre-style): title with a leading "The " removed (case-insensitive).
    // Note: current UI default ordering is newest-first; this is for future sort modes.
    sortTitle: text('sort_title').notNull().default(''),

    // Import provenance (optional)
    // Used for idempotent Calibre import + re-scan when `library/metadata.db` is present.
    calibreBookId: integer('calibre_book_id'),

    // Metadata (shared across collections)
    description: text('description'),
    published: text('published'), // raw string (lean v1)
    /**
     * Normalized published date for correct sorting/filtering.
     * Stored as a timestamp.
     *
     * Notes:
     * - Many sources provide only a year or year-month; normalization should choose
     *   a deterministic day (e.g. first of month/year) when partial.
     * - Keep `published` as the original/raw string for display/import provenance.
     */
    publishedAt: integer('published_at', { mode: 'timestamp' }),
    language: text('language'), // raw string (lean v1)

    /**
     * Page count (optional).
     * Stored as an integer so we can support reading progress later.
     */
    pages: integer('pages'),

    coverImagePath: text('cover_image_path'), // keep inline for lean v1

    publisherId: text('publisher_id').references(() => publishers.id, {
      onDelete: 'set null',
    }),

    seriesId: text('series_id').references(() => series.id, {
      onDelete: 'set null',
    }),
    seriesIndex: real('series_index'),

    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // Ensure one Delb book per Calibre book id (idempotent import/rescan).
    // SQLite UNIQUE allows multiple NULLs, so non-Calibre books remain unaffected.
    calibreBookIdUnique: uniqueIndex('books_calibre_book_id_unique').on(
      t.calibreBookId,
    ),
  }),
);

export const collectionBooks = sqliteTable(
  'collection_books',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    bookId: text('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    addedByUserId: text('added_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    addedAt: integer('added_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // Prevent duplicate (collection_id, book_id) pairs.
    collectionIdBookIdUnique: uniqueIndex(
      'collection_books_collection_id_book_id_unique',
    ).on(t.collectionId, t.bookId),
  }),
);

export const bookAuthors = sqliteTable(
  'book_authors',
  {
    bookId: text('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => authors.id, { onDelete: 'cascade' }),
    position: integer('position'),
  },
  (t) => ({
    // Prevent duplicate (book_id, author_id) links.
    bookIdAuthorIdUnique: uniqueIndex(
      'book_authors_book_id_author_id_unique',
    ).on(t.bookId, t.authorId),
  }),
);

export const bookTags = sqliteTable(
  'book_tags',
  {
    bookId: text('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    // Prevent duplicate (book_id, tag_id) links.
    bookIdTagIdUnique: uniqueIndex('book_tags_book_id_tag_id_unique').on(
      t.bookId,
      t.tagId,
    ),
  }),
);

export const bookIdentifiers = sqliteTable(
  'book_identifiers',
  {
    bookId: text('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // e.g. "isbn"
    value: text('value').notNull(),
  },
  (t) => ({
    // Ensure (book_id, type) is unique so we can safely UPSERT identifiers.
    bookIdTypeUnique: uniqueIndex('book_identifiers_book_id_type_unique').on(
      t.bookId,
      t.type,
    ),
  }),
);

export const bookFiles = sqliteTable(
  'book_files',
  {
    id: text('id').primaryKey(),
    bookId: text('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    format: text('format').notNull(), // e.g. "epub"
    relativePath: text('relative_path').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // Prevent duplicate file pointers per book.
    // This is the safest uniqueness constraint for import-in-place.
    bookIdRelativePathUnique: uniqueIndex(
      'book_files_book_id_relative_path_unique',
    ).on(t.bookId, t.relativePath),
  }),
);

/**
 * Per-user state (not shared just because a book is shared):
 * - shelves/status
 * - ratings
 * - notes
 */

export const userBookStatus = sqliteTable(
  'user_book_status',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: text('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),

    // v1 built-ins: "to_be_read" | "reading" | "finished" | "dnf"
    // Stored as text to allow future custom statuses without a migration to an enum type.
    status: text('status').notNull(),

    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // Enforce one (mutually exclusive) status per (user, book).
    userBookStatusUserBookUnique: uniqueIndex(
      'user_book_status_user_book_unique',
    ).on(t.userId, t.bookId),
    // Helpful for filtering "shelf pages" / sidebar filters later.
    userBookStatusUserStatusIdx: index('user_book_status_user_status_idx').on(
      t.userId,
      t.status,
    ),
  }),
);

export const userBookReadingPosition = sqliteTable(
  'user_book_reading_position',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: text('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),

    /**
     * EPUB.js location (CFI string or other serialized location).
     * Store as text for flexibility across reader implementations.
     */
    location: text('location').notNull(),

    /**
     * Optional progress percentage (0..100) for quick display.
     * Keep nullable because some locations may not provide progress.
     */
    progress: real('progress'),

    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // Enforce one position per (user, book).
    userBookReadingPositionUserBookUnique: uniqueIndex(
      'user_book_reading_position_user_book_unique',
    ).on(t.userId, t.bookId),
    userBookReadingPositionUserIdx: index(
      'user_book_reading_position_user_idx',
    ).on(t.userId),
  }),
);

export const bookRatings = sqliteTable(
  'book_ratings',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: text('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),

    /**
     * User's rating for this book.
     *
     * Stored as an integer "half-star" scale:
     * - 1..10 maps to 0.5..5.0 stars
     *
     * (Example: 7 => 3.5 stars)
     */
    rating: integer('rating').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // Enforce one rating per (user, book).
    bookRatingsUserBookUnique: uniqueIndex('book_ratings_user_book_unique').on(
      t.userId,
      t.bookId,
    ),
  }),
);

export const bookNotes = sqliteTable('book_notes', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  bookId: text('book_id')
    .notNull()
    .references(() => books.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// USER SETTINGS TABLE
export const userSettings = sqliteTable('user_settings', {
  userId: text('user_id').primaryKey().unique(),
  settings: text('settings', { mode: 'json' }).notNull().default('{}'),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// GLOBAL SETTINGS TABLE
export const globalSettings = sqliteTable('global_settings', {
  id: text('user_id').primaryKey(),
  settings: text('settings', { mode: 'json' }).notNull().default('{}'),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Server-side secrets (tokens/credentials) keyed by secret id.
 *
 * Notes:
 * - Secrets are NEVER returned to the client.
 * - Use the `id` as the key, e.g.:
 *   - "hardcoverToken"
 */
export const globalSecrets = sqliteTable('global_secrets', {
  id: text('id').primaryKey(),
  value: text('value').notNull().default(''),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// TYPE
export type InsertUserSettings = InferInsertModel<typeof userSettings>;
export type InsertGlobalSettings = InferInsertModel<typeof globalSettings>;
export type InsertGlobalSecrets = InferInsertModel<typeof globalSecrets>;

export type InsertCollection = InferInsertModel<typeof collections>;
export type InsertCollectionMember = InferInsertModel<typeof collectionMembers>;
export type InsertCollectionBook = InferInsertModel<typeof collectionBooks>;

export type InsertBook = InferInsertModel<typeof books>;
export type InsertBookFile = InferInsertModel<typeof bookFiles>;
export type InsertBookAuthor = InferInsertModel<typeof bookAuthors>;
export type InsertBookTag = InferInsertModel<typeof bookTags>;
export type InsertBookIdentifier = InferInsertModel<typeof bookIdentifiers>;

export type InsertUserBookStatus = InferInsertModel<typeof userBookStatus>;
export type InsertUserBookReadingPosition = InferInsertModel<
  typeof userBookReadingPosition
>;
export type InsertBookRating = InferInsertModel<typeof bookRatings>;
export type InsertBookNote = InferInsertModel<typeof bookNotes>;

export type SelectUserSettings = InferSelectModel<typeof userSettings>;
export type SelectGlobalSettings = InferSelectModel<typeof globalSettings>;
export type SelectGlobalSecrets = InferSelectModel<typeof globalSecrets>;

export type SelectCollection = InferSelectModel<typeof collections>;
export type SelectCollectionMember = InferSelectModel<typeof collectionMembers>;
export type SelectCollectionBook = InferSelectModel<typeof collectionBooks>;

export type SelectBook = InferSelectModel<typeof books>;
export type SelectBookFile = InferSelectModel<typeof bookFiles>;
export type SelectBookAuthor = InferSelectModel<typeof bookAuthors>;
export type SelectBookTag = InferSelectModel<typeof bookTags>;
export type SelectBookIdentifier = InferSelectModel<typeof bookIdentifiers>;

export type SelectUserBookStatus = InferSelectModel<typeof userBookStatus>;
export type SelectUserBookReadingPosition = InferSelectModel<
  typeof userBookReadingPosition
>;
export type SelectBookRating = InferSelectModel<typeof bookRatings>;
export type SelectBookNote = InferSelectModel<typeof bookNotes>;
