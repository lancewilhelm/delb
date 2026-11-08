<script setup lang="ts">
import type { BookMoveSelection } from '~/utils/collectionActions';
definePageMeta({
  auth: {
    only: 'user',
    redirectGuestTo: '/login',
  },
});

// Page metadata
useHead({
  title: 'Home',
});

// Scope (collection) lives in the header collection switcher dropdown.
const uiStore = useUiStore();
const collectionsStore = useCollectionsStore();
const selectionStore = useBookSelectionStore();
const booksFiltersStore = useBooksIndexFiltersStore();
const route = useRoute();

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

type UserBookStatus = 'to_be_read' | 'reading' | 'finished' | 'dnf';

type BulkStatusResponse = {
  success?: boolean;
  message?: string;
  data?: {
    requested: number;
    visible: number;
    updated: number;
    cleared: number;
    ignoredNotVisible: number;
    status: UserBookStatus | null;
  };
};

function refreshBooksGrid() {
  booksGridKey.value += 1;
}

function toggleSelectMode() {
  if (selectionStore.selectMode) {
    selectionStore.setMode({ enabled: false });
    return;
  }

  // Enter selection mode with the page's current scope
  if (activeCollectionId.value) {
    selectionStore.setMode({
      enabled: true,
      scope: { kind: 'collection', collectionId: activeCollectionId.value },
    });
  } else {
    selectionStore.setMode({ enabled: true, scope: { kind: 'all' } });
  }
}

function getExplicitSelectedBookIds(): string[] {
  return Array.from(selectionStore.selectedBookIds);
}

function getExcludedBookIds(): string[] {
  return Array.from(selectionStore.excludedBookIds);
}

function selectionIsEmpty(): boolean {
  if (!selectionStore.selectMode) return true;
  if (selectionStore.allSelectedInScope) return false;
  return selectionStore.selectedBookIds.size === 0;
}

function toggleSelectAllInScope() {
  if (!selectionStore.selectMode) return;

  if (selectionStore.allSelectedInScope) {
    selectionStore.setSelectedAllInScope(false);
    return;
  }

  selectionStore.setSelectedAllInScope(true);
}

const selectedCountLabel = computed(() => {
  if (!selectionStore.selectMode) return '';
  if (selectionStore.allSelectedInScope) {
    const excluded = selectionStore.excludedBookIds.size;
    return excluded ? `All (except ${excluded})` : 'All';
  }
  return `${selectionStore.selectedBookIds.size}`;
});

const showActions = computed(() => {
  if (!selectionStore.selectMode) return false;
  if (selectionStore.allSelectedInScope) return true;
  return selectionStore.selectedBookIds.size > 0;
});

const actionsOpen = ref(false);
const actionsAnchorRef = ref<HTMLElement | null>(null);
const actionsPanelRef = ref<HTMLElement | null>(null);

function closeActionsDropdown() {
  actionsOpen.value = false;
}

function toggleActionsDropdown() {
  actionsOpen.value = !actionsOpen.value;
}

const collectionsManageOpen = ref(false);
const collectionsSaveError = ref<string | null>(null);
const moveSelection = computed<BookMoveSelection>(() =>
  selectionStore.allSelectedInScope && activeCollectionId.value
    ? {
        kind: 'collection',
        collectionId: activeCollectionId.value,
        excludedBookIds: getExcludedBookIds(),
      }
    : { kind: 'books', bookIds: getExplicitSelectedBookIds() },
);
function openCollectionsManager() {
  if (!activeCollectionId.value && selectionStore.allSelectedInScope) {
    collectionsSaveError.value = 'Choose individual books to move from All.';
    return;
  }
  collectionsSaveError.value = null;
  collectionsManageOpen.value = true;
  closeActionsDropdown();
}
function closeCollectionsManager() {
  collectionsManageOpen.value = false;
}
function onBooksMoved() {
  selectionStore.clearSelection();
  selectionStore.setMode({ enabled: false });
  refreshBooksGrid();
}

type CopyChange = 'keep' | 'mark' | 'clear';
const copiesModalOpen = ref(false);
const copiesSubmitting = ref(false);
const copiesError = ref('');
const copiesResult = ref('');
const bulkPhysical = ref<CopyChange>('keep');
const bulkAudiobook = ref<CopyChange>('keep');

