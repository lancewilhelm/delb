<script setup lang="ts">
/**
 * Bulk actions toolbar for the Books grid.
 *
 * This component is intentionally "dumb-ish":
 * - It reads current selection from the book selection store.
 * - It reads current collection scope + user roles from the collections store.
 * - It calls server endpoints to apply actions.
 *
 * Current behavior:
 * - In a collection-scoped view (and if user is owner/editor of that scope collection),
 *   you can:
 *   - "Remove from this collection" (safe, uses collection-scoped bulk endpoint, supports allInCollection)
 *   - "Add to collection..." (adds to a chosen target collection you can edit)
 * - In the "All" view, you can only "Add to collection..." (no remove-from-scope)
 *
 * Note on "Select all":
 * - If the selection store is in allSelectedInScope mode, we do NOT fetch all IDs.
 * - For remove-from-current-collection, we call:
 *   POST /api/collections/:id/books/bulk  { allInCollection: true, excludedBookIds: [...] }
 * - For add-to-collection, we currently apply either:
 *   - allInCollection=true (scope collection only), or
 *   - explicit bookIds (for All view, because there is no server-side "All scope" bulk endpoint).
 */

defineOptions({ name: 'BookBulkActionsBar' });

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

type BulkResponse = {
  success?: boolean;
  message?: string;
  data?: {
    booksResolved?: number;
    forbidden?: string[];
    ignoredPersonalRemovals?: string[];
    added?: Array<{ collectionId: string; bookId: string }>;
    removed?: Array<{ collectionId: string; bookId: string }>;
  };
};

const props = withDefaults(
  defineProps<{
    /**
     * If true, show the toolbar when selection mode is active. If false, render nothing.
     */
    enabled?: boolean;

    /**
     * Optionally allow the parent to override the active scope collection id.
     * If not provided, we derive it from collectionsStore.activeSelection.
     */
    collectionId?: string;

    /**
     * If provided, this is invoked after a successful bulk operation so the parent
     * can refresh the grid (e.g. bump a key or refetch).
     */
    onDidApply?: (() => void) | undefined;
  }>(),
  {
    enabled: true,
    collectionId: undefined,
    onDidApply: undefined,
  },
);

const selectionStore = useBookSelectionStore();
const collectionsStore = useCollectionsStore();

const activeScopeCollectionId = computed<string | null>(() => {
  if (props.collectionId) return props.collectionId;
  if (collectionsStore.activeSelection.kind === 'collection') {
    return collectionsStore.activeSelection.collectionId;
  }
  return null;
});

const activeScopeCollection = computed(() => {
  const id = activeScopeCollectionId.value;
  if (!id) return null;
  return collectionsStore.collections.find((c) => c.id === id) ?? null;
});

const canEditScopeCollection = computed(() => {
  const c = activeScopeCollection.value;
  if (!c) return false;
  return c.role === 'owner' || c.role === 'editor';
});

const isInCollectionScope = computed(() =>
  Boolean(activeScopeCollectionId.value),
);
const showBar = computed(() => props.enabled && selectionStore.selectMode);

const selectedSummary = computed(() => {
  if (!selectionStore.selectMode) return '';
  if (selectionStore.allSelectedInScope) {
    const excluded = selectionStore.excludedBookIds.size;
    return excluded ? `All (except ${excluded})` : 'All';
  }
  return `${selectionStore.selectedBookIds.size}`;
});

// Target collection picker modal state
const pickerOpen = ref(false);
const pickerError = ref<string | null>(null);
const pickerSubmitting = ref(false);

const targetCollectionId = ref<string>('');

const editableCollections = computed(() => {
  // Only collections the user can edit. Exclude personal from add targets unless
  // it already contains the book(s) is not knowable here; so we conservatively
  // exclude personal from bulk add targets to avoid "pull into personal" class of issues.
  //
  // If you want to allow adding to personal in some cases, we should formalize policy
  // server-side and then loosen this UI.
  return collectionsStore.collections.filter((c) => {
    const canEdit = c.role === 'owner' || c.role === 'editor';
    if (!canEdit) return false;
    if (c.isPersonal) return false;
    return true;
  });
});

const removeBusy = ref(false);
const removeError = ref<string | null>(null);

