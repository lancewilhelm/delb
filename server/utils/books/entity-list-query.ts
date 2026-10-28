import { sql } from 'drizzle-orm';

const entities = {
  authors: {
    table: 'authors',
    relation: 'JOIN book_authors rel ON rel.author_id = e.id',
    key: 'rel.book_id',
    order: 'v.title, v.book_id',
  },
  publishers: {
    table: 'publishers',
    relation: '',
    key: 'b.publisher_id',
    order: 'v.title, v.book_id',
  },
  series: {
    table: 'series',
    relation: '',
    key: 'b.series_id',
    order: 'COALESCE(v.series_index, 999999), v.title, v.book_id',
  },
  tags: {
    table: 'tags',
    relation: 'JOIN book_tags rel ON rel.tag_id = e.id',
    key: 'rel.book_id',
    order: 'v.title, v.book_id',
  },
} satisfies Record<
  string,
  { table: string; relation: string; key: string; order: string }
>;

export type EntityKind = keyof typeof entities;

export function entityListQuery({
  kind,
  userId,
  collectionId,
  search,
  limit,
  offset,
  previewLimit,
}: {
  kind: EntityKind;
  userId: string;
  collectionId?: string;
  search: string;
  limit: number;
  offset: number;
  previewLimit: number;
}) {
  const config = entities[kind];
  return sql`
      WITH visible AS (
        SELECT DISTINCT e.id, e.name, b.id AS book_id, b.title,
          b.cover_image_path, b.updated_at, b.series_index
        FROM ${sql.raw(config.table)} e
        ${sql.raw(config.relation)}
        JOIN books b ON ${sql.raw(config.key)} = ${sql.raw(kind === 'authors' || kind === 'tags' ? 'b.id' : 'e.id')}
        JOIN collection_books cb ON cb.book_id = b.id
        JOIN collection_members cm ON cm.collection_id = cb.collection_id
        WHERE cm.user_id = ${userId}
          AND (${collectionId ?? null} IS NULL OR cb.collection_id = ${collectionId ?? null})
          AND instr(lower(e.name), lower(${search})) > 0
      ), summaries AS (
        SELECT id, name, count(*) AS book_count FROM visible
        GROUP BY id, name ORDER BY name, id LIMIT ${limit + 1} OFFSET ${offset}
      ), ranked AS (
        SELECT v.*, row_number() OVER (PARTITION BY v.id ORDER BY ${sql.raw(config.order)}) AS position
        FROM visible v JOIN (SELECT id FROM summaries ORDER BY name, id LIMIT ${limit}) s ON s.id = v.id
        WHERE v.cover_image_path IS NOT NULL AND trim(v.cover_image_path) != ''
      )
      SELECT s.id, s.name, s.book_count AS bookCount, r.book_id AS bookId,
        r.title, r.cover_image_path AS coverImagePath, r.updated_at AS updatedAt,
        r.series_index AS seriesIndex
      FROM summaries s LEFT JOIN ranked r ON r.id = s.id AND (${previewLimit} = -1 OR r.position <= ${previewLimit})
      ORDER BY s.name, s.id, r.position
    `;
}
