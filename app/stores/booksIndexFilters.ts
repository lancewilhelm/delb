import { defineStore } from 'pinia';

export type UserBookStatus = 'to_be_read' | 'reading' | 'finished' | 'dnf';
export type BookFilesFilter = 'any' | 'has' | 'none';

export const useBooksIndexFiltersStore = defineStore(
  'booksIndexFilters',
  () => {
    /**
     * Date inputs are stored as YYYY-MM-DD (from <input type="date">).
     * We send them to the server as addedStart/addedEnd query params.
     */
    const addedStart = ref<string>('');
    const addedEnd = ref<string>('');

    const selectedStatuses = ref<UserBookStatus[]>([]);
    const includeNoStatus = ref(false);
    const filesFilter = ref<BookFilesFilter>('any');

    const statusQuery = computed<Record<string, string>>(() => {
      const q: Record<string, string> = {};
      const tokens: string[] = [];
      if (includeNoStatus.value) tokens.push('none');
      for (const s of selectedStatuses.value) tokens.push(s);
      if (tokens.length) q.status = tokens.join(',');
      return q;
    });

    const addedDateQuery = computed<Record<string, string>>(() => {
      const q: Record<string, string> = {};
      if (addedStart.value) q.addedStart = addedStart.value;
      if (addedEnd.value) q.addedEnd = addedEnd.value;
      return q;
    });

    const filesQuery = computed<Record<string, string>>(() => {
      const q: Record<string, string> = {};
      if (filesFilter.value === 'has') q.files = 'has';
      if (filesFilter.value === 'none') q.files = 'none';
      return q;
    });

    const isApplied = computed<boolean>(() => {
      return Boolean(
        addedStart.value ||
          addedEnd.value ||
          selectedStatuses.value.length ||
          includeNoStatus.value ||
          filesFilter.value !== 'any',
      );
    });

    function clearAll() {
      addedStart.value = '';
      addedEnd.value = '';
      selectedStatuses.value = [];
      includeNoStatus.value = false;
      filesFilter.value = 'any';
    }

    function toggleNoStatus() {
      includeNoStatus.value = !includeNoStatus.value;
    }

    function toggleStatusSelected(status: UserBookStatus) {
      const set = new Set(selectedStatuses.value);
      if (set.has(status)) set.delete(status);
      else set.add(status);
      selectedStatuses.value = Array.from(set);
    }

    function setStatusFilterFromQueryParam(v: string) {
      const tokens = v
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      includeNoStatus.value = tokens.includes('none');

      const allowed = new Set<UserBookStatus>([
        'to_be_read',
        'reading',
        'finished',
        'dnf',
      ]);

      selectedStatuses.value = Array.from(
        new Set(
          tokens.filter((t): t is UserBookStatus =>
            allowed.has(t as UserBookStatus),
          ),
        ),
      );
    }

    return {
      addedStart,
      addedEnd,
      selectedStatuses,
      includeNoStatus,
      filesFilter,

      statusQuery,
      addedDateQuery,
      filesQuery,
      isApplied,

      clearAll,
      toggleNoStatus,
      toggleStatusSelected,
      setStatusFilterFromQueryParam,
    };
  },
  { persist: true },
);
