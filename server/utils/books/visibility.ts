import { sql } from 'drizzle-orm';
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
} from '~/utils/db/schema';

export function visibleEntity(
  kind: 'author' | 'tag' | 'publisher' | 'series',
  userId: string,
) {
  const visible = sql`EXISTS (SELECT 1 FROM ${collectionBooks} INNER JOIN ${collectionMembers} ON ${collectionMembers.collectionId} = ${collectionBooks.collectionId} WHERE ${collectionBooks.bookId} = ${books.id} AND ${collectionMembers.userId} = ${userId})`;
  switch (kind) {
    case 'author':
      return sql`EXISTS (SELECT 1 FROM ${bookAuthors} INNER JOIN ${books} ON ${books.id} = ${bookAuthors.bookId} WHERE ${bookAuthors.authorId} = ${authors.id} AND ${visible})`;
    case 'tag':
      return sql`EXISTS (SELECT 1 FROM ${bookTags} INNER JOIN ${books} ON ${books.id} = ${bookTags.bookId} WHERE ${bookTags.tagId} = ${tags.id} AND ${visible})`;
    case 'publisher':
      return sql`EXISTS (SELECT 1 FROM ${books} WHERE ${books.publisherId} = ${publishers.id} AND ${visible})`;
    case 'series':
      return sql`EXISTS (SELECT 1 FROM ${books} WHERE ${books.seriesId} = ${series.id} AND ${visible})`;
  }
}