function openCopiesModal() {
  copiesError.value = '';
  copiesResult.value = '';
  bulkPhysical.value = 'keep';
  bulkAudiobook.value = 'keep';
  copiesModalOpen.value = true;
  closeActionsDropdown();
}

async function applyBulkCopies() {
  if (copiesSubmitting.value) return;
  if (bulkPhysical.value === 'keep' && bulkAudiobook.value === 'keep') {
    copiesError.value = 'Choose at least one change.';
    return;
  }
  copiesSubmitting.value = true;
  copiesError.value = '';
  try {
    let ids = getExplicitSelectedBookIds();
    if (selectionStore.allSelectedInScope) {
      const excluded = new Set(getExcludedBookIds());
      const endpoint = booksEndpoint.value;
      const scope = activeCollectionId.value;
      const sort = booksSortKey.value;
      const sortDir = booksSortDir.value;
      let cursor: string | undefined;
      const seen = new Set<string>();
      ids = [];
      do {
        const response = await $fetch<{
          success: boolean;
          data: { books: { id: string }[]; nextCursor: string | null };
        }>(endpoint, {
          query: {
            collectionId: scope || undefined,
            sort,
            sortDir,
            limit: 200,
            cursor,
          },
        });
        if (!response.success)
          throw new Error('Could not load the full selection.');
        ids.push(
          ...response.data.books
            .map((book) => book.id)
            .filter((id) => !excluded.has(id)),
        );
        cursor = response.data.nextCursor || undefined;
        if (cursor && seen.has(cursor))
          throw new Error('Could not finish loading the selection.');
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    if (!ids.length) throw new Error('No matching books are selected.');
    const result = await $fetch<{ data: { updated: number; skipped: number } }>(
      '/api/books/bulk/copies',
      {
        method: 'POST',
        body: {
          bookIds: ids,
          ...(bulkPhysical.value !== 'keep'
            ? { physical: bulkPhysical.value === 'mark' }
            : {}),
          ...(bulkAudiobook.value !== 'keep'
            ? { audiobook: bulkAudiobook.value === 'mark' }
            : {}),
        },
      },
    );
    copiesResult.value = `Updated ${result.data.updated} book(s).${result.data.skipped ? ` Skipped ${result.data.skipped} book(s) you cannot edit or no longer have access to.` : ''}`;
    copiesModalOpen.value = false;
    selectionStore.clearSelection();
    selectionStore.setMode({ enabled: false });
    refreshBooksGrid();
  } catch (error) {
    copiesError.value =
      error instanceof Error ? error.message : 'Could not update copies.';
  } finally {
    copiesSubmitting.value = false;
  }
}

const statusModalOpen = ref(false);
const statusSubmitting = ref(false);
const statusError = ref<string | null>(null);
const selectedBulkStatus = ref<UserBookStatus | null>(null);

const STATUS_OPTIONS = [
  { value: null as UserBookStatus | null, label: 'No status' },
  { value: 'to_be_read' as const, label: 'To be read' },
  { value: 'reading' as const, label: 'Reading' },
  { value: 'finished' as const, label: 'Finished' },
  { value: 'dnf' as const, label: 'DNF' },
] as const;

function openStatusModal() {
  statusError.value = null;
  selectedBulkStatus.value = null;
  statusModalOpen.value = true;
  closeActionsDropdown();
}

function closeStatusModal() {
  statusModalOpen.value = false;
  statusSubmitting.value = false;
  statusError.value = null;
  selectedBulkStatus.value = null;
}

async function applyBulkStatus() {
  if (statusSubmitting.value) return;

  statusError.value = null;

  if (selectionIsEmpty()) {
    statusError.value = 'Select at least one book.';
    return;
  }

  // If "All" + allSelectedInScope, we do not have a server-backed "All scope" bulk semantic yet.
  if (!activeCollectionId.value && selectionStore.allSelectedInScope) {
    statusError.value =
      'Select all in All view is not supported for bulk status yet (needs a server-backed scope).';
    return;
  }

  statusSubmitting.value = true;

  try {
    const ids = getExplicitSelectedBookIds();

    const res = await $fetch<BulkStatusResponse>('/api/books/bulk/status', {
      method: 'POST',
      body: { bookIds: ids, status: selectedBulkStatus.value },
    });

    if (!res?.success) {
      throw new Error(res?.message || 'Failed to apply status');
    }

    selectionStore.clearSelection();
    selectionStore.setMode({ enabled: false });

    closeStatusModal();
    refreshBooksGrid();
  } catch (err: unknown) {
    const e = err as FetchErrorLike;
    statusError.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to apply status';
  } finally {
    statusSubmitting.value = false;
  }
}

async function openManageCollectionsModal() {
  await Promise.resolve();

  // If load detected an unsupported mode, keep the modal closed and show the error inline.
  if (collectionsSaveError.value) return;

  openCollectionsManager();
}

function onDocumentPointerDownActions(e: MouseEvent) {
  if (!actionsOpen.value) return;
  const target = e.target as Node | null;

  if (
    (actionsPanelRef.value &&
      target &&
      actionsPanelRef.value.contains(target)) ||
    (actionsAnchorRef.value &&
      target &&
      actionsAnchorRef.value.contains(target))
  ) {
    return;
  }

  closeActionsDropdown();
}

function onDocumentKeyDownActions(e: KeyboardEvent) {
  if (!actionsOpen.value) return;
  if (e.key === 'Escape') closeActionsDropdown();
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointerDownActions);
  document.addEventListener('keydown', onDocumentKeyDownActions);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointerDownActions);
  document.removeEventListener('keydown', onDocumentKeyDownActions);
});

