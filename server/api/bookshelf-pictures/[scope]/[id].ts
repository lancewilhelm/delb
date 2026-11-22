import { auth } from '~~/server/utils/auth';
import { cacheBoundedRequestBody } from '~~/server/utils/books/storage/bounded-upload';
import {
  pictureAccess,
  readPicture,
  uploadPicture,
  type PictureScope,
} from '~~/server/utils/bookshelf/pictures';
import { cloudDb } from '~~/server/utils/db/cloud';

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const kind = getRouterParam(event, 'scope');
  const id = getRouterParam(event, 'id');
  if ((kind !== 'collection' && kind !== 'personal') || !id)
    throw createError({ statusCode: 404, statusMessage: 'Shelf not found' });
  const scope: PictureScope = { kind, id };
  setHeader(event, 'Cache-Control', 'private, no-store');
  setHeader(event, 'X-Content-Type-Options', 'nosniff');
  setHeader(event, 'Vary', 'Cookie');
  if (event.method === 'GET') {
    const assetId = getQuery(event).asset;
    if (typeof assetId !== 'string')
      throw createError({ statusCode: 400, statusMessage: 'Picture required' });
    const image = await readPicture(session.user.id, scope, assetId);
    setHeader(event, 'Content-Type', 'image/webp');
    return image;
  }
  if (event.method !== 'POST')
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' });
  await cloudDb.transaction((tx) =>
    pictureAccess(tx, session.user.id, scope, true),
  );
  await cacheBoundedRequestBody(
    event.node.req,
    event.node.res,
    11 * 1024 * 1024,
  );
  const parts = await readMultipartFormData(event);
  const file = parts?.find((part) => part.name === 'file' && part.filename);
  if (!file)
    throw createError({ statusCode: 400, statusMessage: 'Choose a picture' });
  return uploadPicture(session.user.id, scope, file.data);
});
