import { createClient } from '@libsql/client';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Explicit maintenance operation; never run on the book-list request path. */
export const publishedAtBackfillSql = `
        UPDATE books
        SET published_at =
          CASE
            WHEN published_at IS NOT NULL THEN published_at
            WHEN published IS NULL OR TRIM(published) = '' THEN NULL
            -- YYYY-MM-DD
            WHEN published GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' THEN strftime('%s', published) * 1000
            -- YYYY-MM
            WHEN published GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' THEN strftime('%s', published || '-01') * 1000
            -- YYYY
            WHEN published GLOB '[0-9][0-9][0-9][0-9]' THEN strftime('%s', published || '-01-01') * 1000
            ELSE NULL
          END
        WHERE published_at IS NULL
          AND published IS NOT NULL
          AND TRIM(published) <> '';
      `;

export async function backfillPublishedAt(
  databaseUrl: string,
): Promise<number> {
  if (!databaseUrl.startsWith('file:')) {
    throw new Error(
      'Supply an explicit file: database URL for this maintenance task',
    );
  }
  const client = createClient({ url: databaseUrl });
  try {
    const result = await client.execute(publishedAtBackfillSql);
    return result.rowsAffected;
  } finally {
    client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error('DATABASE_URL is required; no default database is used');
  console.log(
    `Updated ${await backfillPublishedAt(databaseUrl)} publication date rows`,
  );
}