const errorMessage = ref<string | null>(null);

// Provide a stable collectionId prop for the BooksInfiniteGrid (scroller lives inside component).
const activeCollectionId = computed<string | undefined>(() => {
  if (
    collectionsStore.activeSelection.kind === 'collection' &&
    collectionsStore.activeSelection.collectionId
  ) {
    return collectionsStore.activeSelection.collectionId;
  }
  return undefined;
});

// Books grid error handler (keeps page-level message in sync)
function handleBooksGridError(message: string) {
  errorMessage.value = message;
}

// ------------------------------
// Books filters (Added date range)
// ------------------------------
const filtersOpen = ref(false);
const filterAnchorRef = ref<HTMLElement | null>(null);
const filterPanelRef = ref<HTMLElement | null>(null);

const filtersHydrated = ref(false);

// Avoid SSR hydration mismatches for persisted localStorage state by rendering defaults
// until the client has mounted (unless the URL explicitly deep-links a status filter).
const hasStatusDeepLink = computed(() => {
  const raw = route.query.status;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && Boolean(v.trim());
});

const shouldApplyPersistedFilters = computed(() => {
  return filtersHydrated.value || hasStatusDeepLink.value;
});

const addedStart = computed<string>({
  get: () =>
    shouldApplyPersistedFilters.value ? booksFiltersStore.addedStart : '',
  set: (v) => {
    booksFiltersStore.addedStart = v;
  },
});

const addedEnd = computed<string>({
  get: () =>
    shouldApplyPersistedFilters.value ? booksFiltersStore.addedEnd : '',
  set: (v) => {
    booksFiltersStore.addedEnd = v;
  },
});

function closeFiltersDropdown() {
  filtersOpen.value = false;
}

function toggleFiltersDropdown() {
  filtersOpen.value = !filtersOpen.value;
}

// ------------------------------
// Books filters (Status)
// ------------------------------
const STATUS_FILTER_OPTIONS = [
  { value: 'to_be_read' as const, label: 'To be read' },
  { value: 'reading' as const, label: 'Reading' },
  { value: 'finished' as const, label: 'Finished' },
  { value: 'dnf' as const, label: 'DNF' },
] as const;

const includeNoStatus = computed<boolean>(() => {
  return shouldApplyPersistedFilters.value
    ? booksFiltersStore.includeNoStatus
    : false;
});

const filesFilter = computed<'any' | 'has' | 'none'>({
  get: () =>
    shouldApplyPersistedFilters.value ? booksFiltersStore.filesFilter : 'any',
  set: (v) => {
    booksFiltersStore.filesFilter = v;
  },
});

