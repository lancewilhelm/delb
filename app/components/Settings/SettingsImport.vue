<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import SettingsUIGroup from '~/components/Settings/UI/SettingsUIGroup.vue';
import { useCollectionsStore } from '~/stores/collections';
import { $fetch } from '~/utils/apiFetch';
import { clearDashboardCache } from '~/utils/dashboardCache';
import {
  batches,
  buildApplyItem,
  defaultChoice,
  defaultStatusMap,
  delbRating,
  findConflict,
  hasConflict,
  starsText,
  type ApplyItem,
  type Conflict,
  type GoodreadsPreview,
  type GoodreadsRow,
  type ImportInclude,
  type StatusMap,
} from '~/utils/goodreadsImport';
import { extractFetchErrorMessage } from '~/utils/responseError';
import type { UserBookStatusValue } from '../../../shared/reading-status';

type Step = 'upload' | 'review' | 'importing' | 'done';
type UnmatchedMode = 'skip' | 'reference' | 'enrich';
type Filter = 'all' | 'matched' | 'review' | 'unmatched' | 'conflicts';

type CreatedBook = {
  index: number;
  bookId?: string;
  reused?: boolean;
  enriched?: boolean;
  enrichmentError?: string;
  error?: string;
};

type ApplyResult = {
  reading: {
    statusesSet: number;
    statusesKept: number;
    ratingsSet: number;
    ratingsKept: number;
    reviewsSet: number;
    reviewsKept: number;
    notesAdded: number;
    unavailable: string[];
  };
  shelvesCreated: number;
  shelvesUpdated: number;
  shelfBooksAdded: number;
  identifiersLinked: number;
  errors: string[];
};

const statusOptions: { value: UserBookStatusValue | null; label: string }[] = [
  { value: 'to_be_read', label: 'To be read' },
  { value: 'reading', label: 'Reading' },
  { value: 'finished', label: 'Finished' },
  { value: 'dnf', label: 'DNF' },
  { value: null, label: "Don't set a status" },
];
const statusLabel: Record<UserBookStatusValue, string> = {
  to_be_read: 'To be read',
  reading: 'Reading',
  finished: 'Finished',
  dnf: 'DNF',
};

const collectionsStore = useCollectionsStore();

const step = ref<Step>('upload');
const file = ref<File | null>(null);
const busy = ref(false);
const error = ref('');
const preview = ref<GoodreadsPreview | null>(null);

const statusMap = ref<StatusMap>({});
const include = reactive<ImportInclude>({
  statuses: true,
  ratings: true,
  reviews: true,
  notes: true,
  shelves: true,
});
const selectedShelves = ref<Record<string, boolean>>({});
const unmatchedMode = ref<UnmatchedMode>('reference');
const targetMode = ref<'existing' | 'new'>('existing');
const targetCollectionId = ref('');
const newCollectionName = ref('Goodreads');
const preferGoodreads = ref(false);
const choices = ref<Record<number, string | null>>({});
const overwriteOverrides = ref<Record<number, boolean>>({});
const filter = ref<Filter>('all');
const visibleCount = ref(50);

const progress = reactive({ label: '', done: 0, total: 0 });
const result = ref<ApplyResult | null>(null);
const createdCount = ref(0);
const enrichedCount = ref(0);
const createErrors = ref<string[]>([]);

const editableCollections = computed(() =>
  collectionsStore.collections.filter((c) =>
    collectionsStore.canEditCollection(c),
  ),
);

function pickDefaultTarget() {
  const editable = editableCollections.value;
  const active = collectionsStore.activeCollection;
  const preferred =
    (active && editable.find((c) => c.id === active.id)) ||
    editable.find((c) => c.isDefault) ||
    editable[0];
  targetCollectionId.value = preferred?.id ?? '';
  if (!preferred) targetMode.value = 'new';
}

onMounted(async () => {
  if (!collectionsStore.collections.length) {
    await collectionsStore.fetchCollections();
  }
  pickDefaultTarget();
});

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  file.value = input.files?.[0] ?? null;
  error.value = '';
}

