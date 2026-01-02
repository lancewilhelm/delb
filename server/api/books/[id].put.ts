import { and, eq, inArray } from "drizzle-orm";
import { cloudDb } from "~~/server/utils/db/cloud";
import {
  authors,
  bookAuthors,
  bookTags,
  books,
  collectionBooks,
  collectionMembers,
  publishers,
  series,
  tags,
} from "~/utils/db/schema";
import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";

type PutBookBody = {
  title?: string | null;
  description?: string | null;
  published?: string | null;
  language?: string | null;

  /**
   * Publisher / Series:
   * - Prefer `publisherName` / `seriesName` (server will link/create).
   * - `publisherId` / `seriesId` are still accepted for back-compat.
   * - If both are sent, `*Name` wins.
   */
  publisherId?: string | null;
  publisherName?: string | null;

  seriesId?: string | null;
  seriesName?: string | null;

  seriesIndex?: number | null;

  /**
   * Tags:
   * - If omitted => unchanged
   * - If provided => replaces the tag list for the book
   */
  tags?: string[] | null;

  /**
   * Lean v1 author editing:
   * - If omitted => unchanged
   * - If provided => replaces the ordered author list for the book
   * - Supports either `author` (single string) or `authors` (array of strings)
   */
  author?: string | null;
  authors?: string[] | null;
};

function isAdminRole(role: unknown): boolean {
  return role === "admin" || role === "owner";
}

function normalizeOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined; // not provided
  if (value === null) return null; // explicit clear
  if (typeof value !== "string") {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid string value",
    });
  }
  // Keep lean: trim and allow empty -> null
  const v = value.trim();
  return v.length ? v : null;
}

function normalizeOptionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid number value",
    });
  }
  return value;
}