function isStatusSelected(status: UserBookStatus) {
  if (!shouldApplyPersistedFilters.value) return false;
  return booksFiltersStore.selectedStatuses.includes(status);
}

function toggleStatusSelected(status: UserBookStatus) {
  booksFiltersStore.toggleStatusSelected(status);
}

function toggleNoStatus() {
  booksFiltersStore.toggleNoStatus();
}

function clearFilters() {
  booksFiltersStore.clearAll();
}

const booksEndpoint = computed(() => {
  const q = {
    ...booksFiltersStore.addedDateQuery,
    ...booksFiltersStore.statusQuery,
    ...booksFiltersStore.filesQuery,
    ...booksFiltersStore.copyQuery,
  };
  const pairs = Object.entries(q).filter(([, v]) => typeof v === 'string' && v);
  if (!pairs.length) return '/api/books';

  const query = pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  return `/api/books?${query}`;
});

// Allow deep-linking from dashboard via `?status=...`
watch(
  () => route.query.status,
  (raw) => {
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (typeof v !== 'string' || !v.trim()) return;
    booksFiltersStore.setStatusFilterFromQueryParam(v);
  },
  { immediate: true },
);

function onFiltersDocumentPointerDown(e: MouseEvent) {
  if (!filtersOpen.value) return;
  const target = e.target as Node | null;

  if (
    (filterPanelRef.value && target && filterPanelRef.value.contains(target)) ||
    (filterAnchorRef.value && target && filterAnchorRef.value.contains(target))
  ) {
    return;
  }

  closeFiltersDropdown();
}

function onFiltersDocumentKeyDown(e: KeyboardEvent) {
  if (!filtersOpen.value) return;
  if (e.key === 'Escape') closeFiltersDropdown();
}

onMounted(() => {
  document.addEventListener('mousedown', onFiltersDocumentPointerDown);
  document.addEventListener('keydown', onFiltersDocumentKeyDown);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onFiltersDocumentPointerDown);
  document.removeEventListener('keydown', onFiltersDocumentKeyDown);
});

const isFiltersApplied = computed(() => {
  if (!shouldApplyPersistedFilters.value) return false;
  return booksFiltersStore.isApplied;
});

// ------------------------------
// UI helpers
// ------------------------------
// Used to force-recreate the BooksInfiniteGrid (e.g. after upload) so it reloads from page 1.
const booksGridKey = ref(0);

// When scope changes, refresh the result set for the active view.
watch(
  () => collectionsStore.activeSelection,
  async () => {
    // When scope changes, ensure collections are loaded so collection-scoped queries are valid after navigation.
    if (!collectionsStore.collections.length) {
      await collectionsStore.fetchCollections();
    }
  },
  { deep: true },
);

const booksSortKey = computed(() => uiStore.booksSortKey);
const booksSortDir = computed(() => uiStore.booksSortDirection);
const booksViewMode = computed(() => uiStore.booksViewMode);
const hydrated = ref(false);
onMounted(() => {
  hydrated.value = true;
});
const effectiveBooksViewMode = computed(() =>
  hydrated.value ? booksViewMode.value : 'grid',
);