async function runPreview() {
  if (!file.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const form = new FormData();
    form.append('file', file.value);
    const response = await $fetch<{ data: GoodreadsPreview }>(
      '/api/import/goodreads/preview',
      { method: 'POST', body: form },
    );
    const data = response.data;
    preview.value = data;
    statusMap.value = defaultStatusMap(data.exclusiveShelves);
    selectedShelves.value = Object.fromEntries(
      data.shelves.map((s) => [s.name, true]),
    );
    choices.value = Object.fromEntries(
      data.rows.map((r) => [r.index, defaultChoice(r)]),
    );
    overwriteOverrides.value = {};
    filter.value = 'all';
    visibleCount.value = 50;
    step.value = 'review';
  } catch (err) {
    error.value =
      extractFetchErrorMessage(err) ?? 'Could not read the export. Try again.';
  } finally {
    busy.value = false;
  }
}

type RowState = {
  row: GoodreadsRow;
  bookId: string | null;
  conflict: Conflict;
  conflicted: boolean;
  overwrite: boolean;
};

const rowStates = computed<RowState[]>(() => {
  const p = preview.value;
  if (!p) return [];
  return p.rows.map((row) => {
    const bookId = choices.value[row.index] ?? null;
    const conflict = findConflict(
      row,
      bookId ? p.existing[bookId] : undefined,
      statusMap.value,
      include,
    );
    const conflicted = hasConflict(conflict);
    const override = overwriteOverrides.value[row.index];
    return {
      row,
      bookId,
      conflict,
      conflicted,
      overwrite: override ?? preferGoodreads.value,
    };
  });
});

const counts = computed(() => {
  const c = { all: 0, matched: 0, review: 0, unmatched: 0, conflicts: 0 };
  for (const s of rowStates.value) {
    c.all++;
    if (!s.bookId) c.unmatched++;
    else if (s.row.match.kind === 'review') c.review++;
    else c.matched++;
    if (s.conflicted) c.conflicts++;
  }
  return c;
});

const filteredStates = computed(() =>
  rowStates.value.filter((s) => {
    switch (filter.value) {
      case 'matched':
        return Boolean(s.bookId) && s.row.match.kind !== 'review';
      case 'review':
        return s.row.match.kind === 'review';
      case 'unmatched':
        return !s.bookId;
      case 'conflicts':
        return s.conflicted;
      default:
        return true;
    }
  }),
);

const filters = computed<{ value: Filter; label: string }[]>(() => [
  { value: 'all', label: `All (${counts.value.all})` },
  { value: 'matched', label: `In Delb (${counts.value.matched})` },
  { value: 'review', label: `To confirm (${counts.value.review})` },
  { value: 'unmatched', label: `Not in Delb (${counts.value.unmatched})` },
  { value: 'conflicts', label: `Differences (${counts.value.conflicts})` },
]);

const canImport = computed(() => {
  if (busy.value || !preview.value) return false;
  const needsTarget =
    unmatchedMode.value !== 'skip' && counts.value.unmatched > 0;
  if (!needsTarget) return counts.value.all - counts.value.unmatched > 0;
  return targetMode.value === 'new'
    ? newCollectionName.value.trim().length > 0
    : Boolean(targetCollectionId.value);
});

function goodreadsStatusText(row: GoodreadsRow) {
  const status = statusMap.value[row.exclusiveShelf];
  const label = status ? statusLabel[status] : `“${row.exclusiveShelf}”`;
  const date =
    (status === 'finished' || status === 'dnf') && row.dateRead
      ? ` ${row.dateRead}`
      : '';
  return label + date;
}

