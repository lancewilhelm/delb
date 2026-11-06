import { users } from '../../app/utils/db/schema';
import { cloudDb } from '../utils/db/cloud';
import {
  collectionModelState,
  CollectionError,
} from '../utils/collections/model';

export default defineEventHandler(async (event) => {
  const pathname = getRequestURL(event).pathname;
  if (!pathname.startsWith('/api/')) return;
  if ((await collectionModelState(cloudDb)) === 'exclusive') return;
  if (pathname === '/api/settings/admin/collections-migration') return;
  if (
    pathname.endsWith('/sign-up/email') &&
    !(await cloudDb.select({ id: users.id }).from(users).limit(1)).length
  )
    return;
  if (
    pathname.startsWith('/api/auth/') &&
    (event.method === 'GET' ||
      pathname.endsWith('/sign-in/email') ||
      pathname.endsWith('/sign-out'))
  )
    return;
  if (
    event.method === 'GET' &&
    (pathname === '/api/settings/user' || pathname === '/api/settings/global')
  )
    return;
  throw new CollectionError(
    503,
    'Collection migration required. An administrator must preview and apply it in Settings > Admin > Collections.',
  );
});
