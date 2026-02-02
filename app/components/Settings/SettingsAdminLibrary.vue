<script setup lang="ts">
// Admin Library Management (Calibre migration)
//
// Assumptions:
// - Calibre library is mounted at Delb's `calibre/` folder
// - Calibre metadata DB exists at `calibre/metadata.db`
// - Server endpoint exists: POST /api/settings/admin/calibre
//
// This UI intentionally stays lightweight and reports the server summary.
defineOptions({ name: 'SettingsAdminLibrary' });

type HealthMode = 'quick' | 'deep';
type HealthStatus = 'ok' | 'warn' | 'error';

type HealthCheckResult = {
  id: string;
  name: string;
  status: HealthStatus;
  message: string;
  howToFix?: string;
  meta?: Record<string, unknown>;
  sample?: Array<Record<string, unknown>>;
};

type HealthReport = {
  mode: HealthMode;
  startedAt: string;
  finishedAt: string;
  overall: HealthStatus;
  results: HealthCheckResult[];
};

type ImportSummary = {
  action: 'import';
  dryRun: boolean;
  libraryRoot: string;
  calibreDbPath: string;

  scanned: {
    // entity counts
    calibreBooks: number;
    calibreAuthors: number;
    calibreTags: number;
    calibrePublishers: number;
    calibreSeries: number;

    // link counts (join tables)
    calibreBookAuthorLinks: number;
    calibreBookTagLinks: number;
    calibreBookPublisherLinks: number;
    calibreBookSeriesLinks: number;

    // other
    calibreIdentifiers: number;
    calibreFormatFilesFromDb: number;
  };

  results: {
    booksCreated: number;
    booksUpdated: number;
    filesUpserted: number;

    // entity creates/resolution
    authorsCreated: number;
    tagsCreated: number;
    publishersCreated: number;
    seriesCreated: number;

    // per-book links/upserts
    identifiersUpserted: number;
    bookAuthorLinksUpserted: number;
    bookTagLinksUpserted: number;
    bookPublisherLinksUpserted: number;
    bookSeriesLinksUpserted: number;

    // collections
    collectionLinksAdded: number;

    coverCandidatesFound: number;
    coverPathsSet: number;
    bookPathsMissingInCalibre: number;
    filesDiscoveredByDirScan: number;
    warnings: string[];
  };
};

type ApiResponse =
  | { success: true; data: ImportSummary }
  | { success: false; message?: string };

type CollectionOption = { id: string; name: string; isPersonal?: boolean };

const collectionsLoading = ref(false);
const collections = ref<CollectionOption[]>([]);
const selectedCollectionIds = ref<string[]>([]);

const runBusy = ref(false);
const lastResult = ref<ImportSummary | null>(null);
const errorMessage = ref<string | null>(null);

const importDryRun = ref(false);

type HealthApiResponse =
  | { success: true; data: HealthReport }
  | { success: false; message?: string };

const healthBusy = ref(false);
const healthReport = ref<HealthReport | null>(null);
const healthErrorMessage = ref<string | null>(null);

async function fetchCollections() {
  collectionsLoading.value = true;
  try {
    const res = await $fetch<{
      success: boolean;
      data?: {
        collections?: Array<{
          id: string;
          name: string;
          isPersonal?: boolean;
        }>;
      };
    }>('/api/collections', { method: 'GET' });

    collections.value = (res?.data?.collections ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      isPersonal: Boolean(c.isPersonal),
    }));

    // Ensure Personal is always selected (cannot be unchecked).
    const personal = collections.value.find((c) => c.isPersonal);
    if (personal) {
      if (!selectedCollectionIds.value.includes(personal.id)) {
        selectedCollectionIds.value = [
          personal.id,
          ...selectedCollectionIds.value.filter((id) => id !== personal.id),
        ];
      }
    } else if (
      !selectedCollectionIds.value.length &&
      collections.value.length
    ) {
      // Fallback if something is misconfigured and no personal collection is returned.
      selectedCollectionIds.value = [collections.value[0]!.id];
    }
  } finally {
    collectionsLoading.value = false;
  }
}

onMounted(fetchCollections);

function formatNumber(n: unknown): string {
  return typeof n === 'number' ? n.toLocaleString() : '—';
}

function isValidSelectionForImport(): boolean {
  return selectedCollectionIds.value.length > 0;
}