function delbStateText(bookId: string) {
  const ex = preview.value?.existing[bookId];
  if (!ex) return 'No reading data';
  const parts: string[] = [];
  if (ex.status) {
    parts.push(
      statusLabel[ex.status] + (ex.endedDate ? ` ${ex.endedDate}` : ''),
    );
  }
  if (ex.rating) parts.push(starsText(ex.rating));
  if (ex.hasReview) parts.push('has a review');
  return parts.join(' · ') || 'No reading data';
}

function goodreadsStateText(row: GoodreadsRow) {
  const parts = [goodreadsStatusText(row)];
  const rating = delbRating(row.rating);
  if (rating) parts.push(starsText(rating));
  if (row.review) parts.push('has a review');
  return parts.join(' · ');
}

function candidateLabel(c: GoodreadsRow['match']['candidates'][number]) {
  const author = c.authors.join(', ');
  const files = c.hasFiles ? ' · ebook' : '';
  return `${c.title}${author ? ` — ${author}` : ''} (${c.collectionName}${files})`;
}

function setChoice(index: number, value: string) {
  choices.value = { ...choices.value, [index]: value || null };
}

function setOverwrite(index: number, value: boolean) {
  overwriteOverrides.value = { ...overwriteOverrides.value, [index]: value };
}

function resetOverrides() {
  overwriteOverrides.value = {};
}

async function resolveTarget(): Promise<string> {
  if (targetMode.value === 'existing') return targetCollectionId.value;
  const response = await $fetch<{ data: { collection: { id: string } } }>(
    '/api/collections',
    { method: 'POST', body: { name: newCollectionName.value.trim() } },
  );
  await collectionsStore.fetchCollections();
  return response.data.collection.id;
}

function rowPayload(row: GoodreadsRow) {
  const { match: _match, ...rest } = row;
  void _match;
  return rest;
}

async function runImport() {
  const p = preview.value;
  if (!p || !canImport.value) return;
  busy.value = true;
  error.value = '';
  createErrors.value = [];
  createdCount.value = 0;
  enrichedCount.value = 0;
  step.value = 'importing';

  const bookIds = new Map<number, string>();
  for (const s of rowStates.value) {
    if (s.bookId) bookIds.set(s.row.index, s.bookId);
  }

  try {
    const toCreate = rowStates.value.filter((s) => !s.bookId).map((s) => s.row);
    if (unmatchedMode.value !== 'skip' && toCreate.length) {
      const collectionId = await resolveTarget();
      const enrich = unmatchedMode.value === 'enrich';
      progress.label = enrich
        ? 'Creating entries and looking up metadata'
        : 'Creating catalog entries';
      progress.done = 0;
      progress.total = toCreate.length;
      const byIndex = new Map(toCreate.map((r) => [r.index, r]));
      for (const batch of batches(toCreate, enrich ? 5 : 50)) {
        const response = await $fetch<{ data: { results: CreatedBook[] } }>(
          '/api/import/goodreads/books',
          {
            method: 'POST',
            body: { collectionId, enrich, rows: batch.map(rowPayload) },
          },
        );
        for (const r of response.data.results) {
          if (r.bookId) {
            bookIds.set(r.index, r.bookId);
            if (!r.reused) createdCount.value++;
            if (r.enriched) enrichedCount.value++;
          } else {
            const title = byIndex.get(r.index)?.title ?? 'A book';
            createErrors.value.push(`${title}: ${r.error ?? 'not created'}`);
          }
        }
        progress.done += batch.length;
      }
    }

    progress.label = 'Applying statuses, ratings, reviews, and shelves';
    progress.done = 0;
    progress.total = 1;
    const overwriteByIndex = new Map(
      rowStates.value.map((s) => [s.row.index, s.overwrite]),
    );
    const items: ApplyItem[] = [];
    for (const row of p.rows) {
      const bookId = bookIds.get(row.index);
      if (!bookId) continue;
      items.push(
        buildApplyItem(row, bookId, overwriteByIndex.get(row.index) ?? false),
      );
    }
    if (!items.length) {
      throw new Error('No books to import.');
    }
    const shelves = include.shelves
      ? Object.entries(selectedShelves.value)
          .filter(([, on]) => on)
          .map(([name]) => name)
      : [];
    const response = await $fetch<{ data: ApplyResult }>(
      '/api/import/goodreads/apply',
      {
        method: 'POST',
        body: { items, statusMap: statusMap.value, include, shelves },
      },
    );
    progress.done = 1;
    result.value = response.data;
    clearDashboardCache();
    step.value = 'done';
  } catch (err) {
    error.value =
      (extractFetchErrorMessage(err) ?? 'The import stopped.') +
      ' Books created so far are kept. Run the import again to finish; it matches them by Goodreads ID.';
    step.value = 'review';
  } finally {
    busy.value = false;
  }
}

