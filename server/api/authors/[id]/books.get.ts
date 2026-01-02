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
 * GET /api/authors/:id/books?collectionId=<optional>
 *
 * Returns books associated with a given author that the current user can access.
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
  logger.debug("GET /api/authors/:id/books");

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: "Unauthorized" };
  }

  const userId = session.user.id;

  const authorId = getRouterParam(event, "id");
  if (!authorId) {
    setResponseStatus(event, 400);
    return { success: false, message: "Missing author id" };
  }

  const { collectionId } = getQuery(event) as { collectionId?: string };

  try {
    // Confirm author exists (nice UX; still no access leak beyond existence of author row)
    const authorExists = await cloudDb
      .select({ id: authors.id })
      .from(authors)
      .where(eq(authors.id, authorId))
      .limit(1);

    if (!authorExists.length) {
      // Match the "don't leak much" style used elsewhere: 404
      throw createError({ statusCode: 404, statusMessage: "Author not found" });
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

    if (!targetCollectionIds.length) {
      // If a specific collection was requested but user isn't a member, return empty
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

    // 4) Find the subset of visible books that have this author
    const authoredLinks = await cloudDb
      .select({ bookId: bookAuthors.bookId })
      .from(bookAuthors)
      .where(
        and(
          eq(bookAuthors.authorId, authorId),
          inArray(bookAuthors.bookId, visibleBookIds),
        ),
      );

    const authoredBookIds = Array.from(
      new Set(authoredLinks.map((l) => l.bookId)),
    ).filter(Boolean);

    if (!authoredBookIds.length) {
      return { success: true, data: { books: [] } };
    }

    // 5) Fetch books
    // Prefer a single IN query rather than N per book.
    const bookRows = await cloudDb
      .select()
      .from(books)
      .where(inArray(books.id, authoredBookIds));

    // 6) Attach authors (ordered)
    const allAuthorLinks = await cloudDb
      .select({
        bookId: bookAuthors.bookId,
        authorId: bookAuthors.authorId,
        position: bookAuthors.position,
      })
      .from(bookAuthors)
      .where(inArray(bookAuthors.bookId, authoredBookIds));

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

    // 7) Attach publisher + series display info
    const publisherIds = Array.from(
      new Set(bookRows.map((b) => b.publisherId).filter(Boolean)),
    ) as string[];

    const seriesIds = Array.from(
      new Set(bookRows.map((b) => b.seriesId).filter(Boolean)),
    ) as string[];

    const publisherRows = publisherIds.length
      ? await cloudDb
          .select({ id: publishers.id, name: publishers.name })
          .from(publishers)
          .where(inArray(publishers.id, publisherIds))
      : [];

    const seriesRows = seriesIds.length
      ? await cloudDb
          .select({ id: series.id, name: series.name })
          .from(series)
          .where(inArray(series.id, seriesIds))
      : [];

    const publisherById = new Map(publisherRows.map((p) => [p.id, p]));
    const seriesById = new Map(seriesRows.map((s) => [s.id, s]));

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

      const publisher = b.publisherId
        ? (publisherById.get(b.publisherId) ?? null)
        : null;

      const seriesOut = b.seriesId
        ? (seriesById.get(b.seriesId) ?? null)
        : null;

      return {
        ...b,
        author,
        authorNames,
        authors: authorsOut,
        publisher,
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

    logger.error(error, "GET /api/authors/:id/books: failed");
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to fetch author books",
    });
  }
});
