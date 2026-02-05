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

type BulkResponse = {
  success?: boolean;
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

// ------------------------------
// Bulk manage collections (add/remove in one modal)
// ------------------------------
const collectionsManageOpen = ref(false);
const collectionsSaving = ref(false);
const collectionsSaveError = ref<string | null>(null);
const collectionsTouched = ref(false);

// Editable collections user can mutate (owner/editor). Personal can be included but cannot be removed.
const editableCollections = computed(() => {
  return (collectionsStore.collections ?? []).filter((c) =>
    collectionsStore.canEditCollection(c),
  );
});

const personalCollectionId = computed(() => {
  return collectionsStore.collections.find((c) => c.isPersonal)?.id ?? null;
});

// For bulk selection we store membership as three-state:
// 'in' => selected books currently all in this collection
// 'out' => selected books currently all NOT in this collection
// 'mixed' => selection has a mix
type BulkDesiredMembership = 'in' | 'out' | 'mixed';

const collectionMembership = ref<Record<string, BulkDesiredMembership>>({});
const desiredMembership = ref<Record<string, BulkDesiredMembership>>({});

function openCollectionsManager() {
  collectionsSaveError.value = null;
  collectionsTouched.value = false;

  // Start from computed membership (already loaded by fetch below).
  desiredMembership.value = { ...collectionMembership.value };
  collectionsManageOpen.value = true;
  closeActionsDropdown();
}

function closeCollectionsManager() {
  collectionsManageOpen.value = false;
  collectionsSaveError.value = null;
  collectionsSaving.value = false;
  collectionsTouched.value = false;
  desiredMembership.value = {};
}

/**
 * Toggle cycles:
 * - out -> in
 * - in -> out (unless Personal)
 * - mixed -> in (chooses "add" by default)
 */
function onToggleDesiredMembership(collectionId: string) {
  const pid = personalCollectionId.value;
  const current = desiredMembership.value[collectionId] ?? 'out';

  if (pid && collectionId === pid && current === 'in') return; // cannot remove Personal

  const next: BulkDesiredMembership =
    current === 'out' ? 'in' : current === 'in' ? 'out' : 'in';

  desiredMembership.value = {
    ...desiredMembership.value,
    [collectionId]: next,
  };

  collectionsTouched.value = true;
}

const collectionsDelta = computed(() => {
  // Only include explicit in/out changes. Mixed -> anything is considered a change only after touch,
  // but delta only considers desired vs current dict values.
  const addCollectionIds: string[] = [];
  const removeCollectionIds: string[] = [];

  const pid = personalCollectionId.value;

  for (const c of editableCollections.value) {
    const id = c.id;
    const curr = collectionMembership.value[id] ?? 'out';
    const desired = desiredMembership.value[id] ?? curr;

    if (curr === desired) continue;

    // Mixed can become in/out which implies add/remove for some subset.
    // We resolve via per-book PUTs (All view) or via collection bulk endpoints (collection scope).
    if (desired === 'in') addCollectionIds.push(id);
    if (desired === 'out') {
      if (!(pid && id === pid)) removeCollectionIds.push(id);
    }
  }

  return { addCollectionIds, removeCollectionIds };
});

const collectionsDirty = computed(() => {
  const d = collectionsDelta.value;
  return d.addCollectionIds.length > 0 || d.removeCollectionIds.length > 0;
});

async function loadBulkCollectionMembership() {
  collectionsSaveError.value = null;

  if (selectionIsEmpty()) {
    collectionMembership.value = {};
    desiredMembership.value = {};
    return;
  }

  // If "All" + allSelectedInScope, we do not have a server-backed "All scope" bulk semantic yet.
  if (!activeCollectionId.value && selectionStore.allSelectedInScope) {
    collectionsSaveError.value =
      'Select all in All view is not supported for manage collections yet (needs a server-backed scope).';
    collectionMembership.value = {};
    desiredMembership.value = {};
    return;
  }

  const ids = getExplicitSelectedBookIds();
  if (!ids.length) {
    collectionMembership.value = {};
    desiredMembership.value = {};
    return;
  }

  // Aggregate per-book collections to determine 'in'/'out'/'mixed' for each editable collection.
  // Best-effort fetch to keep UI responsive.
  const results = await Promise.allSettled(
    ids.map((bookId) =>
      fetch(`/api/books/${encodeURIComponent(bookId)}/collections`, {
        method: 'GET',
      })
        .then(async (r) => {
          if (!r.ok) throw new Error(`Failed (${r.status})`);
          return (await r.json().catch(() => null)) as {
            data?: { collections?: { id: string }[] };
          } | null;
        })
        .then((json) => ({
          bookId,
          collectionIds: new Set(
            (json?.data?.collections ?? []).map((c) => c.id),
          ),
        })),
    ),
  );

  const ok = results
    .filter(
      (
        r,
      ): r is PromiseFulfilledResult<{
        bookId: string;
        collectionIds: Set<string>;
      }> => r.status === 'fulfilled',
    )
    .map((r) => r.value);

  if (!ok.length) {
    collectionsSaveError.value = 'Failed to load collections for selection.';
    collectionMembership.value = {};
    desiredMembership.value = {};
    return;
  }

  const counts: Record<string, number> = {};
  for (const row of ok) {
    for (const id of row.collectionIds) {
      counts[id] = (counts[id] ?? 0) + 1;
    }
  }

  const total = ok.length;
  const membership: Record<string, BulkDesiredMembership> = {};

  for (const c of editableCollections.value) {
    const id = c.id;
    const inCount = counts[id] ?? 0;

    if (inCount === 0) membership[id] = 'out';
    else if (inCount === total) membership[id] = 'in';
    else membership[id] = 'mixed';
  }

  collectionMembership.value = membership;
  desiredMembership.value = { ...membership };
}

async function saveCollections() {
  if (collectionsSaving.value) return;

  collectionsSaveError.value = null;

  if (selectionIsEmpty()) {
    collectionsSaveError.value = 'Select at least one book.';
    return;
  }

  // If "All" + allSelectedInScope, we do not have a server-backed "All scope" bulk semantic yet.
  if (!activeCollectionId.value && selectionStore.allSelectedInScope) {
    collectionsSaveError.value =
      'Select all in All view is not supported for manage collections yet (needs a server-backed scope).';
    return;
  }

  const delta = collectionsDelta.value;

  if (!delta.addCollectionIds.length && !delta.removeCollectionIds.length) {
    closeCollectionsManager();
    return;
  }

  collectionsSaving.value = true;

  try {
    // In collection scope, apply changes via the collection bulk endpoint so that:
    // - add applies to selected books even if selection was made in that scope
    // - remove-from-this-collection works for bulk selection/exclude semantics
    if (activeCollectionId.value) {
      const scopeId = activeCollectionId.value;

      const selectedBody = selectionStore.allSelectedInScope
        ? { allInCollection: true, excludedBookIds: getExcludedBookIds() }
        : { allInCollection: false, bookIds: getExplicitSelectedBookIds() };

      // Add to other collections (if any)
      if (delta.addCollectionIds.length) {
        const resAdd = await $fetch<BulkResponse>(
          `/api/collections/${encodeURIComponent(scopeId)}/books/bulk`,
          {
            method: 'POST',
            body: {
              ...selectedBody,
              addToCollectionIds: delta.addCollectionIds,
            },
          },
        );

        if (!resAdd?.success) {
          throw new Error(resAdd?.message || 'Failed to add to collections');
        }
      }

      // Remove from collections (including this collection, if toggled out)
      if (delta.removeCollectionIds.length) {
        const resRemove = await $fetch<BulkResponse>(
          `/api/collections/${encodeURIComponent(scopeId)}/books/bulk`,
          {
            method: 'POST',
            body: {
              ...selectedBody,
              removeFromCollectionIds: delta.removeCollectionIds,
            },
          },
        );

        if (!resRemove?.success) {
          throw new Error(
            resRemove?.message || 'Failed to remove from collections',
          );
        }
      }
    } else {
      // All view: explicit selection only; best-effort per-book PUT with both add/remove arrays.
      const ids = getExplicitSelectedBookIds();
      await Promise.allSettled(
        ids.map((bookId) =>
          $fetch(`/api/books/${encodeURIComponent(bookId)}/collections`, {
            method: 'PUT',
            body: {
              addCollectionIds: delta.addCollectionIds,
              removeCollectionIds: delta.removeCollectionIds,
            },
          }),
        ),
      );
    }

    selectionStore.clearSelection();
    selectionStore.setMode({ enabled: false });

    closeCollectionsManager();
    refreshBooksGrid();
  } catch (err: unknown) {
    const e = err as FetchErrorLike;
    collectionsSaveError.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to update collections';
  } finally {
    collectionsSaving.value = false;
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
  await loadBulkCollectionMembership();

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
        <div class="px-2 shrink-0 border-b border-(--sub-color)">
          <div class="flex items-center justify-between gap-4">
            <!-- View selector (mode) lives here (top-left) -->
            <ViewSelectorDropdown />

            <!-- Books sort + filters -->
            <div class="flex items-center gap-1 self-center">
              <BooksViewToggle />

              <span class="border-r border-(--sub-color) mx-1 h-6" />

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
                    <span class="hidden lg:block text-sm opacity-80"
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
                    <div class="px-2 py-1 border-b border-(--sub-color)">
                      <div class="text-xs opacity-70">Actions</div>
                    </div>

                    <div>
                      <button
                        class="w-full px-3 py-2 text-left flex justify-between! gap-3 rounded-none! hover:bg-(--sub-color)/15"
                        role="menuitem"
                        type="button"
                        @click="openManageCollectionsModal"
                      >
                        <span class="truncate text-sm">Manage collections</span>
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
                    class="text-(--main-color) opacity-80 shrink-0 text-xl sm:text-lg"
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
                    class="text-(--main-color) opacity-80 shrink-0 text-xl sm:text-lg"
                  />
                  <span class="hidden lg:block text-sm opacity-80">
                    <span v-if="selectionStore.selectMode">Done</span>
                    <span v-else>Select</span>
                  </span>
                </button>
              </div>

              <p
                v-if="collectionsSaveError"
                class="text-sm text-(--error-color)"
              >
                {{ collectionsSaveError }}
              </p>

              <!-- Manage collections modal -->
              <ModalWindow
                :open="collectionsManageOpen"
                @close="closeCollectionsManager"
              >
                <div class="flex flex-col gap-4 w-110 max-w-[90vw]">
                  <div class="flex items-start justify-between gap-4">
                    <div>
                      <div class="text-lg font-semibold">
                        Manage collections
                      </div>
                      <div class="text-sm opacity-80">
                        Add or remove selected books from collections you can
                        edit.
                      </div>
                    </div>

                    <Icon
                      v-tooltip="'Close'"
                      name="lucide:x"
                      class="scale-150 cursor-pointer opacity-80 hover:opacity-100"
                      @click="closeCollectionsManager"
                    />
                  </div>

                  <div
                    v-if="collectionsSaveError"
                    class="text-sm text-(--error-color)"
                  >
                    {{ collectionsSaveError }}
                  </div>

                  <div class="border border-(--sub-color) rounded-lg p-3">
                    <div class="text-sm font-semibold mb-2">
                      Your editable collections
                    </div>

                    <div
                      v-if="collectionsStore.loading"
                      class="text-sm opacity-70"
                    >
                      Loading…
                    </div>

                    <div
                      v-else-if="!editableCollections.length"
                      class="text-sm opacity-70"
                    >
                      You don’t have any editable collections.
                    </div>

                    <div v-else class="flex flex-col gap-3">
                      <div class="text-xs opacity-70">
                        Checked means “all selected books will be in this
                        collection”. A dash means “some are in and some are
                        out”. Personal cannot be removed.
                      </div>

                      <label
                        v-for="c in editableCollections"
                        :key="c.id"
                        class="flex items-center justify-between gap-3 text-sm cursor-pointer"
                      >
                        <div class="flex items-center gap-2 min-w-0">
                          <input
                            type="checkbox"
                            class="peer sr-only"
                            :checked="
                              (desiredMembership[c.id] ?? 'out') === 'in'
                            "
                            :disabled="
                              collectionsSaving ||
                              (c.isPersonal &&
                                (desiredMembership[c.id] ?? 'out') === 'in')
                            "
                            @change="onToggleDesiredMembership(c.id)"
                          />
                          <span
                            class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                          ></span>

                          <div class="min-w-0 flex items-center gap-2">
                            <span class="truncate">{{ c.name }}</span>
                            <span
                              v-if="c.isPersonal"
                              class="text-xs opacity-70 whitespace-nowrap"
                            >
                              (Personal)
                            </span>
                            <span
                              v-if="
                                (desiredMembership[c.id] ?? 'out') === 'mixed'
                              "
                              class="text-xs opacity-70 whitespace-nowrap"
                            >
                              (Mixed)
                            </span>
                          </div>
                        </div>

                        <span class="text-xs opacity-70 whitespace-nowrap">{{
                          c.role
                        }}</span>
                      </label>
                    </div>
                  </div>

                  <div class="flex items-center justify-end gap-2">
                    <button
                      class="px-3 py-2"
                      type="button"
                      :disabled="collectionsSaving"
                      @click="closeCollectionsManager"
                    >
                      Cancel
                    </button>

                    <button
                      class="px-3 py-2 bg-(--main-color) text-(--bg-color) disabled:opacity-60 disabled:cursor-not-allowed"
                      type="button"
                      :disabled="collectionsSaving || !collectionsDirty"
                      @click="saveCollections"
                    >
                      <span v-if="collectionsSaving">Saving…</span>
                      <span v-else>Save</span>
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
                          class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
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

                    <p v-if="statusError" class="text-sm text-(--error-color)">
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
                      class="px-3 py-2 bg-(--main-color) text-(--bg-color) disabled:opacity-60 disabled:cursor-not-allowed"
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
                    class="text-(--main-color) opacity-80 shrink-0 text-xl sm:text-lg"
                    :class="isFiltersApplied ? 'text-(--bg-color)!' : ''"
                  />
                  <span
                    class="hidden lg:block text-sm opacity-80"
                    :class="isFiltersApplied ? 'text-(--bg-color)' : ''"
                    >Filters</span
                  >
                  <!-- <Icon
                    name="lucide:chevron-down"
                    class="hidden! lg:block! text-(--main-color) opacity-80 shrink-0"
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

                    <div class="pt-2 border-t border-(--sub-color)"></div>

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
                          class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
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
                          class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                        ></span>
                        <div class="min-w-0">
                          <div class="text-sm">{{ opt.label }}</div>
                        </div>
                      </label>
                    </div>

                    <div class="pt-2 border-t border-(--sub-color)"></div>

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
                          class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
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
                          class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
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
                          class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                        ></span>
                        <div class="min-w-0">
                          <div class="text-sm">No files</div>
                        </div>
                      </label>
                    </div>

                    <div class="text-xs opacity-70">
                      Filters by whether a book has stored files.
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
                  <span class="hidden lg:block text-sm opacity-80">{{
                    activeBooksSortLabel
                  }}</span>
                  <!-- <Icon
                    name="lucide:chevron-down"
                    class="hidden! lg:block! text-(--main-color) opacity-80 shrink-0"
                  /> -->
                </button>

                <div
                  v-if="sortOpen"
                  ref="sortPanelRef"
                  class="absolute right-0 mt-1 w-48 border border-(--sub-color) bg-(--bg-color) rounded-md shadow-lg z-50 overflow-hidden"
                  role="menu"
                >
                  <div class="px-2 py-1 border-b border-(--sub-color)">
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