function startOver() {
  step.value = 'upload';
  preview.value = null;
  result.value = null;
  file.value = null;
  error.value = '';
}
</script>

<template>
  <div class="w-full">
    <SettingsUIGroup
      title="Import from Goodreads"
      icon="lucide:book-up"
      description="Statuses, To be read order, ratings, reviews, notes, and shelves"
    >
      <!-- Upload -->
      <div v-if="step === 'upload'" class="flex flex-col gap-4 max-w-2xl">
        <p>
          In Goodreads, open <strong>My Books</strong>, choose
          <strong>Import and export</strong>, and select
          <strong>Export Library</strong>. Goodreads prepares a CSV file that
          you can download. Delb shows what it will import before it changes
          anything.
        </p>
        <label class="flex flex-col gap-2">
          Goodreads export (CSV)
          <input
            type="file"
            accept=".csv,text/csv"
            class="text-sm"
            @change="onFileChange"
          />
        </label>
        <button
          :disabled="!file || busy"
          class="self-start px-4 py-2 rounded-lg bg-(--sub-alt-color) disabled:opacity-50"
          @click="runPreview"
        >
          {{ busy ? 'Reading export…' : 'Preview import' }}
        </button>
        <p v-if="error" role="alert" class="text-(--contrast-error-color)">
          {{ error }}
        </p>
      </div>

      <!-- Review -->
      <div
        v-else-if="step === 'review' && preview"
        class="flex flex-col gap-6 w-full"
      >
        <p>
          {{ counts.all }} books in the export:
          {{ counts.matched + counts.review }} already in Delb ({{
            counts.review
          }}
          to confirm) and {{ counts.unmatched }} not in Delb.
        </p>

        <section class="flex flex-col gap-2">
          <h3 class="font-semibold">What to import</h3>
          <div class="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <label class="flex gap-2 items-center"
              ><input v-model="include.statuses" type="checkbox" /> Reading
              statuses and dates</label
            >
            <label class="flex gap-2 items-center"
              ><input v-model="include.ratings" type="checkbox" />
              Ratings</label
            >
            <label class="flex gap-2 items-center"
              ><input v-model="include.reviews" type="checkbox" />
              Reviews</label
            >
            <label class="flex gap-2 items-center"
              ><input v-model="include.notes" type="checkbox" /> Private
              notes</label
            >
            <label class="flex gap-2 items-center"
              ><input v-model="include.shelves" type="checkbox" />
              Shelves</label
            >
          </div>
          <p class="text-xs opacity-70">
            Goodreads exports only the most recent read date and no start dates.
            Delb leaves missing dates empty instead of using today.
          </p>
        </section>

        <section v-if="include.statuses" class="flex flex-col gap-2">
          <h3 class="font-semibold">Goodreads shelves to Delb statuses</h3>
          <div
            class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 max-w-lg text-sm items-center"
          >
            <template
              v-for="shelf in preview.exclusiveShelves"
              :key="shelf.name"
            >
              <span
                >{{ shelf.name }}
                <span class="opacity-60">({{ shelf.count }})</span></span
              >
              <select
                v-model="statusMap[shelf.name]"
                class="px-2 py-1 rounded-md border border-(--contrast-border-color) bg-(--bg-color)"
              >
                <option
                  v-for="opt in statusOptions"
                  :key="String(opt.value)"
                  :value="opt.value"
                >
                  {{ opt.label }}
                </option>
              </select>
            </template>
          </div>
          <p class="text-xs opacity-70">
            Books that join To be read keep their Goodreads order and follow the
            books already in your Delb queue.
          </p>
        </section>

        <section
          v-if="include.shelves && preview.shelves.length"
          class="flex flex-col gap-2"
        >
          <h3 class="font-semibold">Shelves</h3>
          <p class="text-sm opacity-80">
            Each selected Goodreads shelf becomes a personal Delb shelf. A shelf
            with the same name gets the new books added to it.
          </p>
          <div class="flex flex-wrap gap-2 text-sm">
            <label
              v-for="shelf in preview.shelves"
              :key="shelf.name"
              class="flex gap-2 items-center px-2 py-1 rounded-md border border-(--contrast-border-color)"
            >
              <input v-model="selectedShelves[shelf.name]" type="checkbox" />
              {{ shelf.name }}
              <span class="opacity-60">{{ shelf.count }}</span>
              <span v-if="shelf.existing" class="text-xs opacity-60"
                >(existing)</span
              >
            </label>
          </div>
        </section>

        <section v-if="counts.unmatched" class="flex flex-col gap-2">
          <h3 class="font-semibold">
            Books not in Delb ({{ counts.unmatched }})
          </h3>
          <div class="flex flex-col gap-2 text-sm">
            <label class="flex gap-2 items-start"
              ><input
                v-model="unmatchedMode"
                type="radio"
                value="skip"
                class="mt-1"
              />
              <span
                >Skip them. Only books already in Delb get reading data.</span
              ></label
            >
            <label class="flex gap-2 items-start"
              ><input
                v-model="unmatchedMode"
                type="radio"
                value="reference"
                class="mt-1"
              />
              <span
                >Create catalog entries from the Goodreads data (title, authors,
                series, ISBN, pages). Fast, without covers.</span
              ></label
            >
            <label class="flex gap-2 items-start"
              ><input
                v-model="unmatchedMode"
                type="radio"
                value="enrich"
                class="mt-1"
              />
              <span
                >Create entries and look up descriptions and covers with the
                metadata provider. Slower, and subject to provider rate limits.
                A book without an acceptable result gets the Goodreads
                data.</span
              ></label
            >
          </div>
          <div
            v-if="unmatchedMode !== 'skip'"
            class="flex flex-col gap-2 text-sm mt-2"
          >
            <span class="opacity-80"
              >New entries go into one collection. Everyone who can open that
              collection can see them; your reading data stays private.</span
            >
            <label
              v-if="editableCollections.length"
              class="flex gap-2 items-center flex-wrap"
            >
              <input v-model="targetMode" type="radio" value="existing" />
              An existing collection
              <select
                v-model="targetCollectionId"
                :disabled="targetMode !== 'existing'"
                class="px-2 py-1 rounded-md border border-(--contrast-border-color) bg-(--bg-color)"
              >
                <option
                  v-for="c in editableCollections"
                  :key="c.id"
                  :value="c.id"
                >
                  {{ c.name }}
                </option>
              </select>
            </label>
            <label class="flex gap-2 items-center flex-wrap">
              <input v-model="targetMode" type="radio" value="new" />
              A new private collection named
              <input
                v-model="newCollectionName"
                maxlength="80"
                :disabled="targetMode !== 'new'"
                class="px-2 py-1 rounded-md border border-(--contrast-border-color) bg-(--bg-color)"
              />
            </label>
          </div>
        </section>

        <section v-if="counts.conflicts" class="flex flex-col gap-2">
          <h3 class="font-semibold">
            Differences from Delb ({{ counts.conflicts }})
          </h3>
          <p class="text-sm opacity-80">
            Some books already have a different status, rating, or review in
            Delb. Choose which to keep by default, then change individual books
            under <em>Differences</em> below.
          </p>
          <div class="flex flex-wrap gap-4 text-sm">
            <label class="flex gap-2 items-center"
              ><input
                v-model="preferGoodreads"
                type="radio"
                :value="false"
                @change="resetOverrides"
              />
              Keep the Delb values</label
            >
            <label class="flex gap-2 items-center"
              ><input
                v-model="preferGoodreads"
                type="radio"
                :value="true"
                @change="resetOverrides"
              />
              Use the Goodreads values</label
            >
          </div>
        </section>

        <section class="flex flex-col gap-2">
          <h3 class="font-semibold">Books</h3>
          <div class="flex flex-wrap gap-2 text-sm" role="tablist">
            <button
              v-for="f in filters"
              :key="f.value"
              type="button"
              role="tab"
              :aria-selected="filter === f.value"
              class="px-2 py-1 rounded-md border border-(--contrast-border-color)"
              :class="
                filter === f.value
                  ? 'bg-(--sub-alt-color) text-(--contrast-main-color)'
                  : 'opacity-80'
              "
              @click="
                filter = f.value;
                visibleCount = 50;
              "
            >
              {{ f.label }}
            </button>
          </div>
          <ul class="flex flex-col divide-y divide-(--contrast-border-color)">
            <li
              v-for="s in filteredStates.slice(0, visibleCount)"
              :key="s.row.index"
              class="py-3 flex flex-col gap-2 text-sm"
            >
              <div class="flex flex-wrap justify-between gap-2">
                <div class="min-w-0">
                  <div class="font-medium wrap-anywhere">
                    {{ s.row.fullTitle }}
                  </div>
                  <div class="opacity-70">{{ s.row.authors.join(', ') }}</div>
                </div>
                <div class="text-right opacity-80">
                  <div>{{ goodreadsStatusText(s.row) }}</div>
                  <div v-if="s.row.rating">
                    {{ starsText(delbRating(s.row.rating)) }}
                  </div>
                </div>
              </div>
              <label class="flex flex-wrap gap-2 items-center">
                <span class="opacity-70">Delb book</span>
                <select
                  :value="s.bookId ?? ''"
                  class="min-w-0 max-w-full px-2 py-1 rounded-md border border-(--contrast-border-color) bg-(--bg-color)"
                  @change="
                    setChoice(
                      s.row.index,
                      ($event.target as HTMLSelectElement).value,
                    )
                  "
                >
                  <option
                    v-for="c in s.row.match.candidates"
                    :key="c.bookId"
                    :value="c.bookId"
                  >
                    {{ candidateLabel(c) }}
                  </option>
                  <option value="">
                    Not in Delb{{
                      unmatchedMode === 'skip' ? ' (skip)' : ' (create)'
                    }}
                  </option>
                </select>
                <span
                  v-if="s.row.match.kind === 'review'"
                  class="text-xs px-1.5 py-0.5 rounded border border-(--contrast-border-color)"
                  >Likely match — confirm</span
                >
              </label>
              <div
                v-if="s.conflicted && s.bookId"
                class="flex flex-col gap-1 p-2 rounded-md bg-(--sub-alt-color)"
              >
                <label class="flex gap-2 items-start">
                  <input
                    type="radio"
                    :name="`conflict-${s.row.index}`"
                    :checked="!s.overwrite"
                    class="mt-1"
                    @change="setOverwrite(s.row.index, false)"
                  />
                  <span
                    ><strong>Keep Delb:</strong>
                    {{ delbStateText(s.bookId) }}</span
                  >
                </label>
                <label class="flex gap-2 items-start">
                  <input
                    type="radio"
                    :name="`conflict-${s.row.index}`"
                    :checked="s.overwrite"
                    class="mt-1"
                    @change="setOverwrite(s.row.index, true)"
                  />
                  <span
                    ><strong>Use Goodreads:</strong>
                    {{ goodreadsStateText(s.row) }}</span
                  >
                </label>
              </div>
            </li>
          </ul>
          <button
            v-if="filteredStates.length > visibleCount"
            type="button"
            class="self-start px-3 py-1 rounded-md border border-(--contrast-border-color)"
            @click="visibleCount += 100"
          >
            Show more ({{ filteredStates.length - visibleCount }} left)
          </button>
        </section>

        <p v-if="error" role="alert" class="text-(--contrast-error-color)">
          {{ error }}
        </p>
        <div class="flex gap-3 pb-6">
          <button
            :disabled="!canImport"
            class="px-4 py-2 rounded-lg bg-(--sub-alt-color) text-(--contrast-main-color) disabled:opacity-50"
            @click="runImport"
          >
            Import
          </button>
          <button
            type="button"
            class="px-4 py-2"
            :disabled="busy"
            @click="startOver"
          >
            Choose another file
          </button>
        </div>
      </div>

      <!-- Importing -->
      <div
        v-else-if="step === 'importing'"
        class="flex flex-col gap-3 max-w-2xl"
        role="status"
      >
        <p>{{ progress.label }}…</p>
        <progress
          class="w-full"
          :max="progress.total || 1"
          :value="progress.done"
        />
        <p v-if="progress.total > 1" class="text-sm opacity-70">
          {{ progress.done }} of {{ progress.total }}
        </p>
        <p class="text-sm opacity-70">Keep this page open until it finishes.</p>
      </div>

      <!-- Done -->
      <div
        v-else-if="step === 'done' && result"
        class="flex flex-col gap-3 max-w-2xl"
      >
        <p class="font-semibold">Import finished.</p>
        <ul class="list-disc pl-5 text-sm flex flex-col gap-1">
          <li v-if="createdCount">
            Created {{ createdCount }} catalog entries<span
              v-if="enrichedCount"
            >
              ({{ enrichedCount }} with provider metadata)</span
            >.
          </li>
          <li>
            Set {{ result.reading.statusesSet }} statuses<span
              v-if="result.reading.statusesKept"
              >, kept {{ result.reading.statusesKept }} Delb statuses</span
            >.
          </li>
          <li>
            Set {{ result.reading.ratingsSet }} ratings<span
              v-if="result.reading.ratingsKept"
              >, kept {{ result.reading.ratingsKept }}</span
            >.
          </li>
          <li>
            Saved {{ result.reading.reviewsSet }} reviews<span
              v-if="result.reading.reviewsKept"
              >, kept {{ result.reading.reviewsKept }}</span
            >, and added {{ result.reading.notesAdded }} notes.
          </li>
          <li v-if="result.shelvesCreated || result.shelvesUpdated">
            Added {{ result.shelfBooksAdded }} books to
            {{ result.shelvesCreated + result.shelvesUpdated }} shelves ({{
              result.shelvesCreated
            }}
            new).
          </li>
          <li v-if="result.identifiersLinked">
            Recorded Goodreads IDs on {{ result.identifiersLinked }} matched
            books, so a later import matches them directly.
          </li>
          <li v-if="result.reading.unavailable.length">
            {{ result.reading.unavailable.length }} books were no longer
            available and were skipped.
          </li>
        </ul>
        <details
          v-if="createErrors.length || result.errors.length"
          class="text-sm"
        >
          <summary class="text-(--contrast-error-color)">
            {{ createErrors.length + result.errors.length }} problems
          </summary>
          <ul class="list-disc pl-5 mt-1">
            <li
              v-for="(msg, i) in [...createErrors, ...result.errors]"
              :key="i"
            >
              {{ msg }}
            </li>
          </ul>
        </details>
        <div class="flex gap-3">
          <RouterLink
            to="/to-be-read"
            class="px-4 py-2 rounded-lg bg-(--sub-alt-color)"
            >Open To be read</RouterLink
          >
          <button type="button" class="px-4 py-2" @click="startOver">
            Import another file
          </button>
        </div>
      </div>
    </SettingsUIGroup>
  </div>
</template>
