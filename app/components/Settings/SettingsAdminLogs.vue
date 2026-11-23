<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import SettingsUIGroup from '~/components/Settings/UI/SettingsUIGroup.vue';
import { useAuth } from '~/composables/useAuth';
import { $fetch } from '~/utils/apiFetch';
import {
  buildAdminLogsDownloadUrl,
  buildAdminLogsQueryParams,
  extractAttachmentFilename,
  formatByteSize,
  formatLogAttrsPreview,
  formatLogTimestamp,
  normalizeLogLevel,
  type AdminLogDownloadFormat,
  type AdminLogDownloadScope,
  type AdminLogEntry,
  type AdminLogLevel,
  type AdminLogLevelFilter,
  type AdminLogsQueryResult,
  type AdminLogStorageInfo,
} from '~/utils/adminLogs';

defineOptions({ name: 'SettingsAdminLogs' });

const PAGE_SIZE = 100;
const AUTO_REFRESH_MS = 3000;

const { isAdmin } = useAuth();

const loading = ref(false);
const loadingMore = ref(false);
const errorMessage = ref('');

const entries = ref<AdminLogEntry[]>([]);
const total = ref(0);
const hasMore = ref(false);
const components = ref<string[]>([]);
const runtimeLevel = ref<AdminLogLevel>('info');
const storage = ref<AdminLogStorageInfo | null>(null);

const levelSaving = ref(false);
const levelNotice = ref('');
const levelError = ref('');

const levelFilter = ref<AdminLogLevelFilter>('');
const componentFilter = ref('');
const requestIdFilter = ref('');
const searchQuery = ref('');

const downloadScope = ref<AdminLogDownloadScope>('all');
const downloading = ref<AdminLogDownloadFormat | null>(null);
const downloadError = ref('');

const autoRefresh = ref(false);
const expandedIds = ref<Set<string>>(new Set());
const copiedRequestId = ref('');

let pollTimer: ReturnType<typeof setInterval> | null = null;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

const runtimeLevelOptions: Array<{ value: AdminLogLevel; label: string }> = [
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
];

const levelFilterOptions: Array<{ value: AdminLogLevelFilter; label: string }> =
  [
    { value: '', label: 'All levels' },
    { value: 'debug', label: 'Debug' },
    { value: 'info', label: 'Info' },
    { value: 'warn', label: 'Warn' },
    { value: 'error', label: 'Error' },
    { value: 'info+', label: 'Info & above' },
    { value: 'warn+', label: 'Warn & Error' },
  ];

const hasActiveFilters = computed(
  () =>
    Boolean(levelFilter.value) ||
    Boolean(componentFilter.value) ||
    Boolean(requestIdFilter.value.trim()) ||
    Boolean(searchQuery.value.trim()),
);

const storageSummary = computed(() => {
  const s = storage.value;
  if (!s) return '';
  if (!s.enabled) {
    return `In-memory buffer · ${s.memoryEntries.toLocaleString()} / ${s.memoryCapacity.toLocaleString()} entries`;
  }
  const fileLabel = s.fileCount === 1 ? '1 file' : `${s.fileCount} files`;
  return `${fileLabel} · ${formatByteSize(s.totalBytes)} / ${formatByteSize(s.maxTotalBytes)}`;
});

function entryKey(entry: AdminLogEntry, index: number): string {
  return `${entry.id}-${entry.time}-${index}`;
}

function isExpanded(key: string): boolean {
  return expandedIds.value.has(key);
}

