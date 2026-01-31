type NormalizedAuthError = {
  message: string;
  code?: string;
  status?: number;
};

function normalizeAuthError(error: unknown): NormalizedAuthError {
  if (!error) return { message: '' };

  if (typeof error === 'string') return { message: error };

  if (typeof error === 'object') {
    const maybe = error as Record<string, unknown>;
    const message =
      typeof maybe.message === 'string'
        ? maybe.message
        : typeof maybe.error === 'string'
          ? maybe.error
          : '';
    const code = typeof maybe.code === 'string' ? maybe.code : undefined;
    const status =
      typeof maybe.status === 'number'
        ? maybe.status
        : typeof maybe.statusCode === 'number'
          ? maybe.statusCode
          : undefined;

    return { message, code, status };
  }

  return { message: '' };
}

function looksLikeRateLimit(err: NormalizedAuthError) {
  return (
    err.status === 429 ||
    /rate limit|too many/i.test(err.message) ||
    /429\b/.test(err.message)
  );
}

export function getRegisterErrorMessage(error: unknown): string {
  const err = normalizeAuthError(error);
  const msg = err.message || '';

  if (looksLikeRateLimit(err)) {
    return 'Too many attempts. Please wait a moment and try again.';
  }

  if (/registration is closed/i.test(msg)) {
    return 'Registration is currently closed. Please contact an administrator.';
  }

  if (
    /already exists/i.test(msg) ||
    /duplicate/i.test(msg) ||
    /unique constraint/i.test(msg)
  ) {
    return 'An account with that email already exists. Try logging in instead.';
  }

  if (/password/i.test(msg) && /at least|minimum|min/i.test(msg)) {
    return 'Password is too short. Please choose a longer password.';
  }

  return msg || 'Failed to create account. Please try again.';
}

export function getLoginErrorMessage(error: unknown): string {
  const err = normalizeAuthError(error);
  if (looksLikeRateLimit(err)) {
    return 'Too many login attempts. Please wait a moment and try again.';
  }

  // Avoid leaking details for auth failures (treat most as invalid creds).
  return 'Invalid email or password. Please try again.';
}
