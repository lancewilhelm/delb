import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { auth } from '~~/server/utils/auth';
import { books, bookSpines, collectionMembers } from '~~/server/utils/db/schema';
import { parseSpineEdits } from '~~/shared/spine-artwork';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  assertBookEditor,
  lockCollectionChanges,
} from '~~/server/utils/collections/model';
import { cacheBoundedRequestBody } from '~~/server/utils/books/storage/bounded-upload';
import {
  renderSpine,
  SPINE_MAX_BYTES,
} from '~~/server/utils/books/spine-image';

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const bookId = getRouterParam(event, 'id');
  if (!bookId)
    throw createError({ statusCode: 400, statusMessage: 'Missing book id' });
  const [visible] = await cloudDb
    .select({ id: books.id })
    .from(books)
    .innerJoin(
      collectionMembers,
      and(
        eq(collectionMembers.collectionId, books.collectionId),
        eq(collectionMembers.userId, session.user.id),
      ),
    )
    .where(eq(books.id, bookId))
    .limit(1);
  if (!visible)
    throw createError({ statusCode: 404, statusMessage: 'Book not found' });
  setHeader(event, 'Cache-Control', 'private, no-store');
  setHeader(event, 'Vary', 'Cookie');
  setHeader(event, 'X-Content-Type-Options', 'nosniff');
  if (event.method === 'GET') {
    const variant = getQuery(event).variant ?? 'image';
    if (!['metadata', 'image', 'source'].includes(String(variant)))
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid spine variant',
      });
    if (variant === 'metadata') {
      const [row] = await cloudDb
        .select({ revision: bookSpines.revision, edits: bookSpines.edits })
        .from(bookSpines)
        .where(eq(bookSpines.bookId, bookId))
        .limit(1);
      return {
        exists: !!row,
        revision: row?.revision ?? null,
        edits: row?.edits ?? null,
      };
    }
    if (variant === 'source')
      await assertBookEditor(cloudDb, session.user.id, bookId);
    const [row] = await cloudDb
      .select({
        originalBase64: bookSpines.originalBase64,
        originalType: bookSpines.originalType,
        imageBase64: bookSpines.imageBase64,
      })
      .from(bookSpines)
      .where(eq(bookSpines.bookId, bookId))
      .limit(1);
    if (!row)
      throw createError({ statusCode: 404, statusMessage: 'No spine artwork' });
    setHeader(
      event,
      'Content-Type',
      variant === 'source' ? row.originalType : 'image/webp',
    );
    return Buffer.from(
      variant === 'source' ? row.originalBase64 : row.imageBase64,
      'base64',
    );
  }
  await assertBookEditor(cloudDb, session.user.id, bookId);
  if (event.method === 'DELETE') {
    await cacheBoundedRequestBody(event.node.req, event.node.res, 4096);
    const body: unknown = await readBody(event);
    if (
      !body ||
      typeof body !== 'object' ||
      !('revision' in body) ||
      typeof body.revision !== 'string'
    )
      throw createError({
        statusCode: 400,
        statusMessage: 'Missing spine revision',
      });
    const expectedRevision = body.revision;
    await cloudDb.transaction(async (tx) => {
      await lockCollectionChanges(tx);
      await assertBookEditor(tx, session.user.id, bookId);
      const deleted = await tx
        .delete(bookSpines)
        .where(
          and(
            eq(bookSpines.bookId, bookId),
            eq(bookSpines.revision, expectedRevision),
          ),
        )
        .returning({ bookId: bookSpines.bookId });
      if (!deleted.length)
        throw createError({
          statusCode: 409,
          statusMessage: 'Spine artwork changed. Reload before saving.',
        });
    });
    return { success: true };
  }
  if (event.method !== 'POST')
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' });
  await cacheBoundedRequestBody(
    event.node.req,
    event.node.res,
    SPINE_MAX_BYTES + 1024 * 1024,
  );
  const parts = await readMultipartFormData(event);
  const file = parts?.find((part) => part.name === 'file' && part.filename);
  const editsPart = parts?.find((part) => part.name === 'edits');
  const revisionPart = parts?.find((part) => part.name === 'revision');
  let rawEdits: unknown;
  try {
    rawEdits = JSON.parse(editsPart?.data.toString('utf8') ?? '');
  } catch {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid spine edits',
    });
  }
  const edits = parseSpineEdits(rawEdits);
  if (!edits || !revisionPart)
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid spine edits or revision',
    });
  const expected = revisionPart.data.toString('utf8');
  const [previous] = await cloudDb
    .select()
    .from(bookSpines)
    .where(eq(bookSpines.bookId, bookId))
    .limit(1);
  if ((previous?.revision ?? '') !== expected)
    throw createError({
      statusCode: 409,
      statusMessage: 'Spine artwork changed. Reload before saving.',
    });
  if (!file && !previous)
    throw createError({
      statusCode: 400,
      statusMessage: 'Choose a spine image',
    });
  const original = file
    ? file.data
    : Buffer.from(previous!.originalBase64, 'base64');
  let output: Awaited<ReturnType<typeof renderSpine>>;
  try {
    output = await renderSpine(original, edits);
  } catch {
    throw createError({
      statusCode: 400,
      statusMessage:
        'Use a static JPEG, PNG, WebP or AVIF under 10 MB and 24 megapixels.',
    });
  }
  const revision = randomUUID();
  await cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    await assertBookEditor(tx, session.user.id, bookId);
    const [current] = await tx
      .select({ revision: bookSpines.revision })
      .from(bookSpines)
      .where(eq(bookSpines.bookId, bookId))
      .limit(1);
    if ((current?.revision ?? '') !== expected)
      throw createError({
        statusCode: 409,
        statusMessage: 'Spine artwork changed. Reload before saving.',
      });
    await tx
      .insert(bookSpines)
      .values({
        bookId,
        originalBase64: original.toString('base64'),
        originalType: output.contentType,
        imageBase64: output.image.toString('base64'),
        edits,
        revision,
      })
      .onConflictDoUpdate({
        target: bookSpines.bookId,
        set: {
          originalBase64: original.toString('base64'),
          originalType: output.contentType,
          imageBase64: output.image.toString('base64'),
          edits,
          revision,
        },
      });
  });
  return { success: true, revision };
});
