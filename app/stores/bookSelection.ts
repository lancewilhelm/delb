import { defineStore } from 'pinia';

export type BookSelectionScope =
  | { kind: 'all' }
  | { kind: 'collection'; collectionId: string };

type SetModeOpts = {
  enabled: boolean;
  scope?: BookSelectionScope;
};

type SetSelectedAllInScopeOpts = {
  /**
   * When provided, these IDs will be treated as the canonical universe for
   * "all in scope" selection (used for Phase 3 while we only know loaded IDs).
   *
   * Phase 4 will switch this to server-backed "select all" without needing this.
   */
  knownBookIdsInScope?: string[];
};

/**
 * Multi-select state for the Books grid (Phase 3/4).
 *
 * Design goals:
 * - Selection survives infinite scrolling pagination (loaded list changing).
 * - Supports both "select specific ids" and "select all in scope" behavior.
 * - Scope-aware: selection is specific to the current view scope (All vs Collection).
 *
 * NOTE:
 * - This store intentionally does NOT enforce permission rules; the UI should
 *   decide which actions are available for the current scope/user.
 */
export const useBookSelectionStore = defineStore('bookSelection', () => {
  /**
   * Whether multi-select mode is enabled.
   * When false, selection UI should be hidden and clicks should navigate.
   */
  const selectMode = ref(false);

  /**
   * The scope the selection applies to.
   * This should be set by the page when entering selection mode and/or when
   * the active collection changes.
   */
  const scope = ref<BookSelectionScope>({ kind: 'all' });

  /**
   * Selection model:
   * - If `allSelectedInScope` is false:
   *   - `selectedBookIds` holds the selected book IDs.
   * - If `allSelectedInScope` is true:
   *   - All books in the current scope are considered selected,
   *     except for any IDs in `excludedBookIds`.
   *
   * This supports "Select all" without storing every ID.
   */
  const allSelectedInScope = ref(false);
  const selectedBookIds = ref<Set<string>>(new Set());
  const excludedBookIds = ref<Set<string>>(new Set());

  /**
   * For Phase 3, we sometimes only know about the currently-loaded items.
   * This array can be updated by the grid as pages load.
   *
   * Phase 4's server-backed "select all" does NOT require this, but keeping it
   * allows a good UX for "select all loaded" vs "select all in collection".
   */
  const knownBookIdsInScope = ref<Set<string>>(new Set());

  function normalizeId(id: string) {
    return String(id ?? '').trim();
  }

  function setScope(next: BookSelectionScope) {
    scope.value = next;
  }

  function setMode(opts: SetModeOpts) {
    selectMode.value = opts.enabled;

    if (opts.scope) {
      setScope(opts.scope);
    }

    if (!opts.enabled) {
      clearSelection();
    }
  }

  function clearSelection() {
    allSelectedInScope.value = false;
    selectedBookIds.value = new Set();
    excludedBookIds.value = new Set();
  }

  function resetForScope(nextScope: BookSelectionScope) {
    scope.value = nextScope;
    clearSelection();
    knownBookIdsInScope.value = new Set();
  }

  function setKnownBookIdsInScope(ids: string[]) {
    const next = new Set<string>();
    for (const raw of ids) {
      const id = normalizeId(raw);
      if (id) next.add(id);
    }
    knownBookIdsInScope.value = next;
  }

  function addKnownBookIdsInScope(ids: string[]) {
    const next = new Set(knownBookIdsInScope.value);
    for (const raw of ids) {
      const id = normalizeId(raw);
      if (id) next.add(id);
    }
    knownBookIdsInScope.value = next;
  }

  function isSelected(bookIdRaw: string) {
    const bookId = normalizeId(bookIdRaw);
    if (!bookId) return false;

    if (allSelectedInScope.value) {
      return !excludedBookIds.value.has(bookId);
    }

    return selectedBookIds.value.has(bookId);
  }

  function toggle(bookIdRaw: string) {
    const bookId = normalizeId(bookIdRaw);
    if (!bookId) return;

    if (allSelectedInScope.value) {
      const next = new Set(excludedBookIds.value);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      excludedBookIds.value = next;
      return;
    }

    const next = new Set(selectedBookIds.value);
    if (next.has(bookId)) next.delete(bookId);
    else next.add(bookId);
    selectedBookIds.value = next;
  }

  function select(bookIdRaw: string) {
    const bookId = normalizeId(bookIdRaw);
    if (!bookId) return;

    if (allSelectedInScope.value) {
      const next = new Set(excludedBookIds.value);
      next.delete(bookId);
      excludedBookIds.value = next;
      return;
    }

    const next = new Set(selectedBookIds.value);
    next.add(bookId);
    selectedBookIds.value = next;
  }

  function deselect(bookIdRaw: string) {
    const bookId = normalizeId(bookIdRaw);
    if (!bookId) return;

    if (allSelectedInScope.value) {
      const next = new Set(excludedBookIds.value);
      next.add(bookId);
      excludedBookIds.value = next;
      return;
    }

    const next = new Set(selectedBookIds.value);
    next.delete(bookId);
    selectedBookIds.value = next;
  }

  /**
   * Sets "select all" state.
   *
   * Phase 3 behavior:
   * - If you pass `knownBookIdsInScope`, we store them so the UI can at least
   *   show an accurate selected count for what's currently known/loaded.
   *
   * Phase 4 behavior:
   * - The server will be the source of truth for "all in collection" actions,
   *   so we don't need to materialize IDs client-side.
   */
  function setSelectedAllInScope(
    selected: boolean,
    opts: SetSelectedAllInScopeOpts = {},
  ) {
    allSelectedInScope.value = selected;

    if (selected) {
      selectedBookIds.value = new Set();
      excludedBookIds.value = new Set();
      if (opts.knownBookIdsInScope) {
        setKnownBookIdsInScope(opts.knownBookIdsInScope);
      }
    } else {
      // When leaving "all selected":
      // keep nothing selected by default (caller can re-select if desired).
      clearSelection();
      if (opts.knownBookIdsInScope) {
        setKnownBookIdsInScope(opts.knownBookIdsInScope);
      }
    }
  }

  /**
   * A conservative count primarily used for UI display.
   *
   * - When `allSelectedInScope` is false -> exact count.
   * - When `allSelectedInScope` is true -> we only know exclusions exactly.
   *   We cannot know the true total without server help, so:
   *   - if we have `knownBookIdsInScope`, return that minus exclusions
   *   - otherwise return null to indicate "all" / unknown count.
   */
  const selectedCount = computed<number | null>(() => {
    if (!allSelectedInScope.value) return selectedBookIds.value.size;

    const known = knownBookIdsInScope.value.size;
    if (!known) return null;

    // Count known selected = known - excluded-within-known
    let excludedKnown = 0;
    for (const id of excludedBookIds.value) {
      if (knownBookIdsInScope.value.has(id)) excludedKnown += 1;
    }
    return Math.max(0, known - excludedKnown);
  });

  return {
    // state
    selectMode,
    scope,
    allSelectedInScope,
    selectedBookIds,
    excludedBookIds,
    knownBookIdsInScope,

    // derived
    selectedCount,

    // actions
    setScope,
    setMode,
    resetForScope,
    clearSelection,

    setKnownBookIdsInScope,
    addKnownBookIdsInScope,

    isSelected,
    toggle,
    select,
    deselect,

    setSelectedAllInScope,
  };
});
