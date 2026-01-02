import { and, eq, inArray } from "drizzle-orm";
import { cloudDb } from "~~/server/utils/db/cloud";
import {
  authors,
  bookAuthors,
  books,
  collectionBooks,
  collectionMembers,
  publishers,
  series,
} from "~/utils/db/schema";
import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";

/**
 * GET /api/publishers/:id/books?collectionId=<optional>
 *
 * Returns books from a given publisher that the current user can access.
 *
 * Access control:
 * - Requires an authenticated user
 * - Only returns books that exist in collections the user is a member of
 * - Optional `collectionId` further scopes results to that one collection (if user is a member)
 *
 * Response shape mirrors GET /api/books (list) enough for reuse in the UI:
 * - includes `authors` ({id,name}[]) + `authorNames` + legacy `author`
 * - includes `publisher` ({id,name}|null) and `series` ({id,name}|null)
 */
export default defineEventHandler(async (event) => {
  logger.debug("GET /api/publishers/:id/books");

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: "Unauthorized" };
  }

  const userId = session.user.id;

  const publisherId = getRouterParam(event, "id");
  if (!publisherId) {
    setResponseStatus(event, 400);
    return { success: false, message: "Missing publisher id" };
  }

  const { collectionId } = getQuery(event) as { collectionId?: string };

  try {
    // Confirm publisher exists (nice UX). Still avoids leaking books the user can't access.
    const publisherExists = await cloudDb
      .select({ id: publishers.id })
      .from(publishers)
      .where(eq(publishers.id, publisherId))
      .limit(1);

    if (!publisherExists.length) {
      throw createError({
        statusCode: 404,
        statusMessage: "Publisher not found",
      });
    }

    // 1) Determine which collections the user can see
    const memberships = await cloudDb
      .select({ collectionId: collectionMembers.collectionId })
      .from(collectionMembers)
      .where(eq(collectionMembers.userId, userId));

    const memberCollectionIds = Array.from(
      new Set(memberships.map((m) => m.collectionId)),
    ).filter(Boolean);

    if (!memberCollectionIds.length) {
      return { success: true, data: { books: [] } };
    }

    // 2) Apply optional collection scope
    const targetCollectionIds = collectionId
      ? memberCollectionIds.includes(collectionId)
        ? [collectionId]
        : []
      : memberCollectionIds;

    // If a specific collection was requested but user isn't a member, return empty
    if (!targetCollectionIds.length) {
      return { success: true, data: { books: [] } };
    }

    // 3) Get visible book ids from those collections
    const visibleBookLinks = await cloudDb
      .select({ bookId: collectionBooks.bookId })
      .from(collectionBooks)
      .where(inArray(collectionBooks.collectionId, targetCollectionIds));

    const visibleBookIds = Array.from(
      new Set(visibleBookLinks.map((r) => r.bookId)),
    ).filter(Boolean);

    if (!visibleBookIds.length) {
      return { success: true, data: { books: [] } };
    }

    // 4) Fetch books from this publisher that are also visible in the scoped collections
    const bookRows = await cloudDb
      .select()
      .from(books)
      .where(
        and(
          eq(books.publisherId, publisherId),
          inArray(books.id, visibleBookIds),
        ),
      );

    if (!bookRows.length) {
      return { success: true, data: { books: [] } };
    }

    const bookIds = bookRows.map((b) => b.id).filter(Boolean);

    // 5) Attach authors (ordered)
    const allAuthorLinks = await cloudDb
      .select({
        bookId: bookAuthors.bookId,
        authorId: bookAuthors.authorId,
        position: bookAuthors.position,
      })
      .from(bookAuthors)
      .where(inArray(bookAuthors.bookId, bookIds));

    const allAuthorIds = Array.from(
      new Set(allAuthorLinks.map((l) => l.authorId)),
    ).filter(Boolean);

    const authorRows = allAuthorIds.length
      ? await cloudDb
          .select({ id: authors.id, name: authors.name })
          .from(authors)
          .where(inArray(authors.id, allAuthorIds))
      : [];

    const authorNameById = new Map(authorRows.map((a) => [a.id, a.name]));

    const linksByBookId = new Map<string, typeof allAuthorLinks>();
    for (const link of allAuthorLinks) {
      const list = linksByBookId.get(link.bookId) ?? [];
      list.push(link);
      linksByBookId.set(link.bookId, list);
    }

    // 6) Attach publisher + series display info
    const seriesIds = Array.from(
      new Set(bookRows.map((b) => b.seriesId).filter(Boolean)),
    ) as string[];

    const seriesRows = seriesIds.length
      ? await cloudDb
          .select({ id: series.id, name: series.name })
          .from(series)
          .where(inArray(series.id, seriesIds))
      : [];

    const seriesById = new Map(seriesRows.map((s) => [s.id, s]));

    const publisherRow = (
      await cloudDb
        .select({ id: publishers.id, name: publishers.name })
        .from(publishers)
        .where(eq(publishers.id, publisherId))
        .limit(1)
    )[0];

    const publisherOut = publisherRow ?? null;

    const out = bookRows.map((b) => {
      const links = (linksByBookId.get(b.id) ?? []).slice();
      links.sort((a, c) => {
        const aPos = typeof a.position === "number" ? a.position : 10_000;
        const cPos = typeof c.position === "number" ? c.position : 10_000;
        return aPos - cPos;
      });

      const authorNames = links
        .map((l) => (l.authorId ? authorNameById.get(l.authorId) : undefined))
        .filter((n): n is string => typeof n === "string" && n.length > 0);

      const authorsOut = links
        .map((l) => {
          const name = l.authorId ? authorNameById.get(l.authorId) : undefined;
          if (!l.authorId || !name) return null;
          return { id: l.authorId, name };
        })
        .filter(
          (a): a is { id: string; name: string } =>
            !!a && typeof a.id === "string" && typeof a.name === "string",
        );

      // Back-compat: keep the first author in `author`
      const author = authorNames[0];

      const seriesOut = b.seriesId ? (seriesById.get(b.seriesId) ?? null) : null;

      return {
        ...b,
        author,
        authorNames,
        authors: authorsOut,
        publisher: publisherOut,
        series: seriesOut,
      };
    });

    // Keep previous behavior: newest first
    out.sort((a, b) => {
      const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });

    return { success: true, data: { books: out } };
  } catch (error: unknown) {
    // Preserve explicit HTTP errors (401/400/404) thrown above
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      (error as { statusCode?: unknown }).statusCode
    ) {
      throw error;
    }

    logger.error(error, "GET /api/publishers/:id/books: failed");
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to fetch publisher books",
    });
  }
});
