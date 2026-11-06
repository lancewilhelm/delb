import type { H3Event } from 'h3';
import { auth } from '../../../app/utils/auth';
import { CollectionError } from './model';

export async function collectionActor(event: H3Event) {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) throw new CollectionError(401, 'Unauthorized');
  return session.user;
}

export function requiredCollectionId(event: H3Event) {
  const id = event.context.params?.id;
  if (!id) throw new CollectionError(400, 'Collection id is required');
  return id;
}

export function collectionName(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120)
    throw new CollectionError(
      400,
      'Enter a collection name of 1 to 120 characters',
    );
  return value.trim();
}

export function memberEmail(value: unknown) {
  if (typeof value !== 'string' || !value.trim())
    throw new CollectionError(400, 'An existing user email is required');
  return value.trim().toLowerCase();
}
