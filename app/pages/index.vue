<script setup lang="ts">
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
// View (mode) lives on this page (top-left view selector dropdown).
const uiStore = useUiStore();
const collectionsStore = useCollectionsStore();
const selectionStore = useBookSelectionStore();

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

type BulkResponse = {
  success?: boolean;
  message?: string;
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

const canRemoveFromActiveCollection = computed(() => {
  if (!activeCollectionId.value) return false;
  const c = collectionsStore.collections.find(
    (x) => x.id === activeCollectionId.value,
  );
  if (!c) return false;

  // Personal collections are non-removable; hide/disable remove-from-collection bulk action.
  if (c.isPersonal) return false;

  return c.role === 'owner' || c.role === 'editor';
});

const editableNonPersonalCollections = computed(() => {
  return collectionsStore.collections.filter((c) => {
    const canEdit = c.role === 'owner' || c.role === 'editor';
    if (!canEdit) return false;
    if (c.isPersonal) return false;
    return true;
  });
});

const activeCollectionIdForAdd = computed<string | null>(() => {
  return activeCollectionId.value ?? null;
});

const addModalOpen = ref(false);
const addSubmitting = ref(false);
const addError = ref<string | null>(null);

/**
 * Multi-target selection: allow adding the selected books to multiple collections at once.
 * Uses the same custom checkbox pattern used elsewhere in the app.
 */
const addTargetCollectionIds = ref<string[]>([]);

function openAddModal() {
  addError.value = null;

  // Preselect the active collection in scope (if it's addable and the user can edit it).
  const activeId = activeCollectionIdForAdd.value;
  if (
    activeId &&
    editableNonPersonalCollections.value.some((c) => c.id === activeId)
  ) {
    addTargetCollectionIds.value = [activeId];
  } else {
    addTargetCollectionIds.value = [];
  }

  addModalOpen.value = true;
  closeActionsDropdown();
}

function closeAddModal() {
  addModalOpen.value = false;
  addSubmitting.value = false;
  addError.value = null;
  addTargetCollectionIds.value = [];
}

async function applyAddToCollection() {
  if (addSubmitting.value) return;

  addError.value = null;

  const targetIds = Array.from(new Set(addTargetCollectionIds.value)).filter(
    (id) => (id ?? '').trim(),
  );

  if (!targetIds.length) {
    addError.value = 'Pick at least one collection.';
    return;
  }

  if (selectionIsEmpty()) {
    addError.value = 'Select at least one book.';
    return;
  }

  // If "All" + allSelectedInScope, we do not have a server-backed "All scope" bulk semantic yet.
  if (!activeCollectionId.value && selectionStore.allSelectedInScope) {
    addError.value =
      'Select all in All view is not supported for bulk add yet (needs a server-backed scope).';
    return;
  }

  addSubmitting.value = true;

  try {
    // In collection scope, we can use the collection bulk endpoint (supports allInCollection + excluded).
    if (activeCollectionId.value) {
      const scopeId = activeCollectionId.value;

      const body = selectionStore.allSelectedInScope
        ? {
            allInCollection: true,
            excludedBookIds: getExcludedBookIds(),
            addToCollectionIds: targetIds,
          }
        : {
            allInCollection: false,
            bookIds: getExplicitSelectedBookIds(),
            addToCollectionIds: targetIds,
          };

      const res = await $fetch<BulkResponse>(
        `/api/collections/${encodeURIComponent(scopeId)}/books/bulk`,
        { method: 'POST', body },
      );

      if (!res?.success) {
        throw new Error(res?.message || 'Failed to add to collection');
      }
    } else {
      // All view: explicit selection only; best-effort per-book PUT.
      // We allow multiple target collections by sending them in a single PUT per book.
      const ids = getExplicitSelectedBookIds();
      await Promise.allSettled(
        ids.map((bookId) =>
          $fetch(`/api/books/${encodeURIComponent(bookId)}/collections`, {
            method: 'PUT',
            body: { addCollectionIds: targetIds },
          }),
        ),
      );
    }

    selectionStore.clearSelection();
    selectionStore.setMode({ enabled: false });

    closeAddModal();
    refreshBooksGrid();
  } catch (err: unknown) {
    const e = err as FetchErrorLike;
    addError.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to add to collection';
  } finally {
    addSubmitting.value = false;
  }
}

const removeSubmitting = ref(false);
const removeError = ref<string | null>(null);

async function applyRemoveFromActiveCollection() {
  if (removeSubmitting.value) return;
  removeError.value = null;

  const scopeId = activeCollectionId.value;
  if (!scopeId) return;

  if (!canRemoveFromActiveCollection.value) return;
  if (selectionIsEmpty()) return;

  removeSubmitting.value = true;

  try {
    const body = selectionStore.allSelectedInScope
      ? {
          allInCollection: true,
          excludedBookIds: getExcludedBookIds(),
          removeFromCollectionIds: [scopeId],
        }
      : {
          allInCollection: false,
          bookIds: getExplicitSelectedBookIds(),
          removeFromCollectionIds: [scopeId],
        };

    const res = await $fetch<BulkResponse>(
      `/api/collections/${encodeURIComponent(scopeId)}/books/bulk`,
      { method: 'POST', body },
    );

    if (!res?.success)
      throw new Error(res?.message || 'Failed to remove from collection');

    selectionStore.clearSelection();
    selectionStore.setMode({ enabled: false });

    closeActionsDropdown();
    refreshBooksGrid();
  } catch (err: unknown) {
    const e = err as FetchErrorLike;
    removeError.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to remove from this collection';
  } finally {
    removeSubmitting.value = false;
  }
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

type AuthorsListResponse = {
  data?: {
    authors?: Array<{
      id: string;
      name: string;
      bookCount: number;
    }>;
  };
};

type SeriesListResponse = {
  data?: {
    series?: Array<{
      id: string;
      name: string;
      bookCount: number;
    }>;
  };
};

type PublishersListResponse = {
  data?: {
    publishers?: Array<{
      id: string;
      name: string;
      bookCount: number;
    }>;
  };
};

type TagsListResponse = {
  data?: {
    tags?: Array<{
      id: string;
      name: string;
      bookCount: number;
    }>;
  };
};

const seriesHref = (id: string) => `/series/${encodeURIComponent(id)}`;

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
// Books sorting
// ------------------------------
type BooksSortOption = {
  id: 'dateAdded' | 'alphabetical' | 'publishedDate';
  label: string;
};

const booksSortOptions: BooksSortOption[] = [
  { id: 'dateAdded', label: 'Date added' },
  { id: 'alphabetical', label: 'Alphabetical' },
  { id: 'publishedDate', label: 'Published date' },
];

const sortOpen = ref(false);
const sortAnchorRef = ref<HTMLElement | null>(null);
const sortPanelRef = ref<HTMLElement | null>(null);

// ------------------------------
// Books filters (Added date range)
// ------------------------------
const filtersOpen = ref(false);
const filterAnchorRef = ref<HTMLElement | null>(null);
const filterPanelRef = ref<HTMLElement | null>(null);

/**
 * Date inputs are stored as YYYY-MM-DD (from <input type="date">).
 * We send them to the server as addedStart/addedEnd query params.
 */
const addedStart = ref<string>('');
const addedEnd = ref<string>('');

function closeFiltersDropdown() {
  filtersOpen.value = false;
}

function toggleFiltersDropdown() {
  filtersOpen.value = !filtersOpen.value;
}

function clearAddedDateFilter() {
  addedStart.value = '';
  addedEnd.value = '';
}

const addedDateQuery = computed<Record<string, string>>(() => {
  // Keep the endpoint stable: only include params when set
  const q: Record<string, string> = {};
  if (addedStart.value) q.addedStart = addedStart.value;
  if (addedEnd.value) q.addedEnd = addedEnd.value;
  return q;
});

const booksEndpoint = computed(() => {
  const q = addedDateQuery.value;
  const pairs = Object.entries(q).filter(([, v]) => typeof v === 'string' && v);
  if (!pairs.length) return '/api/books';

  const query = pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  return `/api/books?${query}`;
});

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

// Direction toggles by re-selecting the active sort option in the dropdown.

const activeBooksSortLabel = computed(() => {
  return (
    booksSortOptions.find((o) => o.id === uiStore.booksSortKey)?.label ??
    'Date added'
  );
});

function closeSortDropdown() {
  sortOpen.value = false;
}

function toggleSortDropdown() {
  sortOpen.value = !sortOpen.value;
}

function selectBooksSort(sortId: BooksSortOption['id']) {
  // Clicking the currently-active sort toggles direction.
  if (uiStore.booksSortKey === sortId) {
    uiStore.toggleBooksSortDirection();
  } else {
    uiStore.setBooksSortKey(sortId);
  }
  closeSortDropdown();
}

function onSortDocumentPointerDown(e: MouseEvent) {
  if (!sortOpen.value) return;
  const target = e.target as Node | null;

  if (
    (sortPanelRef.value && target && sortPanelRef.value.contains(target)) ||
    (sortAnchorRef.value && target && sortAnchorRef.value.contains(target))
  ) {
    return;
  }

  closeSortDropdown();
}

function onSortDocumentKeyDown(e: KeyboardEvent) {
  if (!sortOpen.value) return;
  if (e.key === 'Escape') closeSortDropdown();
}

onMounted(() => {
  document.addEventListener('mousedown', onSortDocumentPointerDown);
  document.addEventListener('keydown', onSortDocumentKeyDown);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onSortDocumentPointerDown);
  document.removeEventListener('keydown', onSortDocumentKeyDown);
});

// ------------------------------
// Authors view (MVP: aggregated from /api/books)
// ------------------------------
type AuthorRow = {
  id: string;
  name: string;
  bookCount: number;
};

const authors = ref<AuthorRow[]>([]);
const loadingAuthors = ref(false);
const authorQuery = ref('');

const filteredAuthors = computed(() => {
  const q = authorQuery.value.trim().toLowerCase();
  const list = authors.value;
  if (!q) return list;
  return list.filter((a) => a.name.toLowerCase().includes(q));
});

async function refreshAuthors() {
  if (uiStore.libraryView !== 'authors') return;

  loadingAuthors.value = true;
  errorMessage.value = null;

  try {
    const query: Record<string, string> = {};
    if (
      collectionsStore.activeSelection.kind === 'collection' &&
      collectionsStore.activeSelection.collectionId
    ) {
      query.collectionId = collectionsStore.activeSelection.collectionId;
    }

    // Use dedicated list endpoint so this view isn't dependent on how many books were loaded.
    const res = await $fetch<AuthorsListResponse>('/api/authors', {
      method: 'GET',
      query,
    });

    const list = res?.data?.authors ?? [];

    // Keep client-side sort stable/predictable (server may already sort).
    authors.value = [...list].sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load authors';
    authors.value = [];
  } finally {
    loadingAuthors.value = false;
  }
}

// ------------------------------
// Series view (MVP: aggregated from /api/books)
// ------------------------------
type SeriesRow = {
  id: string;
  name: string;
  bookCount: number;
};

const seriesRows = ref<SeriesRow[]>([]);
const loadingSeries = ref(false);
const seriesQuery = ref('');

const filteredSeries = computed(() => {
  const q = seriesQuery.value.trim().toLowerCase();
  const list = seriesRows.value;
  if (!q) return list;
  return list.filter((s) => s.name.toLowerCase().includes(q));
});

async function refreshSeries() {
  if (uiStore.libraryView !== 'series') return;

  loadingSeries.value = true;
  errorMessage.value = null;

  try {
    const query: Record<string, string> = {};
    if (
      collectionsStore.activeSelection.kind === 'collection' &&
      collectionsStore.activeSelection.collectionId
    ) {
      query.collectionId = collectionsStore.activeSelection.collectionId;
    }

    // Use dedicated list endpoint so this view isn't dependent on how many books were loaded.
    const res = await $fetch<SeriesListResponse>('/api/series', {
      method: 'GET',
      query,
    });

    const list = res?.data?.series ?? [];

    seriesRows.value = [...list].sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load series';
    seriesRows.value = [];
  } finally {
    loadingSeries.value = false;
  }
}

// ------------------------------
// Publishers view (MVP: aggregated from /api/books)
// ------------------------------
type PublisherRow = {
  id: string;
  name: string;
  bookCount: number;
};

const publishers = ref<PublisherRow[]>([]);
const loadingPublishers = ref(false);
const publisherQuery = ref('');

const filteredPublishers = computed(() => {
  const q = publisherQuery.value.trim().toLowerCase();
  const list = publishers.value;
  if (!q) return list;
  return list.filter((p) => p.name.toLowerCase().includes(q));
});

async function refreshPublishers() {
  if (uiStore.libraryView !== 'publishers') return;

  loadingPublishers.value = true;
  errorMessage.value = null;

  try {
    const query: Record<string, string> = {};
    if (
      collectionsStore.activeSelection.kind === 'collection' &&
      collectionsStore.activeSelection.collectionId
    ) {
      query.collectionId = collectionsStore.activeSelection.collectionId;
    }

    // Use dedicated list endpoint so this view isn't dependent on how many books were loaded.
    const res = await $fetch<PublishersListResponse>('/api/publishers', {
      method: 'GET',
      query,
    });

    const list = res?.data?.publishers ?? [];

    publishers.value = [...list].sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load publishers';
    publishers.value = [];
  } finally {
    loadingPublishers.value = false;
  }
}

// ------------------------------
// Tags view
// ------------------------------
type TagRow = {
  id: string;
  name: string;
  bookCount: number;
};

const tags = ref<TagRow[]>([]);
const loadingTags = ref(false);
const tagQuery = ref('');

const filteredTags = computed(() => {
  const q = tagQuery.value.trim().toLowerCase();
  const list = tags.value;
  if (!q) return list;
  return list.filter((t) => t.name.toLowerCase().includes(q));
});

async function refreshTags() {
  if (uiStore.libraryView !== 'tags') return;

  loadingTags.value = true;
  errorMessage.value = null;

  try {
    const query: Record<string, string> = {};
    if (
      collectionsStore.activeSelection.kind === 'collection' &&
      collectionsStore.activeSelection.collectionId
    ) {
      query.collectionId = collectionsStore.activeSelection.collectionId;
    }

    const res = await $fetch<TagsListResponse>('/api/tags', {
      method: 'GET',
      query,
    });

    const list = res?.data?.tags ?? [];

    tags.value = [...list].sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load tags';
    tags.value = [];
  } finally {
    loadingTags.value = false;
  }
}

// ------------------------------
// UI helpers
// ------------------------------
// Used to force-recreate the BooksInfiniteGrid (e.g. after upload) so it reloads from page 1.
const booksGridKey = ref(0);

const viewLabel = computed(() => {
  switch (uiStore.libraryView) {
    case 'books':
      return 'Books';
    case 'authors':
      return 'Authors';
    case 'series':
      return 'Series';
    case 'publishers':
      return 'Publishers';
    case 'tags':
      return 'Tags';
    default:
      return 'Books';
  }
});

// When scope changes, refresh the result set for the active view.
watch(
  () => collectionsStore.activeSelection,
  async () => {
    // When scope changes, refresh the result set for the active view.
    await refreshActiveView();
  },
  { deep: true },
);

// When view changes, fetch only what's needed for that view.
watch(
  () => uiStore.libraryView,
  async (_mode) => {
    errorMessage.value = null;

    // If the user navigated back to Home while collections haven't loaded yet,
    // non-books views can appear empty because the active collection state isn't ready.
    // Ensure collections exist before trying to fetch view data.
    await refreshActiveView();
  },
);

async function refreshActiveView() {
  // Ensure collections are loaded so collection-scoped queries are valid after navigation.
  if (!collectionsStore.collections.length) {
    await collectionsStore.fetchCollections();
  }

  // Refresh whichever view is currently selected.
  // Books view now uses BooksInfiniteGrid (it owns its own paging/observer).
  if (uiStore.libraryView === 'authors') await refreshAuthors();
  if (uiStore.libraryView === 'series') await refreshSeries();
  if (uiStore.libraryView === 'publishers') await refreshPublishers();
  if (uiStore.libraryView === 'tags') await refreshTags();
}

const booksSortKey = computed(() => uiStore.booksSortKey);
const booksSortDir = computed(() => uiStore.booksSortDirection);

onMounted(async () => {
  await refreshActiveView();
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
        <div class="px-4 py-1 shrink-0 border-b border-(--sub-color)">
          <div class="flex items-center justify-between gap-4">
            <!-- View selector (mode) lives here (top-left) -->
            <ViewSelectorDropdown
              :model-value="uiStore.libraryView"
              @update:model-value="uiStore.setLibraryView"
            />

            <!-- Books sort + filters (only shown in Books view) -->
            <div
              v-if="uiStore.libraryView === 'books'"
              class="flex items-center gap-1 self-center"
            >
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
                      class="text-(--main-color) opacity-80 shrink-0 text-xl sm:text-lg"
                    />
                    <span class="hidden sm:block text-sm opacity-80"
                      >Actions</span
                    >
                  </button>

                  <!-- Actions Menu -->
                  <div
                    v-if="actionsOpen"
                    ref="actionsPanelRef"
                    class="absolute right-0 mt-1 w-64 border border-(--sub-color) bg-(--bg-color) rounded-md shadow-lg z-50 overflow-hidden"
                    role="menu"
                  >
                    <div class="px-3 py-2 border-b border-(--sub-color)">
                      <div class="text-xs opacity-70">Actions</div>
                    </div>

                    <div>
                      <button
                        class="w-full px-3 py-2 text-left flex justify-between! gap-3 rounded-none! hover:bg-(--sub-color)/15"
                        role="menuitem"
                        type="button"
                        @click="openAddModal"
                      >
                        <span class="truncate text-sm">Add to collection…</span>
                      </button>

                      <button
                        v-if="
                          activeCollectionId && canRemoveFromActiveCollection
                        "
                        class="w-full px-3 py-2 text-left flex justify-between! gap-3 rounded-none! hover:bg-(--sub-color)/15 disabled:opacity-60 disabled:cursor-not-allowed"
                        role="menuitem"
                        type="button"
                        :disabled="removeSubmitting"
                        @click="applyRemoveFromActiveCollection"
                      >
                        <span class="truncate text-sm"
                          >Remove from this collection</span
                        >
                        <span v-if="removeSubmitting" class="text-xs opacity-70"
                          >…</span
                        >
                      </button>
                    </div>
                  </div>
                </div>

                <!-- Seclected Count -->
                <div
                  v-if="selectionStore.selectMode"
                  class="text-sm opacity-70 hidden sm:block"
                >
                  {{ selectedCountLabel }} selected
                </div>

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
                        : 'lucide:layout-grid'
                    "
                    class="text-(--main-color) opacity-80 shrink-0 text-xl sm:text-lg"
                  />
                  <span class="hidden sm:block text-sm opacity-80">
                    <span v-if="selectionStore.selectMode">Done</span>
                    <span v-else>Select</span>
                  </span>
                </button>
              </div>

              <p v-if="removeError" class="text-sm text-red-600">
                {{ removeError }}
              </p>

              <!-- Add to collection modal -->
              <ModalWindow :open="addModalOpen" @close="closeAddModal">
                <div class="flex flex-col gap-3 w-110 max-w-[90vw]">
                  <div class="flex items-start justify-between gap-4">
                    <div>
                      <div class="text-lg font-semibold">Add to collection</div>
                      <div class="text-sm opacity-80">
                        Choose one or more collections to add the selected books
                        to.
                      </div>
                    </div>

                    <Icon
                      v-tooltip="'Close'"
                      name="lucide:x"
                      class="scale-150 cursor-pointer opacity-80 hover:opacity-100"
                      @click="closeAddModal"
                    />
                  </div>

                  <div class="space-y-2">
                    <div class="text-sm opacity-80">Target collections</div>

                    <div
                      v-if="!editableNonPersonalCollections.length"
                      class="text-sm opacity-70"
                    >
                      You don’t have any editable (non-personal) collections.
                    </div>

                    <div v-else class="space-y-1">
                      <label
                        v-for="c in editableNonPersonalCollections"
                        :key="c.id"
                        class="flex items-center gap-2 text-sm"
                      >
                        <input
                          v-model="addTargetCollectionIds"
                          type="checkbox"
                          :value="c.id"
                          :disabled="addSubmitting"
                          class="peer sr-only"
                        />
                        <span
                          class="h-5 w-5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer"
                          :class="
                            addSubmitting
                              ? 'peer-checked:bg-(--sub-color) cursor-default!'
                              : ''
                          "
                        ></span>
                        <span class="truncate">{{ c.name }}</span>
                      </label>
                    </div>

                    <p v-if="addError" class="text-sm text-red-600">
                      {{ addError }}
                    </p>
                  </div>

                  <div class="flex gap-2 justify-end">
                    <button
                      class="px-3 py-2"
                      type="button"
                      :disabled="addSubmitting"
                      @click="closeAddModal"
                    >
                      Cancel
                    </button>

                    <button
                      class="px-3 py-2 bg-(--main-color) text-(--bg-color) disabled:opacity-60 disabled:cursor-not-allowed"
                      type="button"
                      :disabled="
                        addSubmitting || addTargetCollectionIds.length === 0
                      "
                      @click="applyAddToCollection"
                    >
                      {{ addSubmitting ? 'Adding…' : 'Add' }}
                    </button>
                  </div>
                </div>
              </ModalWindow>

              <!-- Filters dropdown -->
              <div class="relative">
                <button
                  ref="filterAnchorRef"
                  class="p-1 flex items-center gap-2 h-full!"
                  :aria-expanded="filtersOpen"
                  aria-haspopup="menu"
                  @click="toggleFiltersDropdown"
                >
                  <Icon
                    name="lucide:funnel"
                    class="text-(--main-color) opacity-80 shrink-0 text-xl sm:text-lg"
                  />
                  <span class="hidden sm:block text-sm opacity-80"
                    >Filters</span
                  >
                  <!-- <Icon
                    name="lucide:chevron-down"
                    class="hidden! sm:block! text-(--main-color) opacity-80 shrink-0"
                  /> -->
                </button>

                <div
                  v-if="filtersOpen"
                  ref="filterPanelRef"
                  class="absolute right-0 mt-1 w-80 border border-(--sub-color) bg-(--bg-color) rounded-md shadow-lg z-50 overflow-hidden"
                  role="menu"
                >
                  <div
                    class="px-3 py-2 border-b border-(--sub-color) flex items-center justify-between gap-3"
                  >
                    <div class="text-xs opacity-70">Filters</div>

                    <button
                      class="text-xs opacity-70 hover:opacity-100"
                      type="button"
                      @click="clearAddedDateFilter"
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
                          class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm"
                          type="date"
                        />
                      </label>

                      <label class="space-y-1">
                        <div class="text-xs opacity-70">End</div>
                        <input
                          v-model="addedEnd"
                          class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm"
                          type="date"
                        />
                      </label>
                    </div>

                    <div class="text-xs opacity-70">
                      Shows books added within the selected date range.
                    </div>
                  </div>
                </div>
              </div>

              <!-- Sort -->
              <div class="relative">
                <button
                  ref="sortAnchorRef"
                  class="p-1 flex items-center gap-2"
                  :aria-expanded="sortOpen"
                  aria-haspopup="menu"
                  @click="toggleSortDropdown"
                >
                  <Icon
                    name="lucide:arrow-up-down"
                    class="text-(--main-color) opacity-80 shrink-0 text-xl sm:text-lg"
                  />
                  <span class="hidden sm:block text-sm opacity-80">{{
                    activeBooksSortLabel
                  }}</span>
                  <!-- <Icon
                    name="lucide:chevron-down"
                    class="hidden! sm:block! text-(--main-color) opacity-80 shrink-0"
                  /> -->
                </button>

                <div
                  v-if="sortOpen"
                  ref="sortPanelRef"
                  class="absolute right-0 mt-1 w-48 border border-(--sub-color) bg-(--bg-color) rounded-md shadow-lg z-50 overflow-hidden"
                  role="menu"
                >
                  <div class="px-3 py-2 border-b border-(--sub-color)">
                    <div class="text-xs opacity-70">Sort</div>
                  </div>

                  <div>
                    <button
                      v-for="o in booksSortOptions"
                      :key="o.id"
                      class="w-full px-3 py-2 text-left flex justify-between! gap-3 rounded-none!"
                      :class="
                        uiStore.booksSortKey === o.id
                          ? 'bg-(--sub-color)/20'
                          : 'hover:bg-(--sub-color)/15'
                      "
                      role="menuitem"
                      @click="selectBooksSort(o.id)"
                    >
                      <span class="truncate text-sm">{{ o.label }}</span>
                      <Icon
                        v-if="uiStore.booksSortKey === o.id"
                        :name="
                          uiStore.booksSortDirection === 'asc'
                            ? 'lucide:arrow-up'
                            : 'lucide:arrow-down'
                        "
                        class="text-(--main-color) opacity-80 shrink-0"
                      />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Body -->
        <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
          <!-- Render per-view. -->
          <div
            v-if="uiStore.libraryView === 'books'"
            class="flex flex-col flex-1 min-h-0"
          >
            <!-- Only the books grid scrolls (BooksInfiniteGrid owns the scroller) -->
            <BooksInfiniteGrid
              :key="`${booksGridKey}-${booksSortKey}-${booksSortDir}-${JSON.stringify(
                addedDateQuery,
              )}`"
              :collection-id="activeCollectionId"
              :sort="booksSortKey"
              :sort-dir="booksSortDir"
              :endpoint="booksEndpoint"
              :selection-enabled="true"
              class="flex-1 min-h-0"
              @error="handleBooksGridError"
            />
          </div>

          <div v-else class="flex-1 min-h-0 overflow-auto p-4 space-y-6">
              
            <!-- Authors -->
            <div v-if="uiStore.libraryView === 'authors'">
              <div class="flex items-center justify-between gap-3">
                <input
                  v-model="authorQuery"
                  class="px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm w-56"
                  placeholder="Filter authors..."
                  type="text"
                />
              </div>

              <div v-if="loadingAuthors" class="text-sm opacity-80">
                Loading...
              </div>

              <div v-else-if="errorMessage" class="text-sm text-red-600">
                {{ errorMessage }}
              </div>

              <div
                v-else-if="filteredAuthors.length === 0"
                class="text-sm opacity-80"
              >
                No authors found in the selected collection.
              </div>

              <div v-else class="mt-3 space-y-2">
                <div
                  v-for="a in filteredAuthors"
                  :key="a.id"
                  class="flex items-center justify-between border border-(--sub-color) rounded-md px-3 py-2 overflow-hidden"
                >
                  <div class="min-w-0">
                    <NuxtLink
                      :to="`/authors/${a.id}`"
                      class="truncate hover:underline"
                    >
                      {{ a.name }}
                    </NuxtLink>
                    <div class="text-xs opacity-70">
                      {{ a.bookCount }} book{{ a.bookCount === 1 ? '' : 's' }}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Series -->
            <div v-else-if="uiStore.libraryView === 'series'">
              <div class="flex items-center justify-between gap-3">
                <input
                  v-model="seriesQuery"
                  class="px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm w-56"
                  placeholder="Filter series..."
                  type="text"
                />
              </div>

              <div v-if="loadingSeries" class="text-sm opacity-80">
                Loading...
              </div>

              <div v-else-if="errorMessage" class="text-sm text-red-600">
                {{ errorMessage }}
              </div>

              <div
                v-else-if="filteredSeries.length === 0"
                class="text-sm opacity-80"
              >
                No series found in the selected collection.
              </div>

              <div v-else class="mt-3 space-y-2">
                <div
                  v-for="s in filteredSeries"
                  :key="s.id"
                  class="flex items-center justify-between border border-(--sub-color) rounded-md px-3 py-2 overflow-hidden"
                >
                  <div class="min-w-0">
                    <NuxtLink
                      :to="seriesHref(s.id)"
                      class="truncate hover:underline"
                    >
                      {{ s.name }}
                    </NuxtLink>
                    <div class="text-xs opacity-70">
                      {{ s.bookCount }} book{{ s.bookCount === 1 ? '' : 's' }}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Publishers -->
            <div v-else-if="uiStore.libraryView === 'publishers'">
              <div class="flex items-center justify-between gap-3">
                <input
                  v-model="publisherQuery"
                  class="px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm w-56"
                  placeholder="Filter publishers..."
                  type="text"
                />
              </div>

              <div v-if="loadingPublishers" class="text-sm opacity-80">
                Loading...
              </div>

              <div v-else-if="errorMessage" class="text-sm text-red-600">
                {{ errorMessage }}
              </div>

              <div
                v-else-if="filteredPublishers.length === 0"
                class="text-sm opacity-80"
              >
                No publishers found in the selected collection.
              </div>

              <div v-else class="mt-3 space-y-2">
                <div
                  v-for="p in filteredPublishers"
                  :key="p.id"
                  class="flex items-center justify-between border border-(--sub-color) rounded-md px-3 py-2 overflow-hidden"
                >
                  <div class="min-w-0">
                    <NuxtLink
                      :to="`/publishers/${p.id}`"
                      class="truncate hover:underline"
                    >
                      {{ p.name }}
                    </NuxtLink>
                    <div class="text-xs opacity-70">
                      {{ p.bookCount }} book{{ p.bookCount === 1 ? '' : 's' }}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Tags -->
            <div v-else-if="uiStore.libraryView === 'tags'">
              <div class="flex items-center justify-between gap-3">
                <input
                  v-model="tagQuery"
                  class="px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm w-56"
                  placeholder="Filter tags..."
                  type="text"
                />
              </div>

              <div v-if="loadingTags" class="text-sm opacity-80">
                Loading...
              </div>

              <div v-else-if="errorMessage" class="text-sm text-red-600">
                {{ errorMessage }}
              </div>

              <div
                v-else-if="filteredTags.length === 0"
                class="text-sm opacity-80"
              >
                No tags found in the selected collection.
              </div>

              <div v-else class="mt-3 space-y-2">
                <div
                  v-for="t in filteredTags"
                  :key="t.id"
                  class="flex items-center justify-between border border-(--sub-color) rounded-md px-3 py-2 overflow-hidden"
                >
                  <div class="min-w-0">
                    <NuxtLink
                      :to="`/tags/${t.id}`"
                      class="truncate hover:underline"
                    >
                      {{ t.name }}
                    </NuxtLink>
                    <div class="text-xs opacity-70">
                      {{ t.bookCount }} book{{ t.bookCount === 1 ? '' : 's' }}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div v-else class="text-sm opacity-80">
              <div class="text-2xl font-serif text-(--main-color)">
                {{ viewLabel }}
              </div>
              <div class="mt-2">Unknown view.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