onMounted(async () => {
  filtersHydrated.value = true;

  // Ensure collections are loaded so collection-scoped queries are valid after navigation.
  if (!collectionsStore.collections.length) {
    await collectionsStore.fetchCollections();
  }
});
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" @book-uploaded="booksGridKey++" />

    <div class="flex w-full h-full overflow-hidden">
      <!-- Sidebar intentionally removed from index page in favor of filter dropdown next to Sort -->

      <!-- Main content (fixed header + scrollable content area) -->
      <div class="flex-1 overflow-hidden flex flex-col min-h-0">
        <!-- Header (non-scrolling): view selector stays fixed -->
        <div class="px-2 shrink-0 border-b border-(--contrast-border-color)">
          <div class="flex items-center justify-between gap-4">
            <!-- View selector (mode) lives here (top-left) -->
            <ViewSelectorDropdown />

            <!-- Books sort + filters -->
            <div class="flex items-center gap-1 self-center">
              <BooksViewToggle />

              <span
                class="border-r border-(--contrast-border-color) mx-1 h-6"
              />

              <!-- Select / Actions (Books view only) -->
              <div class="flex items-center gap-2">
                <!-- Actions Menu -->
                <div v-if="showActions" class="relative">
                  <button
                    ref="actionsAnchorRef"
                    class="p-1 flex items-center gap-2 h-full!"
                    type="button"
                    aria-haspopup="menu"
                    :aria-expanded="actionsOpen"
                    @click="toggleActionsDropdown"
                  >
                    <Icon
                      name="lucide:ellipsis"
                      class="text-(--contrast-main-color) opacity-80 shrink-0 text-xl sm:text-lg"
                    />
                    <span class="hidden lg:block text-sm opacity-80"
                      >Actions</span
                    >
                  </button>

                  <!-- Actions Menu -->
                  <div
                    v-if="actionsOpen"
                    ref="actionsPanelRef"
                    class="absolute right-0 mt-1 w-64 border border-(--contrast-border-color) bg-(--bg-color) rounded-md shadow-lg z-50 overflow-hidden"
                    role="menu"
                  >
                    <div
                      class="px-2 py-1 border-b border-(--contrast-border-color)"
                    >
                      <div class="text-xs opacity-70">Actions</div>
                    </div>

                    <div>
                      <button
                        class="w-full px-3 py-2 text-left flex justify-between! gap-3 rounded-none! hover:bg-(--sub-color)/15"
                        role="menuitem"
                        type="button"
                        @click="openManageCollectionsModal"
                      >
                        <span class="truncate text-sm">Move to collection</span>
                      </button>

                      <button
                        class="w-full px-3 py-2 text-left flex justify-between! gap-3 rounded-none! hover:bg-(--sub-color)/15"
                        role="menuitem"
                        type="button"
                        @click="openCopiesModal"
                      >
                        <span class="truncate text-sm">Set copies</span>
                      </button>

                      <button
                        class="w-full px-3 py-2 text-left flex justify-between! gap-3 rounded-none! hover:bg-(--sub-color)/15"
                        role="menuitem"
                        type="button"
                        @click="openStatusModal"
                      >
                        <span class="truncate text-sm">Set status</span>
                      </button>
                    </div>
                  </div>
                </div>

                <!-- Seclected Count -->
                <div
                  v-if="selectionStore.selectMode"
                  class="text-sm opacity-70 hidden lg:block"
                >
                  {{ selectedCountLabel }} selected
                </div>

                <!-- Select All Button -->
                <button
                  v-if="selectionStore.selectMode"
                  class="p-1 flex items-center gap-2 h-full!"
                  type="button"
                  :aria-pressed="
                    selectionStore.allSelectedInScope ? 'true' : 'false'
                  "
                  @click="toggleSelectAllInScope"
                >
                  <Icon
                    :name="
                      selectionStore.allSelectedInScope
                        ? 'lucide:x-square'
                        : 'lucide:list-checks'
                    "
                    class="text-(--contrast-main-color) opacity-80 shrink-0 text-xl sm:text-lg"
                  />
                  <span class="hidden lg:block text-sm opacity-80">
                    <span v-if="selectionStore.allSelectedInScope"
                      >Clear all</span
                    >
                    <span v-else>Select all</span>
                  </span>
                </button>

                <!-- Toggle Select Button -->
                <button
                  class="p-1 flex items-center gap-2 h-full!"
                  type="button"
                  @click="toggleSelectMode"
                >
                  <Icon
                    :name="
                      selectionStore.selectMode
                        ? 'lucide:check-square'
                        : 'lucide:circle-check-big'
                    "
                    class="text-(--contrast-main-color) opacity-80 shrink-0 text-xl sm:text-lg"
                  />
                  <span class="hidden lg:block text-sm opacity-80">
                    <span v-if="selectionStore.selectMode">Done</span>
                    <span v-else>Select</span>
                  </span>
                </button>
              </div>

              <p
                v-if="collectionsSaveError"
                class="text-sm text-(--contrast-error-color)"
              >
                {{ collectionsSaveError }}
              </p>

              <BooksBookMoveModal
                :open="collectionsManageOpen"
                :selection="moveSelection"
                @close="closeCollectionsManager"
                @moved="onBooksMoved"
              />

              <p v-if="copiesResult" class="text-sm" role="status">
                {{ copiesResult }}
              </p>
              <ModalWindow
                :open="copiesModalOpen"
                @close="!copiesSubmitting && (copiesModalOpen = false)"
              >
                <div
                  class="flex flex-col gap-4 w-110 max-w-[90vw]"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Set copies"
                >
                  <div class="text-lg font-semibold">Set copies</div>
                  <p class="text-sm opacity-80">
                    Changes apply to the selected books. Leave a field unchanged
                    to keep its current value.
                  </p>
                  <label
                    v-for="item in [
                      { label: 'Physical', model: bulkPhysical },
                      { label: 'Audiobook', model: bulkAudiobook },
                    ]"
                    :key="item.label"
                    class="flex justify-between items-center gap-3 text-sm"
                  >
                    {{ item.label }}
                    <select
                      :value="item.model"
                      class="px-2 py-1.5 rounded-md border border-(--contrast-border-color) bg-(--bg-color)"
                      :disabled="copiesSubmitting"
                      @change="
                        (event: Event) => {
                          const value = (event.target as HTMLSelectElement)
                            .value as CopyChange;
                          if (item.label === 'Physical') bulkPhysical = value;
                          else bulkAudiobook = value;
                        }
                      "
                    >
                      <option value="keep">Leave unchanged</option>
                      <option value="mark">Mark available</option>
                      <option value="clear">Clear mark</option>
                    </select>
                  </label>
                  <p
                    v-if="copiesError"
                    class="text-sm text-(--contrast-error-color)"
                    role="alert"
                  >
                    {{ copiesError }}
                  </p>
                  <div class="flex gap-2 justify-end">
                    <button
                      type="button"
                      class="px-3 py-2"
                      :disabled="copiesSubmitting"
                      @click="copiesModalOpen = false"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      class="px-3 py-2 bg-(--main-color) text-(--contrast-inverse-color) disabled:opacity-60"
                      :disabled="copiesSubmitting"
                      @click="applyBulkCopies"
                    >
                      {{ copiesSubmitting ? 'Applying…' : 'Apply' }}
                    </button>
                  </div>
                </div>
              </ModalWindow>

              <!-- Bulk status modal -->
              <ModalWindow :open="statusModalOpen" @close="closeStatusModal">
                <div class="flex flex-col gap-3 w-110 max-w-[90vw]">
                  <div class="flex items-start justify-between gap-4">
                    <div>
                      <div class="text-lg font-semibold">Set status</div>
                      <div class="text-sm opacity-80">
                        This will overwrite the status of selected books that
                        already have one.
                      </div>
                    </div>

                    <Icon
                      v-tooltip="'Close'"
                      name="lucide:x"
                      class="scale-150 cursor-pointer opacity-80 hover:opacity-100"
                      @click="closeStatusModal"
                    />
                  </div>

                  <div class="space-y-2">
                    <div class="text-sm opacity-80">Choose status</div>

                    <div class="space-y-2">
                      <label
                        v-for="opt in STATUS_OPTIONS"
                        :key="String(opt.value ?? '')"
                        class="flex items-center gap-2 cursor-pointer"
                      >
                        <input
                          v-model="selectedBulkStatus"
                          type="radio"
                          name="bulk-status"
                          :value="opt.value"
                          class="peer sr-only"
                          :disabled="statusSubmitting"
                        />
                        <span
                          class="h-4 w-4 border border-(--contrast-border-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                          :class="
                            statusSubmitting
                              ? 'peer-checked:bg-(--sub-color) cursor-default!'
                              : ''
                          "
                        ></span>
                        <div class="min-w-0">
                          <div class="text-sm">{{ opt.label }}</div>
                        </div>
                      </label>
                    </div>

                    <p
                      v-if="statusError"
                      class="text-sm text-(--contrast-error-color)"
                    >
                      {{ statusError }}
                    </p>
                  </div>

                  <div class="flex gap-2 justify-end">
                    <button
                      class="px-3 py-2"
                      type="button"
                      :disabled="statusSubmitting"
                      @click="closeStatusModal"
                    >
                      Cancel
                    </button>

                    <button
                      class="px-3 py-2 bg-(--main-color) text-(--contrast-inverse-color) disabled:opacity-60 disabled:cursor-not-allowed"
                      type="button"
                      :disabled="statusSubmitting"
                      @click="applyBulkStatus"
                    >
                      {{ statusSubmitting ? 'Applying…' : 'Apply' }}
                    </button>
                  </div>
                </div>
              </ModalWindow>

              <!-- Filters dropdown -->
              <div class="relative">
                <button
                  ref="filterAnchorRef"
                  class="p-1 flex items-center gap-2 h-full!"
                  :class="
                    isFiltersApplied
                      ? 'bg-(--main-color) hover:bg-(--main-color)/70!'
                      : ''
                  "
                  :aria-expanded="filtersOpen"
                  aria-haspopup="menu"
                  @click="toggleFiltersDropdown"
                >
                  <Icon
                    name="lucide:funnel"
                    class="text-(--contrast-main-color) opacity-80 shrink-0 text-xl sm:text-lg"
                    :class="
                      isFiltersApplied ? 'text-(--contrast-inverse-color)!' : ''
                    "
                  />
                  <span
                    class="hidden lg:block text-sm opacity-80"
                    :class="
                      isFiltersApplied ? 'text-(--contrast-inverse-color)' : ''
                    "
                    >Filters</span
                  >
                  <!-- <Icon
                    name="lucide:chevron-down"
                    class="hidden! lg:block! text-(--contrast-main-color) opacity-80 shrink-0"
                  /> -->
                </button>

                <div
                  v-if="filtersOpen"
                  ref="filterPanelRef"
                  class="absolute right-0 mt-1 w-80 border border-(--contrast-border-color) bg-(--bg-color) rounded-md shadow-lg z-50 overflow-hidden"
                  role="menu"
                >
                  <div
                    class="px-3 py-2 border-b border-(--contrast-border-color) flex items-center justify-between gap-3"
                  >
                    <div class="text-xs opacity-70">Filters</div>

                    <button
                      class="text-xs opacity-70 hover:opacity-100"
                      type="button"
                      @click="clearFilters"
                    >
                      Clear
                    </button>
                  </div>

                  <div class="p-3 space-y-3">
                    <div class="text-sm font-medium opacity-90">Added date</div>

                    <div class="grid grid-cols-2 gap-3">
                      <label class="space-y-1">
                        <div class="text-xs opacity-70">Start</div>
                        <input
                          v-model="addedStart"
                          class="w-full px-3 py-2 rounded-md border border-(--contrast-border-color) bg-(--bg-color) text-sm"
                          type="date"
                        />
                      </label>

                      <label class="space-y-1">
                        <div class="text-xs opacity-70">End</div>
                        <input
                          v-model="addedEnd"
                          class="w-full px-3 py-2 rounded-md border border-(--contrast-border-color) bg-(--bg-color) text-sm"
                          type="date"
                        />
                      </label>
                    </div>

                    <div class="text-xs opacity-70">
                      Shows books added within the selected date range.
                    </div>

                    <div
                      class="pt-2 border-t border-(--contrast-border-color)"
                    ></div>

                    <div class="text-sm font-medium opacity-90">Status</div>

                    <div class="space-y-2">
                      <label
                        class="flex items-center gap-2 cursor-pointer"
                        @click.prevent="toggleNoStatus"
                      >
                        <input
                          type="checkbox"
                          class="peer sr-only"
                          :checked="includeNoStatus"
                          @change="toggleNoStatus"
                        />
                        <span
                          class="h-4 w-4 border border-(--contrast-border-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                        ></span>
                        <div class="min-w-0">
                          <div class="text-sm">No status</div>
                        </div>
                      </label>

                      <label
                        v-for="opt in STATUS_FILTER_OPTIONS"
                        :key="opt.value"
                        class="flex items-center gap-2 cursor-pointer"
                        @click.prevent="toggleStatusSelected(opt.value)"
                      >
                        <input
                          type="checkbox"
                          class="peer sr-only"
                          :checked="isStatusSelected(opt.value)"
                          @change="toggleStatusSelected(opt.value)"
                        />
                        <span
                          class="h-4 w-4 border border-(--contrast-border-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                        ></span>
                        <div class="min-w-0">
                          <div class="text-sm">{{ opt.label }}</div>
                        </div>
                      </label>
                    </div>

                    <div
                      class="pt-2 border-t border-(--contrast-border-color)"
                    ></div>

                    <div class="text-sm font-medium opacity-90">Files</div>

                    <div class="space-y-2">
                      <label class="flex items-center gap-2 cursor-pointer">
                        <input
                          v-model="filesFilter"
                          type="radio"
                          name="files-filter"
                          value="any"
                          class="peer sr-only"
                        />
                        <span
                          class="h-4 w-4 border border-(--contrast-border-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                        ></span>
                        <div class="min-w-0">
                          <div class="text-sm">Any</div>
                        </div>
                      </label>

                      <label class="flex items-center gap-2 cursor-pointer">
                        <input
                          v-model="filesFilter"
                          type="radio"
                          name="files-filter"
                          value="has"
                          class="peer sr-only"
                        />
                        <span
                          class="h-4 w-4 border border-(--contrast-border-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                        ></span>
                        <div class="min-w-0">
                          <div class="text-sm">Has files</div>
                        </div>
                      </label>

                      <label class="flex items-center gap-2 cursor-pointer">
                        <input
                          v-model="filesFilter"
                          type="radio"
                          name="files-filter"
                          value="none"
                          class="peer sr-only"
                        />
                        <span
                          class="h-4 w-4 border border-(--contrast-border-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                        ></span>
                        <div class="min-w-0">
                          <div class="text-sm">No files</div>
                        </div>
                      </label>
                    </div>

                    <div class="text-xs opacity-70">
                      Filters by whether a book has stored files.
                    </div>
                    <div
                      class="pt-2 border-t border-(--contrast-border-color)"
                    ></div>
                    <div class="text-sm font-medium opacity-90">Copies</div>
                    <label
                      class="flex justify-between items-center gap-3 text-sm"
                      >Physical
                      <select
                        v-model="booksFiltersStore.physicalFilter"
                        class="px-2 py-1.5 rounded-md border border-(--contrast-border-color) bg-(--bg-color)"
                      >
                        <option value="any">Any</option>
                        <option value="marked">Marked</option>
                        <option value="unmarked">Not marked</option>
                      </select>
                    </label>
                    <label
                      class="flex justify-between items-center gap-3 text-sm"
                      >Audiobook
                      <select
                        v-model="booksFiltersStore.audiobookFilter"
                        class="px-2 py-1.5 rounded-md border border-(--contrast-border-color) bg-(--bg-color)"
                      >
                        <option value="any">Any</option>
                        <option value="marked">Marked</option>
                        <option value="unmarked">Not marked</option>
                      </select>
                    </label>
                    <div class="text-xs opacity-70">
                      Not marked does not necessarily mean no copy is available.
                    </div>
                  </div>
                </div>
              </div>

              <BooksSortDropdown />
            </div>
          </div>
        </div>

        <!-- Body -->
        <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
          <!-- Render per-view. -->
          <div class="flex flex-col flex-1 min-h-0">
            <!-- Only the books grid scrolls (BooksInfiniteGrid owns the scroller) -->
            <BooksInfiniteGrid
              v-if="effectiveBooksViewMode === 'grid'"
              :key="`grid-${booksGridKey}-${booksSortKey}-${booksSortDir}-${booksEndpoint}-${effectiveBooksViewMode}`"
              :collection-id="activeCollectionId"
              :sort="booksSortKey"
              :sort-dir="booksSortDir"
              :endpoint="booksEndpoint"
              :selection-enabled="true"
              class="flex-1 min-h-0"
              @error="handleBooksGridError"
            />
            <BooksInfiniteList
              v-else-if="effectiveBooksViewMode === 'list'"
              :key="`list-${booksGridKey}-${booksSortKey}-${booksSortDir}-${booksEndpoint}-${effectiveBooksViewMode}`"
              :collection-id="activeCollectionId"
              :sort="booksSortKey"
              :sort-dir="booksSortDir"
              :endpoint="booksEndpoint"
              :selection-enabled="true"
              class="flex-1 min-h-0"
              @error="handleBooksGridError"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
