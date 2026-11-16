import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { auth } from '~/utils/auth';
import { authors, bookAuthors, books } from '~/utils/db/schema';
import { cloudDb } from '~~/server/utils/db/cloud';
import { assertBookEditor } from '~~/server/utils/collections/model';
import { cacheBoundedRequestBody } from '~~/server/utils/books/storage/bounded-upload';
import { readBoundedFile } from '~~/server/utils/books/storage/bounded-file';
import { resolveBookCoverFile } from '~~/server/utils/books/cover-delivery';
import {
  getConnection,
  isCurrentConnection,
} from '~~/server/utils/codex-image/connection';
import { renderSpine } from '~~/server/utils/books/spine-image';
import { defaultSpineEdits } from '~~/shared/spine-artwork';

const maxBytes = 10 * 1024 * 1024;
async function normalize(bytes: Buffer) {
  if (!bytes.length || bytes.length > maxBytes)
    throw new Error('Image too large');
  const image = sharp(bytes, { limitInputPixels: 24_000_000, animated: false });
  const metadata = await image.metadata();
  if (
    !['jpeg', 'png', 'webp', 'heif', 'tiff', 'gif'].includes(
      metadata.format ?? '',
    ) ||
    (metadata.pages ?? 1) > 1
  )
    throw new Error('Unsupported image');
  return await image
    .rotate()
    .resize({
      width: 2048,
      height: 2048,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
}
function accountHeaders(token: string): Record<string, string> {
  try {
    const parts = token.split('.');
    const claims: unknown = JSON.parse(
      Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'),
    );
    if (
      !claims ||
      typeof claims !== 'object' ||
      !('https://api.openai.com/auth' in claims)
    )
      return {};
    const data = claims['https://api.openai.com/auth'];
    if (!data || typeof data !== 'object') return {};
    const headers: Record<string, string> = {};
    if (
      'chatgpt_account_id' in data &&
      typeof data.chatgpt_account_id === 'string'
    )
      headers['ChatGPT-Account-ID'] = data.chatgpt_account_id;
    const residency =
      'chatgpt_data_residency' in data
        ? data.chatgpt_data_residency
        : 'chatgpt_compute_residency' in data
          ? data.chatgpt_compute_residency
          : null;
    if (typeof residency === 'string')
      headers['x-openai-internal-codex-residency'] = residency;
    return headers;
  } catch {
    return {};
  }
}
async function limitedBody(response: Response) {
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 16 * 1024 * 1024) {
      await reader.cancel();
      throw new Error('Response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export default defineEventHandler(async (event) => {
  if (
    ['cross-site', 'same-site'].includes(
      getHeader(event, 'sec-fetch-site') ?? '',
    )
  )
    throw createError({
      statusCode: 403,
      statusMessage: 'Cross-site requests are not allowed.',
    });
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({
      statusCode: 401,
      statusMessage: 'Sign in to Delb first.',
    });
  const bookId = getRouterParam(event, 'id');
  if (!bookId)
    throw createError({ statusCode: 400, statusMessage: 'Missing book.' });
  await assertBookEditor(cloudDb, session.user.id, bookId);
  await cacheBoundedRequestBody(
    event.node.req,
    event.node.res,
    maxBytes + 64 * 1024,
  );
  const parts = await readMultipartFormData(event);
  const prompt =
    parts
      ?.find((part) => part.name === 'prompt')
      ?.data.toString('utf8')
      .trim() ?? '';
  const previous = parts?.find((part) => part.name === 'previous')?.data;
  if (prompt.length > 2000)
    throw createError({
      statusCode: 400,
      statusMessage: 'Keep instructions under 2,000 characters.',
    });
  const cover = await resolveBookCoverFile({
    event,
    bookId,
    variant: 'source',
  });
  let images: Buffer[];
  let coverHash: string;
  try {
    const coverBytes = await readBoundedFile(cover.absPath, maxBytes);
    coverHash = createHash('sha256').update(coverBytes).digest('hex');
    images = [await normalize(coverBytes)];
    if (previous) images.push(await normalize(previous));
  } catch {
    throw createError({
      statusCode: 400,
      statusMessage:
        'The cover or preview must be a static image under 10 MB and 24 megapixels.',
    });
  }
  const [book] = await cloudDb
    .select({ title: books.title })
    .from(books)
    .where(eq(books.id, bookId));
  if (!book)
    throw createError({ statusCode: 404, statusMessage: 'Book not found.' });
  const bookAuthorRows = await cloudDb
    .select({ name: authors.name })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(eq(bookAuthors.bookId, bookId))
    .orderBy(bookAuthors.position);
  const connection = await getConnection();
  await assertBookEditor(cloudDb, session.user.id, bookId);
  if (!(await isCurrentConnection(connection.generation)))
    throw createError({
      statusCode: 409,
      statusMessage: 'ChatGPT connection changed. Try again.',
    });
  const instructions = `Create a flat, straight-on book spine design inspired by the first reference image, which is the book's cover. The title is ${JSON.stringify(book.title)} and the author names are ${JSON.stringify(bookAuthorRows.map((row) => row.name))}. This is for personal use in a private library and is not for distribution. Make the artwork a single narrow vertical spine with approximately 1:3 width-to-height proportions, readable title and author, no perspective, no book mockup, and no surrounding front cover. Keep all important artwork and lettering within the spine. ${previous ? 'The second reference is the current spine draft; revise it according to the following instructions while retaining its design where possible.' : 'Use the cover to match the visual style and colors.'}\nAdditional instructions: ${prompt || 'Match the cover faithfully.'}`;
  let image: Buffer;
  let failure =
    'ChatGPT could not generate the spine. Your account may not support this experimental feature, or the service may be unavailable.';
  try {
    const response = await fetch(
      'https://chatgpt.com/backend-api/codex/images/edits',
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(300_000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${connection.accessToken}`,
          'User-Agent': 'Delb/0.1',
          originator: 'delb',
          'x-codex-image-turn-id': randomUUID(),
          ...accountHeaders(connection.accessToken),
        },
        body: JSON.stringify({
          model: 'gpt-image-2',
          prompt: instructions,
          n: 1,
          quality: 'medium',
          size: '1024x1536',
          background: 'opaque',
          images: images.map((bytes) => ({
            image_url: `data:image/png;base64,${bytes.toString('base64')}`,
          })),
        }),
      },
    );
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        failure =
          'ChatGPT rejected this request. Ask an administrator to reconnect or check whether the account supports Codex image generation.';
      if (response.status === 429)
        failure = 'ChatGPT reached a usage limit. Try again later.';
      throw new Error('Provider rejected request');
    }
    const raw: unknown = JSON.parse(await limitedBody(response));
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('data' in raw) ||
      !Array.isArray(raw.data) ||
      !raw.data[0] ||
      typeof raw.data[0] !== 'object' ||
      !('b64_json' in raw.data[0]) ||
      typeof raw.data[0].b64_json !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data[0].b64_json)
    )
      throw new Error('Invalid provider result');
    image = Buffer.from(raw.data[0].b64_json, 'base64');
    await renderSpine(image, defaultSpineEdits());
  } catch {
    throw createError({
      statusCode: 502,
      statusMessage: failure,
    });
  }
  const latest = await auth.api.getSession({ headers: event.headers });
  if (!latest || latest.session.id !== session.session.id)
    throw createError({
      statusCode: 401,
      statusMessage: 'Your session expired.',
    });
  await assertBookEditor(cloudDb, session.user.id, bookId);
  if (!(await isCurrentConnection(connection.generation)))
    throw createError({
      statusCode: 409,
      statusMessage: 'ChatGPT connection changed. The preview was discarded.',
    });
  const currentCover = await resolveBookCoverFile({
    event,
    bookId,
    variant: 'source',
  });
  const currentCoverBytes = await readBoundedFile(
    currentCover.absPath,
    maxBytes,
  );
  if (
    createHash('sha256').update(currentCoverBytes).digest('hex') !== coverHash
  )
    throw createError({
      statusCode: 409,
      statusMessage:
        'The cover changed while generating. Generate again using the new cover.',
    });
  const info = await sharp(image).metadata();
  const mime =
    info.format === 'jpeg'
      ? 'image/jpeg'
      : info.format === 'webp'
        ? 'image/webp'
        : info.format === 'heif'
          ? 'image/avif'
          : 'image/png';
  setHeader(event, 'Cache-Control', 'private, no-store');
  setHeader(event, 'Vary', 'Cookie');
  setHeader(event, 'X-Content-Type-Options', 'nosniff');
  setHeader(event, 'Content-Type', mime);
  return image;
});
