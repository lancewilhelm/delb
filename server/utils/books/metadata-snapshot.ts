import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import {
  authors,
  bookAuthors,
  bookIdentifiers,
  books,
  bookTags,
  publishers,
  series,
  tags,
} from '~/utils/db/schema';
import type { cloudDb } from '~~/server/utils/db/cloud';

type Tx = Parameters<Parameters<typeof cloudDb.transaction>[0]>[0];

export async function metadataVersion(tx: Tx, bookId: string) {
  const [book] = await tx
    .select({
      title: books.title,
      description: books.description,
      published: books.published,
      language: books.language,
      pages: books.pages,
      publisher: publishers.name,
      series: series.name,
      seriesIndex: books.seriesIndex,
    })
    .from(books)
    .leftJoin(publishers, eq(publishers.id, books.publisherId))
    .leftJoin(series, eq(series.id, books.seriesId))
    .where(eq(books.id, bookId))
    .limit(1);
  if (!book)
    throw createError({ statusCode: 404, statusMessage: 'Book not found.' });
  const authorRows = await tx
    .select({ name: authors.name })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(eq(bookAuthors.bookId, bookId))
    .orderBy(asc(bookAuthors.position), asc(authors.id));
  const tagRows = await tx
    .select({ name: tags.name })
    .from(bookTags)
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .where(eq(bookTags.bookId, bookId))
    .orderBy(asc(tags.name));
  const identifiers = await tx
    .select({ type: bookIdentifiers.type, value: bookIdentifiers.value })
    .from(bookIdentifiers)
    .where(eq(bookIdentifiers.bookId, bookId))
    .orderBy(asc(bookIdentifiers.type), asc(bookIdentifiers.value));
  return createHash('sha256')
    .update(
      JSON.stringify({ book, authors: authorRows, tags: tagRows, identifiers }),
    )
    .digest('hex');
}
