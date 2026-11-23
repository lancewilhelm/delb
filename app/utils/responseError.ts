/** Read an API failure without replacing its useful message with a generic one. */
export async function readResponseError(
  response: Response,
  fallback: string,
): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text.trim()) return fallback;

  try {
    const payload: unknown = JSON.parse(text);
    if (typeof payload !== 'object' || payload === null) return fallback;
    const error = payload as { statusMessage?: unknown; message?: unknown };
    for (const message of [error.statusMessage, error.message]) {
      if (typeof message === 'string' && message.trim()) return message;
    }
    return fallback;
  } catch {
    return text;
  }
}

/** Extract the server-provided error message from an ofetch/FetchError or Error. */
export function extractFetchErrorMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const err = error as {
    data?: unknown;
    statusMessage?: unknown;
    message?: unknown;
  };
  if (typeof err.data === 'object' && err.data !== null) {
    const data = err.data as { message?: unknown; statusMessage?: unknown };
    for (const message of [data.message, data.statusMessage]) {
      if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
    }
  }
  if (typeof err.statusMessage === 'string' && err.statusMessage.trim()) {
    return err.statusMessage.trim();
  }
  if (typeof err.message === 'string' && err.message.trim()) {
    return err.message.trim();
  }
  return null;
}
