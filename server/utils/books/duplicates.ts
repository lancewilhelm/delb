import { eq, inArray, sql } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  authors,
  bookAuthors,
  bookIdentifiers,
  books,
} from '~/utils/db/schema';

export type IdentifierInput = { type: string; value: string };

export type DuplicateMatchType = 'identifier' | 'fuzzy';

export type DuplicateCandidate = {
  matchType: DuplicateMatchType;
  score: number; // 0..1
  book: {
    id: string;
    title: string;
    coverImagePath: string | null;
    authorNames: string[];
    identifiers: IdentifierInput[];
  };
};

function normalizeSpaces(input: string): string {
  return (input ?? '').toString().replace(/\s+/g, ' ').trim();
}

function normalizeIdentifierValue(type: string, value: string): string {
  const t = (type ?? '').toString().trim().toLowerCase();
  const v = (value ?? '').toString().trim();
  if (!v) return '';

  if (t === 'isbn') {
    // Accept common ISBN formatting variants.
    return v.replace(/[^0-9xX]/g, '').toUpperCase();
  }

  return v.toLowerCase();
}

function normalizeTextForTokens(input: string): string {
  return normalizeSpaces(input)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
}

export function fuzzyTokens(input: string): string[] {
  const stop = new Set(['the', 'a', 'an', 'and', 'of', 'to']);
  return normalizeTextForTokens(input)
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !stop.has(t));
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;

  let intersection = 0;
  for (const t of sa) {
    if (sb.has(t)) intersection++;
  }
  const union = sa.size + sb.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export const FUZZY_DUPLICATE_THRESHOLD = 0.82;

export function fuzzySeedToken(titleTokens: string[]): string | null {
  const seed = titleTokens.find((t) => t.length >= 3) ?? titleTokens[0];
  return seed ?? null;
}

export function fuzzyTitleAuthorScoreFromTokens(opts: {
  titleTokensA: string[];
  authorTokensA: string[];
  titleTokensB: string[];
  authorTokensB: string[];
}): number {
  const titleScore = jaccard(opts.titleTokensA, opts.titleTokensB);
  const authorScore = jaccard(opts.authorTokensA, opts.authorTokensB);
  return Math.max(0, Math.min(1, 0.75 * titleScore + 0.25 * authorScore));
}

async function loadBooksForCandidates(bookIds: string[]) {
  const ids = Array.from(new Set(bookIds)).filter(Boolean);
  if (!ids.length) return new Map<string, DuplicateCandidate['book']>();

  const bookRows = await cloudDb
    .select({
      id: books.id,
      title: books.title,
      coverImagePath: books.coverImagePath,
    })
    .from(books)
    .where(inArray(books.id, ids));

  const authorLinks = await cloudDb
    .select({
      bookId: bookAuthors.bookId,
      name: authors.name,
      position: bookAuthors.position,
    })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(inArray(bookAuthors.bookId, ids))
    // Keep deterministic ordering for display.
    .orderBy(sql`COALESCE(${bookAuthors.position}, 999) ASC`, authors.name);

  const identifiers = await cloudDb
    .select({
      bookId: bookIdentifiers.bookId,
      type: bookIdentifiers.type,
      value: bookIdentifiers.value,
    })
    .from(bookIdentifiers)
    .where(inArray(bookIdentifiers.bookId, ids))
    .orderBy(bookIdentifiers.type, bookIdentifiers.value);

  const authorNamesByBookId = new Map<string, string[]>();
  for (const row of authorLinks) {
    const list = authorNamesByBookId.get(row.bookId) ?? [];
    list.push(row.name);
    authorNamesByBookId.set(row.bookId, list);
  }

  const identifiersByBookId = new Map<string, IdentifierInput[]>();
  for (const row of identifiers) {
    const list = identifiersByBookId.get(row.bookId) ?? [];
    list.push({ type: row.type, value: row.value });
    identifiersByBookId.set(row.bookId, list);
  }

  const out = new Map<string, DuplicateCandidate['book']>();
  for (const b of bookRows) {
    out.set(b.id, {
      id: b.id,
      title: b.title,
      coverImagePath: b.coverImagePath ?? null,
      authorNames: authorNamesByBookId.get(b.id) ?? [],
      identifiers: identifiersByBookId.get(b.id) ?? [],
    });
  }

  return out;
}

export async function findPossibleDuplicates(opts: {
  title: string;
  author: string;
  identifiers?: IdentifierInput[];
  maxCandidates?: number;
}): Promise<DuplicateCandidate[]> {
  const maxCandidates = Math.max(1, Math.min(25, opts.maxCandidates ?? 8));

  const title = normalizeSpaces(opts.title);
  const author = normalizeSpaces(opts.author);

  const candidates: DuplicateCandidate[] = [];
  const seenBookIds = new Set<string>();

  // 1) Identifier matches (strong).
  const idInputs = (opts.identifiers ?? [])
    .map((i) => ({
      type: normalizeSpaces(i.type).toLowerCase(),
      valueNorm: normalizeIdentifierValue(i.type, i.value),
    }))
    .filter((i) => i.type && i.valueNorm);

  for (const ident of idInputs) {
    if (candidates.length >= maxCandidates) break;

    const rows = await cloudDb
      .select({ bookId: bookIdentifiers.bookId, value: bookIdentifiers.value })
      .from(bookIdentifiers)
      .where(eq(bookIdentifiers.type, ident.type))
      // Keep bounded to avoid scanning unbounded rows for common identifier types.
      .limit(2000);

    const bookIds = rows
      .filter(
        (r) =>
          normalizeIdentifierValue(ident.type, r.value) ===
          normalizeIdentifierValue(ident.type, ident.valueNorm),
      )
      .map((r) => r.bookId)
      .filter(Boolean);
    const bookMap = await loadBooksForCandidates(bookIds);

    for (const id of bookIds) {
      if (candidates.length >= maxCandidates) break;
      if (seenBookIds.has(id)) continue;
      const book = bookMap.get(id);
      if (!book) continue;
      seenBookIds.add(id);
      candidates.push({ matchType: 'identifier', score: 1, book });
    }
  }

  if (candidates.length >= maxCandidates) return candidates;

  // 2) Fuzzy title+author (weak).
  const titleTokens = fuzzyTokens(title);
  const authorTokens = fuzzyTokens(author);

  const seedToken = fuzzySeedToken(titleTokens);
  if (!seedToken) return candidates;

  const like = `%${seedToken}%`;

  const titleMatches = await cloudDb
    .select({ id: books.id })
    .from(books)
    .where(sql`LOWER(${books.title}) LIKE ${like.toLowerCase()}`)
    .limit(50);

  const bookIds = titleMatches.map((r) => r.id).filter(Boolean);
  const bookMap = await loadBooksForCandidates(bookIds);

  const scored: DuplicateCandidate[] = [];
  for (const id of bookIds) {
    if (seenBookIds.has(id)) continue;
    const book = bookMap.get(id);
    if (!book) continue;

    const ct = fuzzyTokens(book.title);
    const ca = fuzzyTokens(book.authorNames.join(' '));

    const score = fuzzyTitleAuthorScoreFromTokens({
      titleTokensA: titleTokens,
      authorTokensA: authorTokens,
      titleTokensB: ct,
      authorTokensB: ca,
    });

    // Keep this conservative; the UI can show "possible" duplicates.
    if (score >= FUZZY_DUPLICATE_THRESHOLD) {
      scored.push({ matchType: 'fuzzy', score, book });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  for (const c of scored) {
    if (candidates.length >= maxCandidates) break;
    seenBookIds.add(c.book.id);
    candidates.push(c);
  }

  return candidates;
}
