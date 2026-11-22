import { auth } from '~~/server/utils/auth';
import { cloudDb } from '~~/server/utils/db/cloud';
import { assertCollectionAdmin } from '~~/server/utils/collections/model';
import { cacheBoundedRequestBody } from '~~/server/utils/books/storage/bounded-upload';
import {
  readSpineGenerationPrompt,
  saveSpineGenerationPrompt,
} from '~~/server/utils/spine-generation/prompt';
import {
  defaultSpineGenerationPrompt,
  maxSpinePromptLength,
  validSpineGenerationPrompt,
} from '~~/shared/spine-generation-prompt';

export default defineEventHandler(async (event) => {
  if (
    event.method !== 'GET' &&
    ['cross-site', 'same-site'].includes(
      getHeader(event, 'sec-fetch-site') ?? '',
    )
  ) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Cross-site requests are not allowed.',
    });
  }
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({
      statusCode: 401,
      statusMessage: 'Sign in to Delb first.',
    });
  await assertCollectionAdmin(cloudDb, session.user.id);
  setHeader(event, 'Cache-Control', 'private, no-store');
  setHeader(event, 'Vary', 'Cookie');
  if (event.method === 'GET') return await readSpineGenerationPrompt();
  if (event.method !== 'PUT')
    throw createError({
      statusCode: 405,
      statusMessage: 'Method not allowed.',
    });
  await cacheBoundedRequestBody(event.node.req, event.node.res, 256 * 1024);
  const body: unknown = await readBody(event);
  if (
    !body ||
    typeof body !== 'object' ||
    !('prompt' in body) ||
    !('previous' in body) ||
    !validSpineGenerationPrompt(body.prompt) ||
    !(
      body.previous === null ||
      (typeof body.previous === 'string' &&
        body.previous.length <= maxSpinePromptLength)
    )
  ) {
    throw createError({
      statusCode: 400,
      statusMessage:
        'Enter a prompt of at most 12,000 characters containing all four required placeholders.',
    });
  }
  const current = await auth.api.getSession({ headers: event.headers });
  if (!current || current.session.id !== session.session.id)
    throw createError({
      statusCode: 401,
      statusMessage: 'Your session expired.',
    });
  await assertCollectionAdmin(cloudDb, session.user.id);
  if (!(await saveSpineGenerationPrompt(body.prompt, body.previous))) {
    throw createError({
      statusCode: 409,
      statusMessage:
        'The prompt changed since you opened it. Reload before saving.',
    });
  }
  return {
    prompt: body.prompt,
    savedPrompt: body.prompt,
    defaultPrompt: defaultSpineGenerationPrompt,
  };
});