function normalizeOptionalStringArray(
  value: unknown,
  opts?: { fieldName?: string; normalizeSpaces?: boolean },
): string[] | null | undefined {
  const fieldName = opts?.fieldName ?? "value";
  const normalizeSpaces = opts?.normalizeSpaces ?? true;

  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid ${fieldName} value`,
    });
  }

  const cleaned = value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .map((v) => (normalizeSpaces ? v.replace(/\s+/g, " ").trim() : v.trim()))
    .filter((v) => v.length > 0);

  return cleaned.length ? cleaned : null;
}

/**
 * Find or create an author by name (lean v1: unique by exact name).
 *
 * Case sensitivity: this uses an exact equality check on `authors.name`.
 */
async function findOrCreateAuthorByName(name: string) {
  const existing = await cloudDb
    .select()
    .from(authors)
    .where(eq(authors.name, name))
    .limit(1);

  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const now = new Date();

  await cloudDb.insert(authors).values({
    id,
    name,
    createdAt: now,
    updatedAt: now,
  });

  return { id, name };
}

/**
 * Find or create a tag by name (lean v1: unique by exact name).
 *
 * Case sensitivity: this uses an exact equality check on `tags.name`.
 */
async function findOrCreateTagByName(name: string) {
  const existing = await cloudDb
    .select()
    .from(tags)
    .where(eq(tags.name, name))
    .limit(1);

  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const now = new Date();

  await cloudDb.insert(tags).values({
    id,
    name,
    createdAt: now,
    updatedAt: now,
  });

  return { id, name };
}

/**
 * Find or create a publisher by name (lean v1: unique by exact name).
 *
 * Case sensitivity: this uses an exact equality check on `publishers.name`.
 */
async function findOrCreatePublisherByName(name: string) {
  const existing = await cloudDb
    .select()
    .from(publishers)
    .where(eq(publishers.name, name))
    .limit(1);

  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const now = new Date();

  await cloudDb.insert(publishers).values({
    id,
    name,
    createdAt: now,
    updatedAt: now,
  });

  return { id, name };
}

/**
 * Find or create a series by name (lean v1: unique by exact name).
 *
 * Case sensitivity: this uses an exact equality check on `series.name`.
 */
async function findOrCreateSeriesByName(name: string) {
  const existing = await cloudDb
    .select()
    .from(series)
    .where(eq(series.name, name))
    .limit(1);

  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const now = new Date();

  await cloudDb.insert(series).values({
    id,
    name,
    createdAt: now,
    updatedAt: now,
  });

  return { id, name };
}

/**
 * Orphan cleanup helpers
 *
 * Goal: After updating a book, delete any related rows (authors/tags/publishers/series)
 * that are no longer referenced anywhere in the library.
 *
 * Important: This is intended to be run inside the same request after mutations.
 */
async function deleteAuthorIfUnreferenced(authorId: string) {
  const stillUsed = await cloudDb
    .select({ authorId: bookAuthors.authorId })
    .from(bookAuthors)
    .where(eq(bookAuthors.authorId, authorId))
    .limit(1);

  if (stillUsed[0]) return;

  await cloudDb.delete(authors).where(eq(authors.id, authorId));
}

async function deleteTagIfUnreferenced(tagId: string) {
  const stillUsed = await cloudDb
    .select({ tagId: bookTags.tagId })
    .from(bookTags)
    .where(eq(bookTags.tagId, tagId))
    .limit(1);

  if (stillUsed[0]) return;

  await cloudDb.delete(tags).where(eq(tags.id, tagId));
}

async function deletePublisherIfUnreferenced(publisherId: string) {
  const stillUsed = await cloudDb
    .select({ id: books.id })
    .from(books)
    .where(eq(books.publisherId, publisherId))
    .limit(1);

  if (stillUsed[0]) return;

  await cloudDb.delete(publishers).where(eq(publishers.id, publisherId));
}

async function deleteSeriesIfUnreferenced(seriesId: string) {
  const stillUsed = await cloudDb
    .select({ id: books.id })
    .from(books)
    .where(eq(books.seriesId, seriesId))
    .limit(1);

  if (stillUsed[0]) return;

  await cloudDb.delete(series).where(eq(series.id, seriesId));
}

/**
 * PUT /api/books/:id
 *
 * Admin-only endpoint that updates a book's canonical metadata.
 *
 * Lean v1 behavior:
 * - Only updates fields present in the request body.
 * - Allows clearing fields by sending null (or empty-string for string fields).
 * - `author`/`authors` replaces the book's author list (ordered).
 */
export default defineEventHandler(async (event) => {
  logger.debug("PUT /api/books/:id");

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session || !isAdminRole(session.user.role)) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const userId = session.user.id;

  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "Missing book id" });
  }

  const body = (await readBody(event)) as PutBookBody | null;

  if (!body || typeof body !== "object") {
    throw createError({
      statusCode: 400,
      statusMessage: "Missing request body",
    });
  }

  // Enforce visibility: user must be a member of at least one collection that contains the requested book.
  const memberships = await cloudDb
    .select({ collectionId: collectionMembers.collectionId })
    .from(collectionMembers)
    .where(eq(collectionMembers.userId, userId));

  const memberCollectionIds = Array.from(
    new Set(memberships.map((m) => m.collectionId)),
  ).filter(Boolean);

  if (!memberCollectionIds.length) {
    throw createError({ statusCode: 404, statusMessage: "Book not found" });
  }

  const visible = await cloudDb
    .select()
    .from(books)
    .innerJoin(
      collectionBooks,
      and(eq(collectionBooks.bookId, books.id), eq(books.id, id)),
    )
    .where(inArray(collectionBooks.collectionId, memberCollectionIds))
    .limit(1);

  const existingBook = visible[0]?.books;
  if (!existingBook) {
    throw createError({ statusCode: 404, statusMessage: "Book not found" });
  }

  // Capture previous references for orphan cleanup after mutations.
  const prevPublisherId = existingBook.publisherId ?? null;
  const prevSeriesId = existingBook.seriesId ?? null;

  const prevAuthorLinks = await cloudDb
    .select({ authorId: bookAuthors.authorId })
    .from(bookAuthors)
    .where(eq(bookAuthors.bookId, id));

  const prevTagLinks = await cloudDb
    .select({ tagId: bookTags.tagId })
    .from(bookTags)
    .where(eq(bookTags.bookId, id));

  const prevAuthorIds = prevAuthorLinks
    .map((r) => r.authorId)
    .filter((x): x is string => typeof x === "string" && x.length > 0);

  const prevTagIds = prevTagLinks
    .map((r) => r.tagId)
    .filter((x): x is string => typeof x === "string" && x.length > 0);

  // Build a partial update set only with provided fields.
  const update: Partial<typeof books.$inferInsert> = {
    updatedAt: new Date(),
  };

  const title = normalizeOptionalString((body as PutBookBody).title);
  if (title !== undefined) update.title = title ?? "";

  const description = normalizeOptionalString(
    (body as PutBookBody).description,
  );
  if (description !== undefined) update.description = description;

  const published = normalizeOptionalString((body as PutBookBody).published);
  if (published !== undefined) update.published = published;

  const language = normalizeOptionalString((body as PutBookBody).language);
  if (language !== undefined) update.language = language;

  // Publisher / Series by name (preferred) or id (back-compat)
  const publisherName = normalizeOptionalString(
    (body as PutBookBody).publisherName,
  );
  const publisherId = normalizeOptionalString(
    (body as PutBookBody).publisherId,
  );

  const seriesName = normalizeOptionalString((body as PutBookBody).seriesName);
  const seriesId = normalizeOptionalString((body as PutBookBody).seriesId);

  // Resolve name->id if a name field was explicitly provided (including null to clear)
  if (publisherName !== undefined) {
    if (publisherName === null) {
      update.publisherId = null;
    } else {
      const p = await findOrCreatePublisherByName(publisherName);
      update.publisherId = p.id;
    }
  } else if (publisherId !== undefined) {
    update.publisherId = publisherId;
  }

  if (seriesName !== undefined) {
    if (seriesName === null) {
      update.seriesId = null;
    } else {
      const s = await findOrCreateSeriesByName(seriesName);
      update.seriesId = s.id;
    }
  } else if (seriesId !== undefined) {
    update.seriesId = seriesId;
  }

  const seriesIndex = normalizeOptionalNumber(
    (body as PutBookBody).seriesIndex,
  );
  if (seriesIndex !== undefined) update.seriesIndex = seriesIndex;

  // Determine tag updates (optional)
  const newTags = normalizeOptionalStringArray((body as PutBookBody).tags, {
    fieldName: "tags",
    normalizeSpaces: true,
  });

  // Determine author updates (optional)
  const authorSingle = normalizeOptionalString((body as PutBookBody).author);
  const authorsList = normalizeOptionalStringArray(
    (body as PutBookBody).authors,
    {
      fieldName: "authors",
      normalizeSpaces: true,
    },
  );

  // If `authors` is provided, it wins. If not, fall back to `author`.
  const newAuthors: string[] | null | undefined =
    authorsList !== undefined
      ? authorsList
      : authorSingle !== undefined
        ? authorSingle
          ? [authorSingle]
          : null
        : undefined;

  // Ensure there's something to update besides updatedAt.
  const keys = Object.keys(update).filter((k) => k !== "updatedAt");
  const hasAuthorMutation = newAuthors !== undefined;
  const hasTagMutation = newTags !== undefined;
  if (keys.length === 0 && !hasAuthorMutation && !hasTagMutation) {
    throw createError({
      statusCode: 400,
      statusMessage: "No updatable fields provided",
    });
  }

  try {
    // Update book row if any canonical fields provided
    if (keys.length > 0) {
      await cloudDb.update(books).set(update).where(eq(books.id, id));
    }

    // Track which publisher/series ids might have become unreferenced
    const maybeOrphanPublisherIds: string[] = [];
    const maybeOrphanSeriesIds: string[] = [];

    if (
      prevPublisherId &&
      update.publisherId !== undefined &&
      update.publisherId !== prevPublisherId
    ) {
      maybeOrphanPublisherIds.push(prevPublisherId);
    }
    if (
      prevSeriesId &&
      update.seriesId !== undefined &&
      update.seriesId !== prevSeriesId
    ) {
      maybeOrphanSeriesIds.push(prevSeriesId);
    }

    // Replace author links if requested
    if (newAuthors !== undefined) {
      await cloudDb.delete(bookAuthors).where(eq(bookAuthors.bookId, id));

      if (newAuthors && newAuthors.length) {
        let pos = 1;
        for (const name of newAuthors) {
          const a = await findOrCreateAuthorByName(name);
          await cloudDb.insert(bookAuthors).values({
            bookId: id,
            authorId: a.id,
            position: pos,
          });
          pos += 1;
        }
      }

      // Orphan cleanup: any authors that were previously linked but are no longer linked
      const currentLinks = await cloudDb
        .select({ authorId: bookAuthors.authorId })
        .from(bookAuthors)
        .where(eq(bookAuthors.bookId, id));

      const currentAuthorIds = new Set(
        currentLinks
          .map((r) => r.authorId)
          .filter((x): x is string => typeof x === "string" && x.length > 0),
      );

      const maybeOrphanAuthorIds = Array.from(
        new Set(prevAuthorIds.filter((aid) => !currentAuthorIds.has(aid))),
      );

      for (const aid of maybeOrphanAuthorIds) {
        await deleteAuthorIfUnreferenced(aid);
      }
    }

    // Replace tag links if requested
    if (newTags !== undefined) {
      await cloudDb.delete(bookTags).where(eq(bookTags.bookId, id));

      if (newTags && newTags.length) {
        for (const name of newTags) {
          const t = await findOrCreateTagByName(name);
          await cloudDb.insert(bookTags).values({
            bookId: id,
            tagId: t.id,
          });
        }
      }

      // Orphan cleanup: any tags previously linked but no longer linked
      const currentLinks = await cloudDb
        .select({ tagId: bookTags.tagId })
        .from(bookTags)
        .where(eq(bookTags.bookId, id));

      const currentTagIds = new Set(
        currentLinks
          .map((r) => r.tagId)
          .filter((x): x is string => typeof x === "string" && x.length > 0),
      );

      const maybeOrphanTagIds = Array.from(
        new Set(prevTagIds.filter((tid) => !currentTagIds.has(tid))),
      );

      for (const tid of maybeOrphanTagIds) {
        await deleteTagIfUnreferenced(tid);
      }
    }

    // Orphan cleanup for publisher/series (if changed/cleared)
    for (const pid of Array.from(new Set(maybeOrphanPublisherIds))) {
      await deletePublisherIfUnreferenced(pid);
    }
    for (const sid of Array.from(new Set(maybeOrphanSeriesIds))) {
      await deleteSeriesIfUnreferenced(sid);
    }

    return { success: true };
  } catch (error: unknown) {
    // Preserve explicit HTTP errors
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      (error as { statusCode?: unknown }).statusCode
    ) {
      throw error;
    }

    logger.error(error, "PUT /api/books/:id: Error updating book");
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to update book",
    });
  }
});