function statusClass(status: HealthStatus): string {
  return status === 'error'
    ? 'text-(--error-color)'
    : status === 'warn'
      ? 'text-yellow-600 dark:text-yellow-400'
      : 'text-green-600 dark:text-green-400';
}

async function runHealthChecks(mode: HealthMode) {
  if (healthBusy.value) return;

  healthBusy.value = true;
  healthErrorMessage.value = null;

  try {
    const res = await $fetch<HealthApiResponse>('/api/settings/admin/health', {
      method: 'POST',
      body: { mode },
    });

    if (!res || (res as { success?: boolean }).success !== true) {
      const msg =
        (res as { message?: string } | undefined)?.message ||
        'Failed to run health checks';
      healthErrorMessage.value = msg;
      return;
    }

    healthReport.value = (res as { success: true; data: HealthReport }).data;
  } catch (err) {
    const e = err as {
      data?: { message?: string };
      statusMessage?: string;
      message?: string;
    };
    healthErrorMessage.value =
      e?.data?.message || e?.statusMessage || e?.message || 'Unexpected error';
  } finally {
    healthBusy.value = false;
  }
}

async function runCalibreImport(opts?: { dryRun?: boolean }) {
  if (runBusy.value) return;

  runBusy.value = true;
  errorMessage.value = null;
  lastResult.value = null;

  try {
    const body: Record<string, unknown> = {
      action: 'import',
      collectionIds: selectedCollectionIds.value,
      dryRun: !!opts?.dryRun,
    };

    const res = await $fetch<ApiResponse>('/api/settings/admin/calibre', {
      method: 'POST',
      body,
    });

    if (!res || (res as { success?: boolean }).success !== true) {
      const msg =
        (res as { message?: string } | undefined)?.message ||
        'Failed to run Calibre action';
      errorMessage.value = msg;
      return;
    }

    lastResult.value = (res as { success: true; data: ImportSummary }).data;
  } catch (err) {
    const e = err as {
      data?: { message?: string };
      statusMessage?: string;
      message?: string;
    };
    errorMessage.value =
      e?.data?.message || e?.statusMessage || e?.message || 'Unexpected error';
  } finally {
    runBusy.value = false;
  }
}
</script>