function toggleExpanded(key: string) {
  const next = new Set(expandedIds.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  expandedIds.value = next;
}

function hasDetails(entry: AdminLogEntry): boolean {
  return Boolean(
    entry.requestId || (entry.attrs && Object.keys(entry.attrs).length > 0),
  );
}

function levelBadgeClass(level: string): string {
  switch (normalizeLogLevel(level)) {
    case 'error':
      return 'border-(--contrast-error-color) text-(--contrast-error-color) bg-(--bg-color)';
    case 'warn':
      return 'border-amber-500/60 text-amber-700 dark:text-amber-300 bg-amber-500/10';
    case 'debug':
      return 'border-(--contrast-border-color) text-(--contrast-sub-color) bg-(--sub-alt-color)';
    default:
      return 'border-(--main-color)/50 text-(--contrast-main-color) bg-(--main-color)/10';
  }
}

function currentFilterState(offset = 0) {
  return {
    levelFilter: levelFilter.value,
    component: componentFilter.value,
    requestId: requestIdFilter.value,
    q: searchQuery.value,
    limit: PAGE_SIZE,
    offset,
    order: 'desc' as const,
  };
}

async function fetchLogs(opts: { append?: boolean; silent?: boolean } = {}) {
  if (!isAdmin.value) return;
  const append = Boolean(opts.append);
  if (append) {
    if (loadingMore.value || !hasMore.value) return;
    loadingMore.value = true;
  } else if (!opts.silent) {
    loading.value = true;
  }
  if (!opts.silent) {
    errorMessage.value = '';
  }

  try {
    const offset = append ? entries.value.length : 0;
    const params = buildAdminLogsQueryParams(currentFilterState(offset));
    const res = await $fetch<{
      success: boolean;
      data?: AdminLogsQueryResult;
    }>(`/api/settings/admin/logs?${params.toString()}`, { method: 'GET' });

    const data = res?.data;
    if (!data) {
      throw new Error('Unexpected response from server');
    }

    const incoming = Array.isArray(data.entries) ? data.entries : [];
    if (append) {
      entries.value = [...entries.value, ...incoming];
    } else {
      entries.value = incoming;
    }
    total.value = Number(data.total ?? incoming.length);
    hasMore.value = Boolean(data.hasMore);
    components.value = Array.isArray(data.components) ? data.components : [];
    runtimeLevel.value = normalizeLogLevel(data.level);
    storage.value = data.storage ?? null;
  } catch (err: unknown) {
    errorMessage.value =
      err instanceof Error ? err.message : 'Failed to load system logs.';
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

async function updateRuntimeLevel(nextLevel: AdminLogLevel) {
  if (!isAdmin.value || levelSaving.value) return;
  levelSaving.value = true;
  levelNotice.value = '';
  levelError.value = '';

  try {
    const res = await $fetch<{
      success: boolean;
      data?: { level: AdminLogLevel; previousLevel: AdminLogLevel };
    }>('/api/settings/admin/logs/level', {
      method: 'PUT',
      body: { level: nextLevel },
    });
    const applied = normalizeLogLevel(res?.data?.level ?? nextLevel);
    runtimeLevel.value = applied;
    levelNotice.value = `Runtime log level set to ${applied.toUpperCase()}.`;
    await fetchLogs({ silent: true });
  } catch (err: unknown) {
    levelError.value =
      err instanceof Error ? err.message : 'Failed to update log level.';
  } finally {
    levelSaving.value = false;
  }
}

async function downloadLogs(format: AdminLogDownloadFormat) {
  if (!isAdmin.value || downloading.value) return;
  downloading.value = format;
  downloadError.value = '';

  try {
    const url = buildAdminLogsDownloadUrl(
      format,
      downloadScope.value,
      currentFilterState(0),
    );
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!response.ok) {
      let msg = `Download failed (${response.status})`;
      try {
        const body = (await response.json()) as { message?: string };
        if (body?.message) msg = body.message;
      } catch {
        // Use fallback message when response is not JSON.
      }
      throw new Error(msg);
    }

    const blob = await response.blob();
    const ext = format === 'jsonl' ? 'jsonl' : 'log';
    const filename = extractAttachmentFilename(
      response.headers.get('Content-Disposition'),
      `delb-logs.${ext}`,
    );

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (err: unknown) {
    downloadError.value =
      err instanceof Error ? err.message : 'Failed to download logs.';
  } finally {
    downloading.value = null;
  }
}

function clearFilters() {
  levelFilter.value = '';
  componentFilter.value = '';
  requestIdFilter.value = '';
  searchQuery.value = '';
  void fetchLogs();
}

function filterByComponent(comp: string) {
  componentFilter.value = componentFilter.value === comp ? '' : comp;
}

function filterByRequestId(reqId: string) {
  requestIdFilter.value = reqId;
}

async function copyRequestId(reqId: string) {
  try {
    await navigator.clipboard.writeText(reqId);
    copiedRequestId.value = reqId;
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      if (copiedRequestId.value === reqId) {
        copiedRequestId.value = '';
      }
    }, 2000);
  } catch {
    // Clipboard unavailable; ignore quietly.
  }
}

function formatAttrsJSON(attrs?: Record<string, unknown>): string {
  if (!attrs) return '';
  try {
    return JSON.stringify(attrs, null, 2);
  } catch {
    return String(attrs);
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    void fetchLogs({ silent: true });
  }, AUTO_REFRESH_MS);
}

