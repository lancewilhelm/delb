import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

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

// BOOKS TABLE (minimal MVP)
export const books = sqliteTable("books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  author: text("author").notNull(),
  format: text("format").notNull(), // e.g. "epub"
  relativePath: text("relative_path").notNull(), // e.g. "data/books/{author}/{title}/{title}.epub"
  coverImagePath: text("cover_image_path"), // e.g. "data/books/{author}/{title}/cover.jpg"
  createdAt: integer("created_at", { mode: "timestamp" })
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
export type InsertBook = InferInsertModel<typeof books>;

export type SelectUserSettings = InferSelectModel<typeof userSettings>;
export type SelectGlobalSettings = InferSelectModel<typeof globalSettings>;
export type SelectBook = InferSelectModel<typeof books>;
