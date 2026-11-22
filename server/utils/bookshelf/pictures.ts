import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import sharp from 'sharp';
import {
  collectionBookshelves,
  collectionMembers,
  personalShelves,
  shelfPictureAssets,
} from '~~/server/utils/db/schema';
import { cloudDb } from '~~/server/utils/db/cloud';
import { lockCollectionChanges } from '~~/server/utils/collections/model';
import { parseBookshelf, type Bookshelf } from '~~/shared/bookshelf';

type Db = Parameters<Parameters<typeof cloudDb.transaction>[0]>[0];
export type PictureScope = { kind: 'collection' | 'personal'; id: string };
const scopeCondition = (scope: PictureScope) =>
  scope.kind === 'collection'
    ? eq(shelfPictureAssets.collectionId, scope.id)
    : eq(shelfPictureAssets.personalShelfId, scope.id);
const fail = (statusCode: number, statusMessage: string): never => {
  throw createError({ statusCode, statusMessage });
};

export async function pictureAccess(
  db: Db,
  userId: string,
  scope: PictureScope,
  edit: boolean,
) {
  if (scope.kind === 'personal') {
    const [row] = await db
      .select({ id: personalShelves.id })
      .from(personalShelves)
      .where(
        and(
          eq(personalShelves.id, scope.id),
          eq(personalShelves.ownerId, userId),
        ),
      )
      .limit(1);
    if (!row) fail(404, 'Shelf not found');
    return;
  }
  const [row] = await db
    .select({ role: collectionMembers.role })
    .from(collectionMembers)
    .where(
      and(
        eq(collectionMembers.collectionId, scope.id),
        eq(collectionMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return fail(404, 'Collection not found');
  if (edit && row.role !== 'owner' && row.role !== 'editor')
    fail(403, 'Owner or editor access required');
}

export async function validatePictureAssets(
  db: Db,
  scope: PictureScope,
  layout: Bookshelf,
) {
  const ids = [
    ...new Set((layout.pictures ?? []).map((picture) => picture.assetId)),
  ];
  const assets = await db
    .select({
      id: shelfPictureAssets.id,
      unusedSince: shelfPictureAssets.unusedSince,
    })
    .from(shelfPictureAssets)
    .where(scopeCondition(scope));
  if (ids.some((id) => !assets.some((asset) => asset.id === id)))
    fail(400, 'A picture is missing or belongs to another shelf.');
  const used = new Set(ids);
  for (const asset of assets) {
    const unusedSince = used.has(asset.id)
      ? null
      : (asset.unusedSince ?? Date.now());
    if (unusedSince !== asset.unusedSince)
      await db
        .update(shelfPictureAssets)
        .set({ unusedSince })
        .where(and(scopeCondition(scope), eq(shelfPictureAssets.id, asset.id)));
  }
}

export async function uploadPicture(
  userId: string,
  scope: PictureScope,
  bytes: Buffer,
) {
  if (!bytes.length || bytes.length > 10 * 1024 * 1024)
    return fail(400, 'Choose an image under 10 MB.');
  let image: Buffer;
  let width: number;
  let height: number;
  try {
    const input = sharp(bytes, {
      limitInputPixels: 24_000_000,
      animated: false,
    });
    const metadata = await input.metadata();
    if (
      !['jpeg', 'png', 'webp', 'heif'].includes(metadata.format ?? '') ||
      (metadata.format === 'heif' && metadata.compression !== 'av1') ||
      (metadata.pages ?? 1) > 1
    )
      throw new Error();
    const result = await input
      .rotate()
      .resize({
        width: 2400,
        height: 2400,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 88 })
      .toBuffer({ resolveWithObject: true });
    image = result.data;
    width = result.info.width;
    height = result.info.height;
    if (image.length > 10 * 1024 * 1024) throw new Error();
  } catch {
    return fail(
      400,
      'Use a static JPEG, PNG, WebP or AVIF under 10 MB and 24 megapixels.',
    );
  }
  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    await pictureAccess(tx, userId, scope, true);
    await tx
      .delete(shelfPictureAssets)
      .where(
        and(
          scopeCondition(scope),
          isNotNull(shelfPictureAssets.unusedSince),
          lt(
            shelfPictureAssets.unusedSince,
            Date.now() - 7 * 24 * 60 * 60 * 1000,
          ),
        ),
      );
    const assets = await tx
      .select({ bytes: shelfPictureAssets.bytes })
      .from(shelfPictureAssets)
      .where(scopeCondition(scope));
    if (
      assets.length >= 100 ||
      assets.reduce((sum, asset) => sum + asset.bytes, 0) + image.length >
        100 * 1024 * 1024
    )
      return fail(400, 'This shelf has reached its picture storage limit.');
    const id = randomUUID();
    await tx.insert(shelfPictureAssets).values({
      id,
      collectionId: scope.kind === 'collection' ? scope.id : null,
      personalShelfId: scope.kind === 'personal' ? scope.id : null,
      imageBase64: image.toString('base64'),
      bytes: image.length,
      createdAt: Date.now(),
      unusedSince: Date.now(),
    });
    return { id, width, height };
  });
}

export async function readPicture(
  userId: string,
  scope: PictureScope,
  assetId: string,
) {
  return cloudDb.transaction(async (tx) => {
    await pictureAccess(tx, userId, scope, false);
    const [asset] = await tx
      .select({ data: shelfPictureAssets.imageBase64 })
      .from(shelfPictureAssets)
      .where(and(scopeCondition(scope), eq(shelfPictureAssets.id, assetId)))
      .limit(1);
    if (!asset) return fail(404, 'Picture not found');
    if (scope.kind === 'collection') {
      const [membership] = await tx
        .select({ role: collectionMembers.role })
        .from(collectionMembers)
        .where(
          and(
            eq(collectionMembers.collectionId, scope.id),
            eq(collectionMembers.userId, userId),
          ),
        )
        .limit(1);
      if (membership?.role === 'viewer') {
        const [stored] = await tx
          .select({ arrangement: collectionBookshelves.arrangement })
          .from(collectionBookshelves)
          .where(eq(collectionBookshelves.collectionId, scope.id))
          .limit(1);
        const layout = parseBookshelf(stored?.arrangement);
        if (!layout?.pictures?.some((picture) => picture.assetId === assetId))
          return fail(404, 'Picture not found');
      }
    }
    return Buffer.from(asset.data, 'base64');
  });
}