watch([levelFilter, componentFilter], () => {
  void fetchLogs();
});

watch([searchQuery, requestIdFilter], () => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    void fetchLogs();
  }, 250);
});

watch(autoRefresh, (enabled) => {
  if (enabled) {
    void fetchLogs({ silent: true });
    startPolling();
  } else {
    stopPolling();
  }
});

onMounted(() => {
  void fetchLogs();
});

onBeforeUnmount(() => {
  stopPolling();
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  if (copyResetTimer) clearTimeout(copyResetTimer);
});
</script>

<template>
  <div class="w-full px-3 pb-10">
    <SettingsUIGroup
      title="System Logs"
      icon="lucide:scroll-text"
      description="inspect, filter, and download structured server logs"
    >
      <div class="space-y-4 w-full">
        <!-- Runtime log level + storage summary -->
        <div
          class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg border border-(--contrast-border-color) bg-(--sub-alt-color)"
        >
          <div class="flex flex-wrap items-center gap-3">
            <label class="flex items-center gap-2 text-sm">
              <span class="font-semibold">Runtime level</span>
              <select
                :value="runtimeLevel"
                class="px-2.5 py-1.5 text-sm border border-(--contrast-border-color) rounded-lg bg-(--bg-color)"
                :disabled="!isAdmin || levelSaving"
                @change="
                  updateRuntimeLevel(
                    ($event.target as HTMLSelectElement).value as AdminLogLevel,
                  )
                "
              >
                <option
                  v-for="opt in runtimeLevelOptions"
                  :key="opt.value"
                  :value="opt.value"
                >
                  {{ opt.label }}
                </option>
              </select>
            </label>
            <span v-if="levelSaving" class="text-xs opacity-70">
              Updating...
            </span>
            <span
              v-else-if="levelNotice"
              class="text-xs text-(--contrast-main-color)"
            >
              {{ levelNotice }}
            </span>
            <span
              v-else-if="levelError"
              class="text-xs text-(--contrast-error-color)"
            >
              {{ levelError }}
            </span>
          </div>

          <div
            v-if="storageSummary"
            class="flex items-center gap-1.5 text-xs opacity-75 font-mono"
            :title="storage?.dir || 'In-memory log ring buffer'"
          >
            <Icon name="lucide:hard-drive" class="shrink-0" />
            <span>{{ storageSummary }}</span>
          </div>
        </div>

        <!-- Download controls -->
        <div
          class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg border border-(--contrast-border-color)"
        >
          <div class="flex flex-wrap items-center gap-3 text-sm">
            <span class="font-semibold">Download</span>
            <label class="flex items-center gap-1.5 cursor-pointer text-xs">
              <input
                v-model="downloadScope"
                type="radio"
                value="all"
                class="accent-(--main-color)"
              />
              <span>All logs</span>
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer text-xs">
              <input
                v-model="downloadScope"
                type="radio"
                value="filtered"
                class="accent-(--main-color)"
              />
              <span>Current filter</span>
            </label>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-(--main-color) text-(--contrast-inverse-color) cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="!isAdmin || downloading !== null"
              @click="downloadLogs('text')"
            >
              <Icon name="lucide:download" class="w-4 h-4" />
              <span>{{
                downloading === 'text' ? 'Downloading...' : 'Download .log'
              }}</span>
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-(--contrast-border-color) cursor-pointer hover:bg-(--sub-alt-color) disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="!isAdmin || downloading !== null"
              @click="downloadLogs('jsonl')"
            >
              <Icon name="lucide:file-json" class="w-4 h-4" />
              <span>{{
                downloading === 'jsonl' ? 'Downloading...' : 'Download .jsonl'
              }}</span>
            </button>
          </div>
        </div>

        <div
          v-if="downloadError"
          class="text-sm text-(--contrast-error-color) px-1"
        >
          {{ downloadError }}
        </div>

        <!-- Filters & live refresh bar -->
        <div class="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
          <select
            v-model="levelFilter"
            aria-label="Filter by severity level"
            class="sm:col-span-3 p-2 text-sm border border-(--contrast-border-color) rounded-lg bg-(--bg-color)"
          >
            <option
              v-for="opt in levelFilterOptions"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </select>

          <select
            v-model="componentFilter"
            aria-label="Filter by component"
            class="sm:col-span-3 p-2 text-sm border border-(--contrast-border-color) rounded-lg bg-(--bg-color)"
          >
            <option value="">All components</option>
            <option v-for="comp in components" :key="comp" :value="comp">
              {{ comp }}
            </option>
          </select>

          <div class="sm:col-span-6 relative">
            <input
              v-model="searchQuery"
              type="search"
              placeholder="Search messages, attributes, or errors..."
              class="w-full p-2 pr-8 text-sm border border-(--contrast-border-color) rounded-lg bg-(--bg-color)"
              @keyup.enter="fetchLogs()"
            />
          </div>
        </div>

        <div
          class="flex flex-wrap items-center justify-between gap-2 text-xs text-(--contrast-sub-color)"
        >
          <div class="flex flex-wrap items-center gap-2">
            <span>
              Showing {{ entries.length.toLocaleString() }} of
              {{ total.toLocaleString() }}
              {{ total === 1 ? 'entry' : 'entries' }}
            </span>
            <span
              v-if="requestIdFilter"
              class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-(--contrast-border-color) bg-(--sub-alt-color) font-mono text-(--contrast-text-color)"
            >
              req:{{ requestIdFilter }}
              <button
                type="button"
                class="cursor-pointer hover:opacity-75"
                title="Clear request ID filter"
                @click="requestIdFilter = ''"
              >
                <Icon name="lucide:x" class="w-3 h-3" />
              </button>
            </span>
            <button
              v-if="hasActiveFilters"
              type="button"
              class="underline cursor-pointer hover:opacity-80 text-(--contrast-main-color)"
              @click="clearFilters"
            >
              Clear filters
            </button>
          </div>

          <div class="flex items-center gap-3">
            <label
              class="inline-flex items-center gap-1.5 cursor-pointer select-none text-(--contrast-text-color)"
            >
              <input
                v-model="autoRefresh"
                type="checkbox"
                class="accent-(--main-color)"
              />
              <span>Live refresh (3s)</span>
            </label>

            <button
              type="button"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-(--contrast-border-color) text-(--contrast-text-color) cursor-pointer hover:bg-(--sub-alt-color) disabled:opacity-50"
              :disabled="loading"
              @click="fetchLogs()"
            >
              <Icon
                name="lucide:refresh-cw"
                class="w-3.5 h-3.5"
                :class="loading ? 'animate-spin' : ''"
              />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        <!-- Error banner -->
        <div
          v-if="errorMessage"
          class="p-3 rounded-lg border border-(--contrast-error-color) text-sm text-(--contrast-error-color)"
        >
          {{ errorMessage }}
        </div>

        <!-- Log entries list -->
        <div
          class="rounded-lg border border-(--contrast-border-color) overflow-hidden divide-y divide-(--contrast-border-color)"
        >
          <div
            v-if="loading && entries.length === 0"
            class="p-6 text-center text-sm opacity-70"
          >
            Loading logs...
          </div>

          <div
            v-else-if="entries.length === 0"
            class="p-6 text-center text-sm opacity-70"
          >
            No log entries match the current filters.
          </div>

          <div
            v-for="(entry, idx) in entries"
            v-else
            :key="entryKey(entry, idx)"
            class="bg-(--bg-color)"
          >
            <div
              class="flex flex-col sm:flex-row sm:items-baseline gap-1.5 sm:gap-2.5 px-3 py-2 text-xs transition-colors"
              :class="
                hasDetails(entry)
                  ? 'cursor-pointer hover:bg-(--sub-alt-color)'
                  : ''
              "
              @click="
                hasDetails(entry) ? toggleExpanded(entryKey(entry, idx)) : null
              "
            >
              <div class="flex items-center gap-2 shrink-0">
                <span
                  class="font-mono text-[11px] opacity-70 whitespace-nowrap"
                  :title="entry.time"
                >
                  {{ formatLogTimestamp(entry.time) }}
                </span>

                <span
                  class="inline-flex items-center justify-center px-1.5 py-0.5 rounded border font-mono text-[10px] font-semibold uppercase tracking-wide w-13 shrink-0"
                  :class="levelBadgeClass(entry.level)"
                >
                  {{ entry.level }}
                </span>

                <button
                  v-if="entry.component"
                  type="button"
                  class="px-1.5 py-0.5 rounded bg-(--sub-alt-color) border border-(--contrast-border-color) font-mono text-[11px] cursor-pointer hover:border-(--main-color)"
                  :title="`Filter by component: ${entry.component}`"
                  @click.stop="filterByComponent(entry.component)"
                >
                  {{ entry.component }}
                </button>
              </div>

              <div class="min-w-0 flex-1 flex items-baseline gap-2">
                <span class="text-sm text-(--contrast-text-color) break-words">
                  {{ entry.message }}
                </span>
                <span
                  v-if="
                    !isExpanded(entryKey(entry, idx)) &&
                    formatLogAttrsPreview(entry.attrs)
                  "
                  class="hidden md:inline font-mono text-[11px] opacity-60 truncate"
                >
                  {{ formatLogAttrsPreview(entry.attrs) }}
                </span>
              </div>

              <div
                v-if="hasDetails(entry)"
                class="flex items-center gap-1.5 shrink-0 self-end sm:self-center opacity-70"
              >
                <span
                  v-if="entry.requestId"
                  class="font-mono text-[10px] opacity-80 hidden sm:inline"
                >
                  {{ entry.requestId.slice(0, 10) }}
                </span>
                <Icon
                  :name="
                    isExpanded(entryKey(entry, idx))
                      ? 'lucide:chevron-up'
                      : 'lucide:chevron-down'
                  "
                  class="w-3.5 h-3.5"
                />
              </div>
            </div>

            <!-- Expanded structured attributes & correlation controls -->
            <div
              v-if="hasDetails(entry) && isExpanded(entryKey(entry, idx))"
              class="px-3 pb-3 pt-1.5 bg-(--sub-alt-color)/60 border-t border-(--contrast-border-color)/60 space-y-2 text-xs"
            >
              <div
                v-if="entry.requestId"
                class="flex flex-wrap items-center gap-2"
              >
                <span class="font-semibold opacity-75">Request ID:</span>
                <code
                  class="px-1.5 py-0.5 rounded bg-(--bg-color) border border-(--contrast-border-color) font-mono"
                >
                  {{ entry.requestId }}
                </code>
                <button
                  type="button"
                  class="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-(--contrast-border-color) bg-(--bg-color) cursor-pointer hover:border-(--main-color)"
                  @click.stop="copyRequestId(entry.requestId)"
                >
                  <Icon
                    :name="
                      copiedRequestId === entry.requestId
                        ? 'lucide:check'
                        : 'lucide:copy'
                    "
                    class="w-3 h-3"
                  />
                  <span>{{
                    copiedRequestId === entry.requestId ? 'Copied' : 'Copy'
                  }}</span>
                </button>
                <button
                  type="button"
                  class="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-(--contrast-border-color) bg-(--bg-color) cursor-pointer hover:border-(--main-color)"
                  @click.stop="filterByRequestId(entry.requestId)"
                >
                  <Icon name="lucide:filter" class="w-3 h-3" />
                  <span>Filter request</span>
                </button>
              </div>

              <div v-if="entry.attrs && Object.keys(entry.attrs).length > 0">
                <pre
                  class="p-2.5 rounded-lg bg-(--bg-color) border border-(--contrast-border-color) font-mono text-[11px] overflow-x-auto whitespace-pre-wrap break-all"
                  >{{ formatAttrsJSON(entry.attrs) }}</pre
                >
              </div>
            </div>
          </div>
        </div>

        <!-- Pagination -->
        <div v-if="hasMore" class="flex justify-center pt-1">
          <button
            type="button"
            class="px-4 py-2 text-sm rounded-lg border border-(--contrast-border-color) cursor-pointer hover:bg-(--sub-alt-color) disabled:opacity-50"
            :disabled="loadingMore"
            @click="fetchLogs({ append: true })"
          >
            {{ loadingMore ? 'Loading older logs...' : 'Load older logs' }}
          </button>
        </div>
      </div>
    </SettingsUIGroup>
  </div>
</template>
