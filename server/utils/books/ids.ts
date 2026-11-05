export type ReaderId = string & { readonly idKind: 'reader' };
export type BookId = string & { readonly idKind: 'book' };

class InvalidIdError extends Error {
  statusCode = 400;
}

function isReaderId(value: unknown): value is ReaderId {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBookId(value: unknown): value is BookId {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseReaderId(value: unknown): ReaderId {
  if (!isReaderId(value)) throw new InvalidIdError('Missing reader id');
  return value;
}

export function parseBookId(value: unknown): BookId {
  if (!isBookId(value)) throw new InvalidIdError('Missing book id');
  return value;
}
