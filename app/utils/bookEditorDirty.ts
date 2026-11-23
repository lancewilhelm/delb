export type BookIdentifierRow = {
  type: string;
  value: string;
};

export type BookEditorBaseline = {
  title?: string | null;
  description?: string | null;
  published?: string | null;
  language?: string | null;
  pages?: number | null;
  authors?: { id?: string; name: string; position?: number | null }[] | null;
  tags?: { id?: string; name: string }[] | null;
  publisher?: { id?: string; name: string } | null;
  series?: { id?: string; name: string; index?: number | null } | null;
  identifiers?: BookIdentifierRow[] | null;
};

export type BookEditorFormState = {
  title: string;
  description: string;
  published: string;
  language: string;
  pages: string;
  publisher: string;
  series: string;
  seriesIndex: string;
  identifiers: string;
};

export type BookEditorDirtyInput = {
  baseline: BookEditorBaseline | null;
  form: BookEditorFormState;
  authorChips: { name: string }[];
  authorInput: string;
  tagChips: { name: string }[];
  tagInput: string;
  identifierTypeInput: string;
  identifierValueInput: string;
  hasSelectedCoverFile: boolean;
  coverResetPending: boolean;
  spineChanged: boolean;
  spineGenerating: boolean;
};

export type BookEditorLeaveGuardState = {
  hasUnsavedChanges: boolean;
  spineGenerating: boolean;
  saving: boolean;
};

export type BookEditorLeavePrompt = {
  title: string;
  message: string;
  discardLabel: string;
  stayLabel: string;
  canSaveAndLeave: boolean;
  saveAndLeaveLabel: string;
};

export type BookEditorLeavePromptOptions = BookEditorLeaveGuardState & {
  isCreateMode?: boolean;
  canSave?: boolean;
};

export function normalizeIdentifierType(input: string): string {
  return (input ?? '').toString().trim().toLowerCase();
}

export function normalizeIdentifierValue(input: string): string {
  // Keep lean: trim and strip spaces/hyphens for ISBN values if pasted formatted.
  const value = (input ?? '').toString().trim();
  return value.replace(/[\s-]+/g, '');
}

