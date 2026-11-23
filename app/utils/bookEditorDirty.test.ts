import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatDateOnly,
  getBookEditorLeavePromptMessage,
  hasBookEditorUnsavedChanges,
  serializeIdentifierRows,
  sortBaselineAuthors,
  type BookEditorBaseline,
  type BookEditorDirtyInput,
} from './bookEditorDirty';

function createBaseline(
  overrides: Partial<BookEditorBaseline> = {},
): BookEditorBaseline {
  return {
    title: 'Dune',
    description: '<p>Desert planet.</p>',
    published: '1965-08-01T00:00:00.000Z',
    language: 'en',
    pages: 412,
    authors: [
      { id: 'a2', name: 'Brian Herbert', position: 2 },
      { id: 'a1', name: 'Frank Herbert', position: 1 },
    ],
    tags: [
      { id: 't1', name: 'Sci-Fi' },
      { id: 't2', name: 'Classic' },
    ],
    publisher: { id: 'p1', name: 'Chilton Books' },
    series: { id: 's1', name: 'Dune', index: 1 },
    identifiers: [{ type: 'ISBN13', value: '978-0-441-17271-9' }],
    ...overrides,
  };
}

function createCleanInput(
  baseline: BookEditorBaseline | null = createBaseline(),
): BookEditorDirtyInput {
  const sortedAuthors = sortBaselineAuthors(baseline?.authors);
  return {
    baseline,
    form: {
      title: baseline?.title ?? '',
      description: baseline?.description ?? '',
      published: formatDateOnly(baseline?.published ?? ''),
      language: baseline?.language ?? '',
      pages:
        typeof baseline?.pages === 'number' && !Number.isNaN(baseline.pages)
          ? String(baseline.pages)
          : '',
      publisher: baseline?.publisher?.name ?? '',
      series: baseline?.series?.name ?? '',
      seriesIndex:
        typeof baseline?.series?.index === 'number' &&
        !Number.isNaN(baseline.series.index)
          ? String(baseline.series.index)
          : '',
      identifiers: serializeIdentifierRows(baseline?.identifiers ?? []),
    },
    authorChips: sortedAuthors.map((author) => ({ name: author.name })),
    authorInput: '',
    tagChips: (baseline?.tags ?? []).map((tag) => ({ name: tag.name })),
    tagInput: '',
    identifierTypeInput: '',
    identifierValueInput: '',
    hasSelectedCoverFile: false,
    coverResetPending: false,
    spineChanged: false,
    spineGenerating: false,
  };
}

test('clean edit, create, and unloaded states are not dirty', () => {
  assert.equal(hasBookEditorUnsavedChanges(createCleanInput()), false);

  const blankBaseline: BookEditorBaseline = {
    title: '',
    description: '',
    published: '',
    language: '',
    pages: null,
    authors: [],
    tags: [],
    publisher: null,
    series: null,
    identifiers: [],
  };
  assert.equal(
    hasBookEditorUnsavedChanges(createCleanInput(blankBaseline)),
    false,
  );

  const unloaded = createCleanInput(null);
  unloaded.form.title = 'Ignored while unloaded';
  assert.equal(hasBookEditorUnsavedChanges(unloaded), false);
});

test('zero numeric values and date normalization stay clean until edited', () => {
  const baseline = createBaseline({
    pages: 0,
    series: { id: 's1', name: 'Dune', index: 0 },
    published: '1965-08-01T12:34:56Z',
  });
  const input = createCleanInput(baseline);
  assert.equal(hasBookEditorUnsavedChanges(input), false);

  input.form.published = '1965/08/01';
  assert.equal(hasBookEditorUnsavedChanges(input), false);

  input.form.pages = '';
  assert.equal(hasBookEditorUnsavedChanges(input), true);

  input.form.pages = '0';
  input.form.seriesIndex = '';
  assert.equal(hasBookEditorUnsavedChanges(input), true);
});

