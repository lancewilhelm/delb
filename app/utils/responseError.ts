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
