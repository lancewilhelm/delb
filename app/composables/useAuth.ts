import { defu } from 'defu';
import type { RouteLocationRaw } from 'vue-router';
import {
  createDelbAuthClient,
  type AuthFetcher,
  type Session,
  type SessionPayload,
  type User,
} from '~/utils/authClient';

interface RuntimeAuthConfig {
  redirectUserTo: RouteLocationRaw | string;
  redirectGuestTo: RouteLocationRaw | string;
}

const PERSISTED_USER_STORES = [
  'delb.userSettings',
  'delb.globalSettings',
  'delb.ui',
  'delb.collections',
  'delb.booksIndexFilters',
];

let inFlightSessionFetch: Promise<SessionPayload | null> | null = null;

function clearUserStoresAndStorage(clearAuthUserId: boolean) {
  const userSettingsStore = useUserSettingsStore();
  const globalSettingsStore = useGlobalSettingsStore();
  const uiStore = useUiStore();
  const collectionsStore = useCollectionsStore();

  userSettingsStore.$reset();
  globalSettingsStore.$reset();
  uiStore.$reset();
  collectionsStore.$reset();
  useBooksIndexFiltersStore().clearAll();

  if (typeof localStorage !== 'undefined') {
    for (const key of PERSISTED_USER_STORES) {
      localStorage.removeItem(key);
    }
    if (clearAuthUserId) {
      localStorage.removeItem('delb.authUserId');
    }
  }
}

export function useAuth() {
  const client = createDelbAuthClient($fetch as unknown as AuthFetcher);

  const options = defu(
    useRuntimeConfig().public.auth as Partial<RuntimeAuthConfig>,
    {
      redirectUserTo: '/',
      redirectGuestTo: '/login',
    },
  );
  const session = useState<Session | null>('auth:session', () => null);
  const user = useState<User | null>('auth:user', () => null);
  const sessionFetching = useState('auth:sessionFetching', () => false);

  const fetchSession = async (): Promise<SessionPayload | null> => {
    if (inFlightSessionFetch) {
      return inFlightSessionFetch;
    }

    sessionFetching.value = true;
    inFlightSessionFetch = (async () => {
      try {
        const { data } = await client.getSession();
        session.value = data?.session ?? null;
        user.value = data?.user ?? null;

        if (typeof localStorage !== 'undefined') {
          const nextUserId = data?.user?.id;
          if (nextUserId) {
            const key = 'delb.authUserId';
            const prevUserId = localStorage.getItem(key);
            if (prevUserId && prevUserId !== nextUserId) {
              // User switched accounts in the same browser. Clear persisted state so we don't
              // leak preferences/UI state between accounts.
              clearUserStoresAndStorage(false);
            }
            localStorage.setItem(key, nextUserId);
          }
        }

        return data;
      } finally {
        sessionFetching.value = false;
        inFlightSessionFetch = null;
      }
    })();

    return inFlightSessionFetch;
  };

  async function signOut() {
    // Close any global UI before navigation.
    const uiStore = useUiStore();
    uiStore.setCommandPaletteVisible(false);
    uiStore.setGlobalSearchVisible(false);

    const res = await client.signOut();
    session.value = null;
    user.value = null;

    clearUserStoresAndStorage(true);

    await navigateTo('/login', { replace: true });

    return res;
  }

  return {
    session,
    user,
    loggedIn: computed(() => !!session.value),
    signIn: client.signIn,
    signUp: client.signUp,
    admin: client.admin,
    isAdmin: computed(() => {
      if (!user.value) return false;
      return user.value.role === 'admin' || user.value.role === 'owner';
    }),
    changePassword: client.changePassword,
    changeEmail: client.changeEmail,
    updateUser: client.updateUser,
    signOut,
    options,
    fetchSession,
    client,
  };
}
