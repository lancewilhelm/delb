import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

// Users table for better-auth
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  role: text("role").notNull(),
  banned: integer("banned", { mode: "boolean" }),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp" }),
});

// Session table for better-auth
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by"),
});

// Accounts table for better-auth
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", {
    mode: "timestamp",
  }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", {
    mode: "timestamp",
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// Verifications table for better-auth
export const verifications = sqliteTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});

/**
 * COLLECTIONS (shareable containers)
 *
 * - The entire app is the user's "library"
 * - Collections are shareable groupings of books (like photo albums)
 * - Users can collaborate via collection membership + roles
 */

export const collections = sqliteTable("collections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const collectionMembers = sqliteTable("collection_members", {
  collectionId: text("collection_id")
    .notNull()
    .references(() => collections.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // "owner" | "editor" | "viewer"
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const publishers = sqliteTable("publishers", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const series = sqliteTable("series", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const authors = sqliteTable("authors", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// BOOKS TABLE (canonical metadata; shared across collections)
export const books = sqliteTable("books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),

  // Metadata (shared across collections)
  description: text("description"),
  published: text("published"), // raw string (lean v1)
  language: text("language"), // raw string (lean v1)
  coverImagePath: text("cover_image_path"), // keep inline for lean v1

  publisherId: text("publisher_id").references(() => publishers.id, {
    onDelete: "set null",
  }),

  seriesId: text("series_id").references(() => series.id, {
    onDelete: "set null",
  }),
  seriesIndex: real("series_index"),

  createdByUserId: text("created_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const collectionBooks = sqliteTable("collection_books", {
  collectionId: text("collection_id")
    .notNull()
    .references(() => collections.id, { onDelete: "cascade" }),
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  addedByUserId: text("added_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  addedAt: integer("added_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const bookAuthors = sqliteTable("book_authors", {
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  authorId: text("author_id")
    .notNull()
    .references(() => authors.id, { onDelete: "cascade" }),
  position: integer("position"),
});

export const bookTags = sqliteTable("book_tags", {
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  tagId: text("tag_id")
    .notNull()
    .references(() => tags.id, { onDelete: "cascade" }),
});

export const bookIdentifiers = sqliteTable("book_identifiers", {
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // e.g. "isbn"
  value: text("value").notNull(),
});

export const bookFiles = sqliteTable("book_files", {
  id: text("id").primaryKey(),
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  format: text("format").notNull(), // e.g. "epub"
  relativePath: text("relative_path").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Per-user state (not shared just because a book is shared):
 * - shelves/status
 * - ratings
 * - notes
 */

export const userBookStatus = sqliteTable("user_book_status", {
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  status: text("status").notNull(), // "to_read" | "reading" | "read"
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const bookRatings = sqliteTable("book_ratings", {
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(), // scale TBD (e.g. 0-10)
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const bookNotes = sqliteTable("book_notes", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// USER SETTINGS TABLE
export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id").primaryKey().unique(),
  settings: text("settings", { mode: "json" }).notNull().default("{}"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// GLOBAL SETTINGS TABLE
export const globalSettings = sqliteTable("global_settings", {
  id: text("user_id").primaryKey(),
  settings: text("settings", { mode: "json" }).notNull().default("{}"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// TYPE
export type InsertUserSettings = InferInsertModel<typeof userSettings>;
export type InsertGlobalSettings = InferInsertModel<typeof globalSettings>;

export type InsertCollection = InferInsertModel<typeof collections>;
export type InsertCollectionMember = InferInsertModel<typeof collectionMembers>;
export type InsertCollectionBook = InferInsertModel<typeof collectionBooks>;

export type InsertBook = InferInsertModel<typeof books>;
export type InsertBookFile = InferInsertModel<typeof bookFiles>;
export type InsertBookAuthor = InferInsertModel<typeof bookAuthors>;
export type InsertBookTag = InferInsertModel<typeof bookTags>;
export type InsertBookIdentifier = InferInsertModel<typeof bookIdentifiers>;

export type InsertUserBookStatus = InferInsertModel<typeof userBookStatus>;
export type InsertBookRating = InferInsertModel<typeof bookRatings>;
export type InsertBookNote = InferInsertModel<typeof bookNotes>;

export type SelectUserSettings = InferSelectModel<typeof userSettings>;
export type SelectGlobalSettings = InferSelectModel<typeof globalSettings>;

export type SelectCollection = InferSelectModel<typeof collections>;
export type SelectCollectionMember = InferSelectModel<typeof collectionMembers>;
export type SelectCollectionBook = InferSelectModel<typeof collectionBooks>;

export type SelectBook = InferSelectModel<typeof books>;
export type SelectBookFile = InferSelectModel<typeof bookFiles>;
export type SelectBookAuthor = InferSelectModel<typeof bookAuthors>;
export type SelectBookTag = InferSelectModel<typeof bookTags>;
export type SelectBookIdentifier = InferSelectModel<typeof bookIdentifiers>;

export type SelectUserBookStatus = InferSelectModel<typeof userBookStatus>;
export type SelectBookRating = InferSelectModel<typeof bookRatings>;
export type SelectBookNote = InferSelectModel<typeof bookNotes>;
