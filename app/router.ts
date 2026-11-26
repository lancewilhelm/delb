import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
} from 'vue-router';
import { useAuth } from '~/composables/useAuth';
import { $fetch } from '~/utils/apiFetch';

export type AuthMiddlewareOptions =
  | false
  | {
      only?: 'guest' | 'user';
      redirectUserTo?: string;
      redirectGuestTo?: string;
    };

declare module 'vue-router' {
  interface RouteMeta {
    auth?: AuthMiddlewareOptions;
    keyByFullPath?: boolean;
  }
}

const userOnly = {
  auth: {
    only: 'user' as const,
    redirectGuestTo: '/login',
  },
};

const guestOnly = {
  auth: {
    only: 'guest' as const,
    redirectUserTo: '/',
  },
};

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'index',
    component: () => import('~/pages/index.vue'),
    meta: userOnly,
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('~/pages/login.vue'),
    meta: guestOnly,
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('~/pages/register.vue'),
    meta: guestOnly,
  },
  {
    path: '/books',
    name: 'books',
    component: () => import('~/pages/books/index.vue'),
    meta: userOnly,
  },
  {
    path: '/books/new',
    name: 'books-new',
    component: () => import('~/pages/books/new.vue'),
    meta: userOnly,
  },
  {
    path: '/books/:id',
    name: 'books-id',
    component: () => import('~/pages/books/[id]/index.vue'),
    meta: userOnly,
  },
  {
    path: '/books/:id/edit',
    name: 'books-id-edit',
    component: () => import('~/pages/books/[id]/edit.vue'),
    meta: userOnly,
    beforeEnter: async (to) => {
      const auth = useAuth();
      await auth.fetchSession();

      const bookId = String(to.params.id || '');
      if (!bookId) return { path: '/', replace: true };

      try {
        const res = await $fetch<{
          success?: boolean;
          data?: { book?: { canEdit?: boolean } };
        }>(`/api/books/${encodeURIComponent(bookId)}`, { method: 'GET' });

        if (!res.data?.book?.canEdit) {
          return { path: '/', replace: true };
        }
      } catch {
        return { path: '/', replace: true };
      }
    },
  },
  {
    path: '/books/:id/read',
    name: 'books-id-read',
    component: () => import('~/pages/books/[id]/read.vue'),
    meta: {
      ...userOnly,
      keyByFullPath: true,
    },
  },
  {
    path: '/authors',
    name: 'authors',
    component: () => import('~/pages/authors/index.vue'),
    meta: userOnly,
  },
  {
    path: '/authors/:id',
    name: 'authors-id',
    component: () => import('~/pages/authors/[id].vue'),
    meta: userOnly,
  },
  {
    path: '/publishers',
    name: 'publishers',
    component: () => import('~/pages/publishers/index.vue'),
    meta: userOnly,
  },
  {
    path: '/publishers/:id',
    name: 'publishers-id',
    component: () => import('~/pages/publishers/[id].vue'),
    meta: userOnly,
  },
  {
    path: '/series',
    name: 'series',
    component: () => import('~/pages/series/index.vue'),
    meta: userOnly,
  },
  {
    path: '/series/:id',
    name: 'series-id',
    component: () => import('~/pages/series/[id].vue'),
    meta: userOnly,
  },
  {
    path: '/genres',
    name: 'genres',
    component: () => import('~/pages/genres/index.vue'),
    meta: userOnly,
  },
  {
    path: '/genres/:id',
    name: 'genres-id',
    component: () => import('~/pages/genres/[id].vue'),
    meta: userOnly,
  },
  {
    path: '/tags',
    name: 'tags',
    component: () => import('~/pages/tags/index.vue'),
    meta: userOnly,
  },
  {
    path: '/tags/:id',
    name: 'tags-id',
    component: () => import('~/pages/tags/[id].vue'),
    meta: userOnly,
  },
  {
    path: '/shelves',
    name: 'shelves',
    component: () => import('~/pages/shelves/index.vue'),
    meta: userOnly,
  },
  {
    path: '/shelves/:id',
    name: 'shelves-id',
    component: () => import('~/pages/shelves/[id].vue'),
    meta: userOnly,
  },
  {
    path: '/to-be-read',
    name: 'to-be-read',
    component: () => import('~/pages/to-be-read.vue'),
    meta: userOnly,
  },
  {
    path: '/settings/:page(.*)*',
    name: 'settings',
    component: () => import('~/pages/settings/[...page].vue'),
    meta: userOnly,
    beforeEnter: (to) => {
      const page = to.params.page;
      const segments = Array.isArray(page)
        ? page.filter(Boolean)
        : typeof page === 'string' && page
          ? page.split('/').filter(Boolean)
          : [];
      if (segments.length === 0) {
        return '/settings/general';
      }
      if (segments.length === 1 && segments[0] === 'admin') {
        return '/settings/admin/library';
      }
    },
  },
  {
    path: '/dev/infinite-scroll',
    name: 'dev-infinite-scroll',
    component: () => import('~/pages/dev/infinite-scroll.vue'),
    meta: userOnly,
  },
  {
    path: '/404',
    name: 'not-found',
    component: () => import('~/pages/404.vue'),
    meta: { auth: false },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'catch-all',
    component: () => import('~/pages/404.vue'),
    meta: { auth: false },
  },
];

export function createAppRouter() {
  const router = createRouter({
    history: createWebHistory(),
    routes,
  });

  router.beforeEach(async (to) => {
    if (to.meta?.auth === false) {
      return;
    }

    const { loggedIn, options, sessionInitialized, fetchSession } = useAuth();
    if (!sessionInitialized.value) {
      await fetchSession();
    }
    const routeAuth =
      to.meta?.auth && typeof to.meta.auth === 'object' ? to.meta.auth : {};
    const only = routeAuth.only;
    const redirectUserTo = routeAuth.redirectUserTo ?? options.redirectUserTo;
    const redirectGuestTo =
      routeAuth.redirectGuestTo ?? options.redirectGuestTo;

    if (!loggedIn.value) {
      try {
        const userCount = await $fetch<number>('/api/auth/user-count');
        if (userCount === 0 && to.path !== '/register') {
          return '/register';
        }
      } catch {
        // Ignore transient errors and let normal route handling proceed.
      }
    }

    if (only === 'guest' && loggedIn.value) {
      if (to.path === redirectUserTo) return;
      return redirectUserTo;
    }

    if (!loggedIn.value && only === 'user') {
      if (to.path === redirectGuestTo) return;
      return redirectGuestTo;
    }
  });

  return router;
}