export function parseIdentifierRows(input: string): BookIdentifierRow[] {
  const lines = (input ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const rows: BookIdentifierRow[] = [];

  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const type = normalizeIdentifierType(line.slice(0, idx));
      const value = normalizeIdentifierValue(line.slice(idx + 1));
      if (type && value) rows.push({ type, value });
      continue;
    }

    // Allow raw ISBN pasted as a line; treat as unknown type.
    const value = normalizeIdentifierValue(line);
    if (value) rows.push({ type: 'isbn', value });
  }

  // De-dupe by (type,value) case-insensitively.
  const seen = new Set<string>();
  const out: BookIdentifierRow[] = [];
  for (const row of rows) {
    const key = `${row.type}:${row.value}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function serializeIdentifierRows(rows: BookIdentifierRow[]): string {
  return (rows ?? [])
    .map((row) => {
      const type = normalizeIdentifierType(row.type);
      const value = normalizeIdentifierValue(row.value);
      return type && value ? `${type}:${value}` : '';
    })
    .filter((entry) => entry.length > 0)
    .join('\n');
}

export function formatDateOnly(input: string): string {
  const raw = (input ?? '').toString().trim();
  if (!raw) return '';

  // If server stored an ISO timestamp, strip to YYYY-MM-DD.
  const isoPrefix = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoPrefix?.[1]) return isoPrefix[1];

  // If someone typed slashes (YYYY/MM/DD), normalize.
  const slash = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slash) return `${slash[1]}-${slash[2]}-${slash[3]}`;

  // Otherwise leave it as-is (UI hints encourage YYYY-MM-DD).
  return raw;
}

export function sortBaselineAuthors<
  T extends { name: string; position?: number | null },
>(authors: T[] | null | undefined): T[] {
  return (authors ?? []).slice().sort((a, b) => {
    const aPos = typeof a.position === 'number' ? a.position : 10_000;
    const bPos = typeof b.position === 'number' ? b.position : 10_000;
    return aPos - bPos;
  });
}

function normalizeOptionalNumber(value: number | null | undefined): string {
  return typeof value === 'number' && !Number.isNaN(value) ? String(value) : '';
}

function normalizeIdentifierList(serialized: string): string {
  return serializeIdentifierRows(parseIdentifierRows(serialized));
}

function nameListsEqual(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i += 1) {
    if ((actual[i] ?? '').trim() !== (expected[i] ?? '').trim()) return false;
  }
  return true;
}

export function hasBookEditorUnsavedChanges(
  input: BookEditorDirtyInput,
): boolean {
  const baseline = input.baseline;
  if (!baseline) return false;

  if (input.hasSelectedCoverFile || input.coverResetPending) return true;
  if (input.spineChanged || input.spineGenerating) return true;

  if (
    input.authorInput.trim().length > 0 ||
    input.tagInput.trim().length > 0 ||
    input.identifierTypeInput.trim().length > 0 ||
    input.identifierValueInput.trim().length > 0
  ) {
    return true;
  }

  if (input.form.title.trim() !== (baseline.title ?? '').trim()) return true;
  if (input.form.description.trim() !== (baseline.description ?? '').trim()) {
    return true;
  }
  if (
    formatDateOnly(input.form.published) !==
    formatDateOnly(baseline.published ?? '')
  ) {
    return true;
  }
  if (input.form.language.trim() !== (baseline.language ?? '').trim()) {
    return true;
  }
  if (input.form.pages.trim() !== normalizeOptionalNumber(baseline.pages)) {
    return true;
  }
  if (input.form.publisher.trim() !== (baseline.publisher?.name ?? '').trim()) {
    return true;
  }
  if (input.form.series.trim() !== (baseline.series?.name ?? '').trim()) {
    return true;
  }
  if (
    input.form.seriesIndex.trim() !==
    normalizeOptionalNumber(baseline.series?.index)
  ) {
    return true;
  }

  const currentIdentifiers = normalizeIdentifierList(input.form.identifiers);
  const baselineIdentifiers = normalizeIdentifierList(
    serializeIdentifierRows(baseline.identifiers ?? []),
  );
  if (currentIdentifiers !== baselineIdentifiers) return true;

  const currentAuthors = input.authorChips.map((chip) => chip.name);
  const baselineAuthors = sortBaselineAuthors(baseline.authors).map(
    (author) => author.name,
  );
  if (!nameListsEqual(currentAuthors, baselineAuthors)) return true;

  const currentTags = input.tagChips.map((chip) => chip.name);
  const baselineTags = (baseline.tags ?? []).map((tag) => tag.name);
  if (!nameListsEqual(currentTags, baselineTags)) return true;

  return false;
}

export function getBookEditorLeavePrompt(
  state: BookEditorLeavePromptOptions,
): BookEditorLeavePrompt | null {
  if (state.saving) {
    return {
      title: 'Save in progress',
      message:
        'Your book changes are still being saved. Leaving now may interrupt the save.',
      discardLabel: 'Leave anyway',
      stayLabel: 'Keep waiting',
      canSaveAndLeave: false,
      saveAndLeaveLabel: '',
    };
  }
  if (state.spineGenerating) {
    return {
      title: 'Spine generation in progress',
      message:
        'A spine is currently being generated. Leaving now will cancel and discard it.',
      discardLabel: 'Discard & leave',
      stayLabel: 'Keep waiting',
      canSaveAndLeave: false,
      saveAndLeaveLabel: '',
    };
  }
  if (state.hasUnsavedChanges) {
    return {
      title: 'Unsaved changes',
      message:
        'You have unsaved changes to this book, including any pending cover or spine edits. Leaving now will discard them.',
      discardLabel: 'Discard & leave',
      stayLabel: 'Keep editing',
      canSaveAndLeave: Boolean(state.canSave),
      saveAndLeaveLabel: state.isCreateMode ? 'Create & leave' : 'Save & leave',
    };
  }
  return null;
}

export function getBookEditorLeavePromptMessage(
  state: BookEditorLeaveGuardState,
): string | null {
  if (state.saving) {
    return 'Your book changes are still saving. Leave anyway?';
  }
  if (state.spineGenerating) {
    return 'Spine generation is still in progress. Leave anyway?';
  }
  if (state.hasUnsavedChanges) {
    return 'You have unsaved changes. Leave anyway?';
  }
  return null;
}