<template>
  <div class="w-full">
    <SettingsUIGroup
      title="Library Management"
      icon="lucide:library"
      description="migrate an existing Calibre library mounted at ./calibre into Delb’s library"
    >
      <div class="mt-2 space-y-3">
        <div class="text-sm opacity-80">
          <div class="flex items-center gap-2">
            <span class="font-semibold">Calibre mount:</span>
            <code class="px-2 py-1 rounded bg-(--sub-color)/15">calibre/</code>
          </div>
          <div class="flex items-center gap-2 mt-1">
            <span class="font-semibold">Calibre DB:</span>
            <code class="px-2 py-1 rounded bg-(--sub-color)/15"
              >calibre/metadata.db</code
            >
          </div>
          <div class="mt-2 text-xs opacity-70">
            Delb will create/update records in
            <code>data/delb.db</code> and will copy files into
            <code>library/</code>.
          </div>
        </div>

        <div class="space-y-2">
          <div class="text-sm font-semibold">target collections</div>

          <div v-if="collectionsLoading" class="text-sm opacity-80">
            Loading collections…
          </div>

          <div v-else-if="!collections.length" class="text-sm opacity-80">
            No collections yet.
          </div>

          <div v-else class="space-y-1">
            <label
              v-for="c in collections"
              :key="c.id"
              class="flex items-center gap-2 text-sm"
            >
              <input
                v-model="selectedCollectionIds"
                type="checkbox"
                :value="c.id"
                :disabled="runBusy || c.isPersonal"
                class="peer sr-only"
              />
              <span
                class="h-5 w-5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer"
                :class="
                  runBusy || c.isPersonal
                    ? 'peer-checked:bg-(--sub-color) cursor-default!'
                    : ''
                "
              ></span>
              <span class="truncate">{{ c.name }}</span>
              <span
                v-if="c.isPersonal"
                class="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-(--sub-color) opacity-70"
              >
                Personal
              </span>
            </label>

            <div class="text-xs opacity-70">
              All books will be imported to your Personal collection by default.
              Any additional checked collections will also receive the imported
              books.
            </div>
          </div>
        </div>
      </div>
    </SettingsUIGroup>

    <SettingsUIGroup
      title="Import From Calibre"
      icon="lucide:download"
      description="one-time import of metadata + file pointers (idempotent via calibre book id)"
    >
      <div class="mt-4 space-y-3">
        <label class="flex items-center gap-2 text-sm">
          <input
            v-model="importDryRun"
            type="checkbox"
            :disabled="runBusy"
            class="peer sr-only"
          />
          <span
            class="h-5 w-5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer"
          ></span>

          <span>dry run (preview only; no changes)</span>
        </label>

        <div class="flex gap-2">
          <button
            class="px-3 py-2 bg-(--sub-color)/15 disabled:opacity-50"
            :disabled="runBusy || !isValidSelectionForImport()"
            @click="runCalibreImport({ dryRun: importDryRun })"
          >
            {{ runBusy ? 'Running...' : 'Import from Calibre' }}
          </button>

          <button
            class="px-3 py-2 bg-(--sub-color)/15 disabled:opacity-50"
            :disabled="runBusy"
            @click="fetchCollections"
          >
            Refresh collections
          </button>
        </div>

        <div
          v-if="!isValidSelectionForImport()"
          class="text-xs text-(--error-color)"
        >
          Select at least one collection before importing.
        </div>
      </div>
    </SettingsUIGroup>

    <SettingsUIGroup
      title="Health Checks"
      icon="lucide:heart-pulse"
      description="find common library/database issues that affect the user experience"
    >
      <div class="mt-4 space-y-3">
        <div class="flex flex-wrap gap-2">
          <button
            class="px-3 py-2 bg-(--sub-color)/15 disabled:opacity-50"
            :disabled="healthBusy"
            @click="runHealthChecks('quick')"
          >
            {{ healthBusy ? 'Running...' : 'Run quick checks' }}
          </button>

          <button
            class="px-3 py-2 bg-(--sub-color)/15 disabled:opacity-50"
            :disabled="healthBusy"
            @click="runHealthChecks('deep')"
          >
            {{ healthBusy ? 'Running...' : 'Run deep checks' }}
          </button>
        </div>

        <div v-if="healthErrorMessage" class="text-sm text-(--error-color)">
          {{ healthErrorMessage }}
        </div>

        <div v-if="healthReport" class="space-y-3">
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <span class="font-semibold">overall:</span>
            <span
              class="font-mono"
              :class="statusClass(healthReport.overall)"
              >{{ healthReport.overall }}</span
            >
            <span class="opacity-70">
              ({{ healthReport.mode }}, {{ healthReport.startedAt }} →
              {{ healthReport.finishedAt }})
            </span>
          </div>

          <div class="space-y-2">
            <div
              v-for="r in healthReport.results"
              :key="r.id"
              class="p-3 rounded border border-(--sub-color)/30"
            >
              <div class="flex items-center justify-between gap-3">
                <div class="font-semibold text-sm">{{ r.name }}</div>
                <div class="font-mono text-sm" :class="statusClass(r.status)">
                  {{ r.status }}
                </div>
              </div>
              <div class="text-sm opacity-90 mt-1">{{ r.message }}</div>
              <div v-if="r.howToFix" class="text-xs opacity-70 mt-2">
                {{ r.howToFix }}
              </div>

              <details
                v-if="(r.sample && r.sample.length) || r.meta"
                class="mt-2 text-xs opacity-80"
              >
                <summary class="cursor-pointer select-none">details</summary>
                <div v-if="r.meta" class="mt-2">
                  <pre class="whitespace-pre-wrap">{{
                    JSON.stringify(r.meta, null, 2)
                  }}</pre>
                </div>
                <div v-if="r.sample && r.sample.length" class="mt-2">
                  <pre class="whitespace-pre-wrap">{{
                    JSON.stringify(r.sample, null, 2)
                  }}</pre>
                </div>
              </details>
            </div>
          </div>
        </div>
      </div>
    </SettingsUIGroup>

    <SettingsUIGroup
      v-if="lastResult"
      title="Last Run Summary"
      icon="lucide:clipboard-list"
      description="results from the most recent import"
    >
      <div class="mt-4 space-y-3 text-sm">
        <div class="flex flex-wrap gap-2 items-center">
          <span class="font-semibold">action:</span>
          <code class="px-2 py-1 rounded bg-(--sub-color)/15">{{
            lastResult.action
          }}</code>

          <span class="font-semibold">dry run:</span>
          <code class="px-2 py-1 rounded bg-(--sub-color)/15">{{
            lastResult.dryRun
          }}</code>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div class="p-3 rounded border border-(--sub-color)/30">
            <div class="font-semibold mb-2">scanned (calibre)</div>
            <div>
              books:
              {{ formatNumber(lastResult.scanned.calibreBooks) }}
            </div>

            <div>
              authors:
              {{ formatNumber(lastResult.scanned.calibreAuthors) }}
              <span class="opacity-70">
                (links:
                {{ formatNumber(lastResult.scanned.calibreBookAuthorLinks) }})
              </span>
            </div>

            <div>
              tags:
              {{ formatNumber(lastResult.scanned.calibreTags) }}
              <span class="opacity-70">
                (links:
                {{ formatNumber(lastResult.scanned.calibreBookTagLinks) }})
              </span>
            </div>

            <div>
              publishers:
              {{ formatNumber(lastResult.scanned.calibrePublishers) }}
              <span class="opacity-70">
                (links:
                {{
                  formatNumber(lastResult.scanned.calibreBookPublisherLinks)
                }})
              </span>
            </div>

            <div>
              series:
              {{ formatNumber(lastResult.scanned.calibreSeries) }}
              <span class="opacity-70">
                (links:
                {{ formatNumber(lastResult.scanned.calibreBookSeriesLinks) }})
              </span>
            </div>

            <div>
              identifiers:
              {{ formatNumber(lastResult.scanned.calibreIdentifiers) }}
            </div>
            <div>
              format files (from DB):
              {{ formatNumber(lastResult.scanned.calibreFormatFilesFromDb) }}
            </div>
          </div>

          <div class="p-3 rounded border border-(--sub-color)/30">
            <div class="font-semibold mb-2">delb changes</div>
            <div>
              books created:
              {{ formatNumber(lastResult.results.booksCreated) }}
            </div>
            <div>
              books updated:
              {{ formatNumber(lastResult.results.booksUpdated) }}
            </div>
            <div>
              files linked:
              {{ formatNumber(lastResult.results.filesUpserted) }}
            </div>

            <div>
              authors created:
              {{ formatNumber(lastResult.results.authorsCreated) }}
              <span class="opacity-70">
                (links:
                {{ formatNumber(lastResult.results.bookAuthorLinksUpserted) }})
              </span>
            </div>

            <div>
              tags created:
              {{ formatNumber(lastResult.results.tagsCreated) }}
              <span class="opacity-70">
                (links:
                {{ formatNumber(lastResult.results.bookTagLinksUpserted) }})
              </span>
            </div>

            <div>
              publishers created:
              {{ formatNumber(lastResult.results.publishersCreated) }}
              <span class="opacity-70">
                (links:
                {{
                  formatNumber(lastResult.results.bookPublisherLinksUpserted)
                }})
              </span>
            </div>
            <div>
              series created:
              {{ formatNumber(lastResult.results.seriesCreated) }}
              <span class="opacity-70">
                (links:
                {{ formatNumber(lastResult.results.bookSeriesLinksUpserted) }})
              </span>
            </div>

            <div>
              identifiers upserted:
              {{ formatNumber(lastResult.results.identifiersUpserted) }}
            </div>
            <div>
              collection links added:
              {{ formatNumber(lastResult.results.collectionLinksAdded) }}
            </div>
          </div>
        </div>

        <div class="p-3 rounded border border-(--sub-color)/30">
          <div class="font-semibold mb-2">notes</div>
          <div>
            cover candidates checked:
            {{ formatNumber(lastResult.results.coverCandidatesFound) }}
          </div>
          <div>
            covers set:
            {{ formatNumber(lastResult.results.coverPathsSet) }}
          </div>
          <div>
            books missing Calibre path:
            {{ formatNumber(lastResult.results.bookPathsMissingInCalibre) }}
          </div>
          <div>
            files discovered by directory scan:
            {{ formatNumber(lastResult.results.filesDiscoveredByDirScan) }}
          </div>

          <div v-if="lastResult.results.warnings?.length" class="mt-2">
            <div class="font-semibold text-(--error-color)">warnings</div>
            <ul class="list-disc ml-5">
              <li
                v-for="(w, i) in lastResult.results.warnings"
                :key="`${i}-${w}`"
              >
                {{ w }}
              </li>
            </ul>
          </div>
        </div>
      </div>
    </SettingsUIGroup>

    <div v-if="errorMessage" class="mt-3 text-sm text-(--error-color)">
      {{ errorMessage }}
    </div>
  </div>
</template>
