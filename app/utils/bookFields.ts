export const bookFieldCatalog = [
  { id: 'title', label: 'Title', width: 350, weight: 2 },
  { id: 'authors', label: 'Authors', width: 250, weight: 1.5 },
  { id: 'series', label: 'Series', width: 150, weight: 1 },
  { id: 'tags', label: 'Tags', width: 200, weight: 1 },
  { id: 'publisher', label: 'Publisher', width: 180, weight: 1 },
  { id: 'published', label: 'Publication date', width: 150, weight: 1 },
  { id: 'language', label: 'Language', width: 100, weight: 1 },
  { id: 'pages', label: 'Page count', width: 100, weight: 1 },
  { id: 'description', label: 'Description', width: 350, weight: 2 },
  { id: 'identifiers', label: 'Identifiers', width: 220, weight: 1 },
  { id: 'formats', label: 'File formats', width: 120, weight: 1 },
  { id: 'rating', label: 'My rating', width: 100, weight: 1 },
  { id: 'status', label: 'Reading status', width: 140, weight: 1 },
  { id: 'createdAt', label: 'Date added', width: 150, weight: 1 },
  { id: 'updatedAt', label: 'Date updated', width: 150, weight: 1 },
] as const;
export type BookFieldId = (typeof bookFieldCatalog)[number]['id'];
export type BookFieldPreference = { id: BookFieldId; visible: boolean };
export type BookViewMode = 'grid' | 'list';
export type BookFieldPart = { text: string; to?: string };

type Named = { id: string; name: string };
export type BookViewBook = {
  id: string;
  title: string;
  authors?: Named[];
  authorNames?: string[];
  author?: string;
  publisher?: Named | null;
  series?: Named | null;
  seriesIndex?: number | null;
  tags?: Named[];
  description?: string | null;
  published?: string | null;
  language?: string | null;
  pages?: number | null;
  identifiers?: { type: string; value: string }[];
  formats?: string[];
  rating?: number | null;
  status?: string | null;
  coverImagePath?: string | null;
  createdAt?: string | number | Date;
  updatedAt?: string | number | Date;
};

export function defaultBookFields(): BookFieldPreference[] {
  return bookFieldCatalog.map(({ id }) => ({
    id,
    visible: ['title', 'authors', 'series'].includes(id),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeBookFields(
  value: unknown,
  legacy?: unknown,
): BookFieldPreference[] {
  const defaults = defaultBookFields();
  if (!Array.isArray(value)) {
    if (isRecord(legacy)) {
      for (const field of defaults) {
        const flags: Partial<Record<BookFieldId, string>> = {
          title: 'showTitle',
          authors: 'showAuthors',
          series: 'showSeries',
        };
        const flag = flags[field.id];
        if (flag && typeof legacy[flag] === 'boolean')
          field.visible = legacy[flag];
      }
    }
    return defaults;
  }
  const result: BookFieldPreference[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const field = bookFieldCatalog.find((f) => f.id === entry.id);
    if (!field || result.some((f) => f.id === field.id)) continue;
    result.push({ id: field.id, visible: entry.visible === true });
  }
  for (const field of defaults) {
    if (!result.some((f) => f.id === field.id))
      result.push({ ...field, visible: false });
  }
  return result;
}

export function bookFieldDefinition(id: BookFieldId) {
  return bookFieldCatalog.find((f) => f.id === id)!;
}

export function bookColumnStyle(id: BookFieldId) {
  const field = bookFieldDefinition(id);
  return {
    flex: `${field.weight} 0 ${field.width}px`,
    width: `${field.width}px`,
    minWidth: '0',
  };
}

function dateLabel(value: BookViewBook['createdAt']): string {
  if (value === undefined || value === null || value === '') return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

export function bookFieldParts(
  book: BookViewBook,
  field: BookFieldId,
): BookFieldPart[] {
  const text = (value: string | number | null | undefined): BookFieldPart[] =>
    value === undefined || value === null || value === ''
      ? []
      : [{ text: String(value) }];
  const linked = (values: Named[], path: string): BookFieldPart[] =>
    values.flatMap((v, index) => [
      ...(index ? [{ text: ', ' }] : []),
      { text: v.name, to: `/${path}/${encodeURIComponent(v.id)}` },
    ]);
  switch (field) {
    case 'title':
      return [
        { text: book.title, to: `/books/${encodeURIComponent(book.id)}` },
      ];
    case 'authors':
      return book.authors?.length
        ? linked(book.authors, 'authors')
        : text(book.authorNames?.join(', ') || book.author);
    case 'series':
      return book.series
        ? [
            {
              text: `${book.series.name}${book.seriesIndex !== null && book.seriesIndex !== undefined ? ` #${book.seriesIndex}` : ''}`,
              to: `/series/${encodeURIComponent(book.series.id)}`,
            },
          ]
        : [];
    case 'tags':
      return linked(book.tags ?? [], 'tags');
    case 'publisher':
      return book.publisher ? linked([book.publisher], 'publishers') : [];
    case 'published':
      return text(book.published);
    case 'language':
      return text(book.language);
    case 'pages':
      return text(book.pages);
    case 'description':
      return text(book.description);
    case 'identifiers':
      return text(
        book.identifiers
          ?.map((v) => `${v.type.toUpperCase()}: ${v.value}`)
          .join(', '),
      );
    case 'formats':
      return text(book.formats?.map((v) => v.toUpperCase()).join(', '));
    case 'rating':
      return book.rating == null ? [] : text(`${book.rating / 2} / 5`);
    case 'status':
      return text(
        book.status
          ? ({
              to_be_read: 'To be read',
              reading: 'Reading',
              finished: 'Finished',
              dnf: 'Did not finish',
            }[book.status] ?? book.status)
          : null,
      );
    case 'createdAt':
      return text(dateLabel(book.createdAt));
    case 'updatedAt':
      return text(dateLabel(book.updatedAt));
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}