const addBusy = ref(false);
const addError = ref<string | null>(null);

// Helpers to build payload from selection
function getExplicitSelectedBookIds(): string[] {
  return Array.from(selectionStore.selectedBookIds);
}

function getExcludedBookIds(): string[] {
  return Array.from(selectionStore.excludedBookIds);
}

function selectionIsEmpty(): boolean {
  if (!selectionStore.selectMode) return true;
  if (selectionStore.allSelectedInScope) {
    // all selected always means *something* in intended scope; even if the underlying scope is empty,
    // the operation will no-op on server. Treat as non-empty for UX.
    return false;
  }
  return selectionStore.selectedBookIds.size === 0;
}

function closePicker() {
  pickerOpen.value = false;
  pickerError.value = null;
  pickerSubmitting.value = false;
  targetCollectionId.value = '';
}

/**
 * Remove selected books from the current scope collection.
 * Only meaningful in collection scope; uses server-backed bulk endpoint and supports allInCollection.
 */
async function removeFromScopeCollection() {
  removeError.value = null;

  const scopeId = activeScopeCollectionId.value;
  if (!scopeId) return;
  if (!canEditScopeCollection.value) return;
  if (selectionIsEmpty()) return;
  if (removeBusy.value) return;

  removeBusy.value = true;

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
      {
        method: 'POST',
        body,
      },
    );

    if (!res?.success) {
      throw new Error(res?.message || 'Failed to remove books from collection');
    }

    // After removing, selection may no longer match visible list; clear for safety.
    selectionStore.clearSelection();
    selectionStore.setMode({ enabled: false });

    if (props.onDidApply) props.onDidApply();
  } catch (err: unknown) {
    const e = err as FetchErrorLike;
    removeError.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to remove books from this collection';
  } finally {
    removeBusy.value = false;
  }
}

/**
 * Add selected books to a chosen target collection.
 *
 * - If selection is explicit -> we can call the bulk endpoint *only* when in collection scope,
 *   otherwise we fall back to per-book PUT /api/books/:id/collections to avoid inventing an "All scope" API.
 * - If selection is allSelectedInScope:
 *   - In collection scope: we can use the collection bulk endpoint with allInCollection
 *   - In All scope: we cannot safely apply to "all books across all collections" (no server semantics), so we block.
 */
async function addToTargetCollection() {
  addError.value = null;
  pickerError.value = null;

  const targetId = targetCollectionId.value?.trim();
  if (!targetId) {
    pickerError.value = 'Pick a collection.';
    return;
  }

  if (selectionIsEmpty()) {
    pickerError.value = 'Select at least one book.';
    return;
  }

  if (addBusy.value || pickerSubmitting.value) return;

  // If "All" + allSelectedInScope, we do not have an endpoint for "apply to all books across all collections".
  if (!isInCollectionScope.value && selectionStore.allSelectedInScope) {
    pickerError.value =
      'Select all in All view is not supported for bulk add yet (needs a server-backed scope).';
    return;
  }

  addBusy.value = true;
  pickerSubmitting.value = true;

  try {
    // In collection scope we can use the collection bulk endpoint (supports allInCollection + excluded).
    const scopeId = activeScopeCollectionId.value;
    if (scopeId) {
      const body = selectionStore.allSelectedInScope
        ? {
            allInCollection: true,
            excludedBookIds: getExcludedBookIds(),
            addToCollectionIds: [targetId],
          }
        : {
            allInCollection: false,
            bookIds: getExplicitSelectedBookIds(),
            addToCollectionIds: [targetId],
          };

      const res = await $fetch<BulkResponse>(
        `/api/collections/${encodeURIComponent(scopeId)}/books/bulk`,
        {
          method: 'POST',
          body,
        },
      );

      if (!res?.success) {
        throw new Error(res?.message || 'Failed to add books to collection');
      }

      selectionStore.clearSelection();
      selectionStore.setMode({ enabled: false });

      closePicker();
      if (props.onDidApply) props.onDidApply();
      return;
    }

    // In All scope, we only support explicit selection right now.
    const ids = getExplicitSelectedBookIds();
    if (!ids.length) {
      pickerError.value = 'Select at least one book.';
      return;
    }

    // Apply per-book PUTs (best effort; partial success acceptable).
    await Promise.allSettled(
      ids.map((bookId) =>
        $fetch('/api/books/' + encodeURIComponent(bookId) + '/collections', {
          method: 'PUT',
          body: { addCollectionIds: [targetId] },
        }),
      ),
    );

    selectionStore.clearSelection();
    selectionStore.setMode({ enabled: false });

    closePicker();
    if (props.onDidApply) props.onDidApply();
  } catch (err: unknown) {
    const e = err as FetchErrorLike;
    addError.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to add to collection';
    pickerError.value = addError.value;
  } finally {
    pickerSubmitting.value = false;
    addBusy.value = false;
  }
}
</script>

