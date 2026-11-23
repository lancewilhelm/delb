import { computed, ref } from 'vue';
import { useBooksIndexFiltersStore } from '~/stores/booksIndexFilters';
import { useCollectionsStore } from '~/stores/collections';
import { useGlobalSettingsStore } from '~/stores/globalSettings';
import { useUiStore } from '~/stores/ui';
import { useUserSettingsStore } from '~/stores/userSettings';
import { $fetch } from '~/utils/apiFetch';
import { clearBookPreviewCache } from '~/utils/bookPreviewCache';
import { clearDashboardCache } from '~/utils/dashboardCache';
import {
  createDelbAuthClient,
  type AuthFetcher,
  type Session,
  type SessionPayload,
  type User,
} from '~/utils/authClient';
import { navigateTo } from '~/utils/navigation';

export interface RuntimeAuthConfig {
  redirectUserTo: string;
  redirectGuestTo: string;
}

const DEFAULT_AUTH_OPTIONS: RuntimeAuthConfig = {
  redirectUserTo: '/',
  redirectGuestTo: '/login',
};

const PERSISTED_USER_STORES = [
  'delb.userSettings',
  'delb.globalSettings',
  'delb.ui',
  'delb.collections',
  'delb.booksIndexFilters',
];

const sessionState = ref<Session | null>(null);
const userState = ref<User | null>(null);
const sessionFetchingState = ref(false);
const sessionInitializedState = ref(false);
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
  clearBookPreviewCache();
  clearDashboardCache();

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
  const options = DEFAULT_AUTH_OPTIONS;

  const session = sessionState;
  const user = userState;
  const sessionFetching = sessionFetchingState;

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
        sessionInitializedState.value = true;
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
    sessionInitialized: sessionInitializedState,
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
