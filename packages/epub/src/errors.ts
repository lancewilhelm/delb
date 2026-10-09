import type { EpubErrorCode } from './types.js';

export class EpubError extends Error {
  readonly code: EpubErrorCode;
  readonly cause?: unknown;

  constructor(
    code: EpubErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'EpubError';
    this.code = code;
    this.cause = options?.cause;
  }
}

export function invalidEpub(message: string, cause?: unknown): EpubError {
  return new EpubError('INVALID_EPUB', message, { cause });
}