test('detects edits across every metadata field and clears when reverted', () => {
  const fields: Array<{
    name: string;
    mutate: (input: BookEditorDirtyInput) => void;
  }> = [
    { name: 'title', mutate: (i) => (i.form.title = 'Dune Messiah') },
    {
      name: 'description',
      mutate: (i) => (i.form.description = '<p>Updated</p>'),
    },
    { name: 'published', mutate: (i) => (i.form.published = '1969-10-15') },
    { name: 'language', mutate: (i) => (i.form.language = 'fr') },
    { name: 'pages', mutate: (i) => (i.form.pages = '500') },
    { name: 'publisher', mutate: (i) => (i.form.publisher = 'Ace Books') },
    { name: 'series', mutate: (i) => (i.form.series = 'Dune Chronicles') },
    { name: 'seriesIndex', mutate: (i) => (i.form.seriesIndex = '2') },
    {
      name: 'identifiers',
      mutate: (i) =>
        (i.form.identifiers = `${i.form.identifiers}\nhardcover:12345`),
    },
  ];

  for (const field of fields) {
    const input = createCleanInput();
    field.mutate(input);
    assert.equal(
      hasBookEditorUnsavedChanges(input),
      true,
      `expected ${field.name} change to mark editor dirty`,
    );
  }

  const reverted = createCleanInput();
  reverted.form.title = '  Dune  ';
  assert.equal(hasBookEditorUnsavedChanges(reverted), false);
});

test('detects author chips, tag chips, and uncommitted chip or identifier inputs', () => {
  const addedAuthor = createCleanInput();
  addedAuthor.authorChips.push({ name: 'Kevin J. Anderson' });
  assert.equal(hasBookEditorUnsavedChanges(addedAuthor), true);

  const reorderedAuthors = createCleanInput();
  reorderedAuthors.authorChips.reverse();
  assert.equal(hasBookEditorUnsavedChanges(reorderedAuthors), true);

  const removedTag = createCleanInput();
  removedTag.tagChips.pop();
  assert.equal(hasBookEditorUnsavedChanges(removedTag), true);

  const authorTyping = createCleanInput();
  authorTyping.authorInput = 'Ursula';
  assert.equal(hasBookEditorUnsavedChanges(authorTyping), true);

  const tagTyping = createCleanInput();
  tagTyping.tagInput = 'Space Opera';
  assert.equal(hasBookEditorUnsavedChanges(tagTyping), true);

  const identifierTypeTyping = createCleanInput();
  identifierTypeTyping.identifierTypeInput = 'asin';
  assert.equal(hasBookEditorUnsavedChanges(identifierTypeTyping), true);

  const identifierValueTyping = createCleanInput();
  identifierValueTyping.identifierValueInput = 'B00B7NPRY8';
  assert.equal(hasBookEditorUnsavedChanges(identifierValueTyping), true);

  const whitespaceOnly = createCleanInput();
  whitespaceOnly.authorInput = '   ';
  whitespaceOnly.tagInput = '\t';
  whitespaceOnly.identifierTypeInput = ' ';
  whitespaceOnly.identifierValueInput = '  ';
  assert.equal(hasBookEditorUnsavedChanges(whitespaceOnly), false);
});

test('detects pending cover, pending spine edits, and active spine generation', () => {
  const selectedCover = createCleanInput();
  selectedCover.hasSelectedCoverFile = true;
  assert.equal(hasBookEditorUnsavedChanges(selectedCover), true);

  const resetCover = createCleanInput();
  resetCover.coverResetPending = true;
  assert.equal(hasBookEditorUnsavedChanges(resetCover), true);

  const spineChanged = createCleanInput();
  spineChanged.spineChanged = true;
  assert.equal(hasBookEditorUnsavedChanges(spineChanged), true);

  const spineGenerating = createCleanInput();
  spineGenerating.spineGenerating = true;
  assert.equal(hasBookEditorUnsavedChanges(spineGenerating), true);

  // Simulates clicking Reset: all staged cover, spine, form, and input states clear.
  const afterReset = createCleanInput();
  assert.equal(hasBookEditorUnsavedChanges(afterReset), false);
});

test('leave prompt message matches clean, unsaved, generating, and saving states', () => {
  assert.equal(
    getBookEditorLeavePromptMessage({
      hasUnsavedChanges: false,
      spineGenerating: false,
      saving: false,
    }),
    null,
  );

  assert.equal(
    getBookEditorLeavePromptMessage({
      hasUnsavedChanges: true,
      spineGenerating: false,
      saving: false,
    }),
    'You have unsaved changes. Leave anyway?',
  );

  assert.equal(
    getBookEditorLeavePromptMessage({
      hasUnsavedChanges: true,
      spineGenerating: true,
      saving: false,
    }),
    'Spine generation is still in progress. Leave anyway?',
  );

  assert.equal(
    getBookEditorLeavePromptMessage({
      hasUnsavedChanges: true,
      spineGenerating: false,
      saving: true,
    }),
    'Your book changes are still saving. Leave anyway?',
  );
});