<template>
  <div v-if="showBar" class="px-4 pb-2">
    <div
      class="border border-(--sub-color) rounded-md p-3 flex items-center justify-between gap-3 bg-(--bg-color)"
    >
      <div class="text-sm opacity-80 min-w-0">
        <span class="font-medium">{{ selectedSummary }}</span>
        <span> selected</span>
        <span
          v-if="isInCollectionScope && activeScopeCollection"
          class="opacity-70"
        >
          in {{ activeScopeCollection.name }}
        </span>
      </div>

      <div class="flex items-center gap-2 shrink-0">
        <button
          class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
          type="button"
          :disabled="selectionIsEmpty()"
          @click="pickerOpen = true"
        >
          Add to collection…
        </button>

        <button
          v-if="isInCollectionScope"
          class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
          type="button"
          :disabled="
            !canEditScopeCollection || selectionIsEmpty() || removeBusy
          "
          @click="removeFromScopeCollection"
        >
          {{ removeBusy ? 'Removing…' : 'Remove from this collection' }}
        </button>

        <button
          class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm"
          type="button"
          @click="
            () => {
              selectionStore.clearSelection();
              selectionStore.setMode({ enabled: false });
            }
          "
        >
          Cancel
        </button>
      </div>
    </div>

    <p v-if="removeError" class="text-sm text-red-600 mt-2">
      {{ removeError }}
    </p>

    <!-- Add modal -->
    <ModalWindow :open="pickerOpen" @close="closePicker">
      <div class="flex flex-col gap-3 w-110 max-w-[90vw]">
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="text-lg font-semibold">Add to collection</div>
            <div class="text-sm opacity-80">
              Choose a collection to add the selected books to.
            </div>
          </div>

          <Icon
            v-tooltip="'Close'"
            name="lucide:x"
            class="scale-150 cursor-pointer opacity-80 hover:opacity-100"
            @click="closePicker"
          />
        </div>

        <div class="space-y-2">
          <label class="text-sm opacity-80">Target collection</label>
          <select
            v-model="targetCollectionId"
            class="w-full px-3 py-2 border rounded-md bg-(--bg-color)"
            :disabled="pickerSubmitting"
          >
            <option value="" disabled>Select a collection…</option>
            <option v-for="c in editableCollections" :key="c.id" :value="c.id">
              {{ c.name }}
            </option>
          </select>

          <p v-if="!editableCollections.length" class="text-sm opacity-70">
            You don’t have any editable (non-personal) collections.
          </p>

          <p v-if="pickerError" class="text-sm text-red-600">
            {{ pickerError }}
          </p>
        </div>

        <div class="flex gap-2 justify-end">
          <button
            class="px-3 py-2"
            type="button"
            :disabled="pickerSubmitting"
            @click="closePicker"
          >
            Cancel
          </button>

          <button
            class="px-3 py-2 bg-(--main-color) text-(--bg-color) disabled:opacity-60 disabled:cursor-not-allowed"
            type="button"
            :disabled="pickerSubmitting || !targetCollectionId"
            @click="addToTargetCollection"
          >
            {{ pickerSubmitting ? 'Adding…' : 'Add' }}
          </button>
        </div>

        <p v-if="addError" class="text-sm text-red-600">
          {{ addError }}
        </p>

        <div class="text-xs opacity-70">
          <div v-if="selectionStore.allSelectedInScope && !isInCollectionScope">
            Note: “Select all” in the All view is not supported for bulk add
            yet.
          </div>
        </div>
      </div>
    </ModalWindow>
  </div>
</template>
