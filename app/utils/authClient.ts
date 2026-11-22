export interface Session {
  id: string;
  token?: string;
  userId: string;
  expiresAt: string | Date;
  createdAt: string | Date;
  updatedAt: string | Date;
  ipAddress?: string | null;
  userAgent?: string | null;
  impersonatedBy?: string | null;
}

export interface User {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  banExpires?: string | Date | null;
}

export interface AuthError {
  message: string;
  code?: string;
  status?: number;
}

export interface AuthResult<T = unknown> {
  data: T | null;
  error: AuthError | null;
}

export interface SessionPayload {
  session: Session;
  user: User;
}

export interface ListUsersPayload {
  users: User[];
  total?: number;
  limit?: number;
  offset?: number;
}

export type AuthFetcher = <T>(
  url: string,
  options?: {
    method?: 'GET' | 'POST';
    body?: Record<string, unknown>;
    query?: Record<string, string | number | boolean | undefined>;
    credentials?: RequestCredentials;
  },
) => Promise<T>;

export function extractAuthError(err: unknown): AuthError {
  if (!err || typeof err !== 'object') {
    return { message: typeof err === 'string' ? err : 'Request failed' };
  }

  const record = err as {
    data?: unknown;
    statusCode?: unknown;
    status?: unknown;
    response?: { status?: unknown; _data?: unknown };
    message?: unknown;
  };

  const payload =
    record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : record.response?._data && typeof record.response._data === 'object'
        ? (record.response._data as Record<string, unknown>)
        : undefined;

  const status =
    typeof record.statusCode === 'number'
      ? record.statusCode
      : typeof record.status === 'number'
        ? record.status
        : typeof record.response?.status === 'number'
          ? record.response.status
          : undefined;

  const code = typeof payload?.code === 'string' ? payload.code : undefined;
  const message =
    typeof payload?.message === 'string' && payload.message.trim()
      ? payload.message
      : typeof payload?.error === 'string' && payload.error.trim()
        ? payload.error
        : typeof record.message === 'string' && record.message.trim()
          ? record.message
          : 'Request failed';

  return { message, code, status };
}

export function createDelbAuthClient(fetcher: AuthFetcher) {
  async function request<T>(
    path: string,
    options?: {
      method?: 'GET' | 'POST';
      body?: Record<string, unknown>;
      query?: Record<string, string | number | boolean | undefined>;
    },
  ): Promise<AuthResult<T>> {
    try {
      const data = await fetcher<T>(`/api/auth${path}`, {
        method: options?.method ?? 'GET',
        body: options?.body,
        query: options?.query,
        credentials: 'include',
      });
      return { data: data ?? null, error: null };
    } catch (err) {
      return { data: null, error: extractAuthError(err) };
    }
  }

  return {
    getSession: () => request<SessionPayload | null>('/get-session'),

    signIn: {
      email: (body: { email: string; password: string }) =>
        request<SessionPayload>('/sign-in/email', {
          method: 'POST',
          body,
        }),
    },

    signUp: {
      email: (body: { email: string; password: string; name: string }) =>
        request<SessionPayload>('/sign-up/email', {
          method: 'POST',
          body,
        }),
    },

    signOut: () =>
      request<{ success: boolean }>('/sign-out', {
        method: 'POST',
        body: {},
      }),

    changePassword: (body: {
      currentPassword: string;
      newPassword: string;
      revokeOtherSessions?: boolean;
    }) =>
      request<{ token?: string | null; user?: User }>('/change-password', {
        method: 'POST',
        body,
      }),

    changeEmail: (body: { newEmail: string; callbackURL?: string }) =>
      request<{ status: boolean; user?: User }>('/change-email', {
        method: 'POST',
        body,
      }),

    updateUser: (body: { name?: string; image?: string | null }) =>
      request<{ status: boolean }>('/update-user', {
        method: 'POST',
        body,
      }),

    admin: {
      listUsers: (options?: {
        query?: {
          limit?: number;
          offset?: number;
          searchValue?: string;
        };
      }) =>
        request<ListUsersPayload>('/admin/list-users', {
          method: 'GET',
          query: options?.query,
        }),

      createUser: (body: {
        email: string;
        password: string;
        name: string;
        role?: string;
      }) =>
        request<{ user: User }>('/admin/create-user', {
          method: 'POST',
          body,
        }),

      removeUser: (body: { userId: string }) =>
        request<{ success: boolean }>('/admin/remove-user', {
          method: 'POST',
          body,
        }),

      banUser: (body: {
        userId: string;
        banReason?: string;
        banExpiresIn?: number;
      }) =>
        request<{ user: User }>('/admin/ban-user', {
          method: 'POST',
          body,
        }),

      unbanUser: (body: { userId: string }) =>
        request<{ user: User }>('/admin/unban-user', {
          method: 'POST',
          body,
        }),

      updateUser: (body: { userId: string; data: Record<string, unknown> }) =>
        request<User>('/admin/update-user', {
          method: 'POST',
          body,
        }),

      setUserPassword: (body: { userId: string; newPassword: string }) =>
        request<{ status: boolean }>('/admin/set-user-password', {
          method: 'POST',
          body,
        }),
    },
  };
}
