<script setup lang="ts">
// Admin Library Management (Calibre import-in-place)
//
// Assumptions:
// - Calibre library is mounted at Delb's `library/` folder
// - Calibre metadata DB exists at `library/metadata.db`
// - Server endpoint exists: POST /api/settings/admin/calibre
//
// This UI intentionally stays lightweight and reports the server summary.
defineOptions({ name: "SettingsAdminLibrary" });

type ImportAction = "import" | "rescan";

type ImportSummary = {
    action: ImportAction;
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

const rescanImportNew = ref(false);
const rescanDryRun = ref(false);
const rescanAttachToCollections = ref(false);

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
        }>("/api/collections", { method: "GET" });

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
                    ...selectedCollectionIds.value.filter(
                        (id) => id !== personal.id,
                    ),
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
    return typeof n === "number" ? n.toLocaleString() : "—";
}

function isValidSelectionForImport(): boolean {
    return selectedCollectionIds.value.length > 0;
}

async function runCalibreAction(
    action: ImportAction,
    opts?: { dryRun?: boolean },
) {
    if (runBusy.value) return;

    runBusy.value = true;
    errorMessage.value = null;
    lastResult.value = null;

    try {
        const body: Record<string, unknown> = { action };

        if (action === "import") {
            body.collectionIds = selectedCollectionIds.value;
            body.dryRun = !!opts?.dryRun;
        } else {
            // rescan
            body.importNew = !!rescanImportNew.value;
            body.dryRun = !!opts?.dryRun;

            if (rescanAttachToCollections.value) {
                body.collectionIds = selectedCollectionIds.value;
            }
        }

        const res = await $fetch<ApiResponse>("/api/settings/admin/calibre", {
            method: "POST",
            body,
        });

        if (!res || (res as { success?: boolean }).success !== true) {
            const msg =
                (res as { message?: string } | undefined)?.message ||
                "Failed to run Calibre action";
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
            e?.data?.message ||
            e?.statusMessage ||
            e?.message ||
            "Unexpected error";
    } finally {
        runBusy.value = false;
    }
}
</script>

<template>
    <div class="w-full">
        <SettingsGroup
            title="library management"
            icon="lucide:library"
            description="import an existing Calibre library mounted at ./library (import-in-place)"
        >
            <div class="mt-2 space-y-3">
                <div class="text-sm opacity-80">
                    <div class="flex items-center gap-2">
                        <span class="font-semibold">Calibre mount:</span>
                        <code class="px-2 py-1 rounded bg-(--sub-color)/15"
                            >library/</code
                        >
                    </div>
                    <div class="flex items-center gap-2 mt-1">
                        <span class="font-semibold">Calibre DB:</span>
                        <code class="px-2 py-1 rounded bg-(--sub-color)/15"
                            >library/metadata.db</code
                        >
                    </div>
                    <div class="mt-2 text-xs opacity-70">
                        Delb will create/update records in
                        <code>data/delb.db</code> and will not move/rename
                        files.
                    </div>
                </div>

                <div class="space-y-2">
                    <div class="text-sm font-semibold">target collections</div>

                    <div v-if="collectionsLoading" class="text-sm opacity-80">
                        Loading collections…
                    </div>

                    <div
                        v-else-if="!collections.length"
                        class="text-sm opacity-80"
                    >
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
                            All books will be imported to your Personal
                            collection by default. Any additional checked
                            collections will also receive the imported books.
                        </div>
                    </div>
                </div>
            </div>
        </SettingsGroup>

        <SettingsGroup
            title="import from calibre"
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
                        @click="
                            runCalibreAction('import', { dryRun: importDryRun })
                        "
                    >
                        {{ runBusy ? "Running..." : "Import from Calibre" }}
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
        </SettingsGroup>

        <SettingsGroup
            title="re-scan calibre"
            icon="lucide:refresh-cw"
            description="refresh metadata, covers, and linked files from library/metadata.db"
        >
            <div class="mt-4 space-y-3">
                <label class="flex items-center gap-2 text-sm">
                    <input
                        v-model="rescanDryRun"
                        type="checkbox"
                        :disabled="runBusy"
                        class="peer sr-only"
                    />
                    <span
                        class="h-5 w-5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer"
                    ></span>
                    <span>dry run (preview only; no changes)</span>
                </label>

                <label class="flex items-center gap-2 text-sm">
                    <input
                        v-model="rescanImportNew"
                        type="checkbox"
                        :disabled="runBusy"
                        class="peer sr-only"
                    />
                    <span
                        class="h-5 w-5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer"
                    ></span>
                    <span>import new books discovered during rescan</span>
                </label>

                <label class="flex items-center gap-2 text-sm">
                    <input
                        v-model="rescanAttachToCollections"
                        type="checkbox"
                        :disabled="runBusy"
                        class="peer sr-only"
                    />
                    <span
                        class="h-5 w-5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer"
                    ></span>
                    <span
                        >also add (updated/imported) books to selected
                        collections</span
                    >
                </label>

                <div class="flex gap-2">
                    <button
                        class="px-3 py-2 bg-(--sub-color)/15 disabled:opacity-50"
                        :disabled="
                            runBusy ||
                            (rescanAttachToCollections &&
                                !selectedCollectionIds.length)
                        "
                        @click="
                            runCalibreAction('rescan', { dryRun: rescanDryRun })
                        "
                    >
                        {{ runBusy ? "Running..." : "Re-scan Calibre" }}
                    </button>
                </div>

                <div
                    v-if="
                        rescanAttachToCollections &&
                        !selectedCollectionIds.length
                    "
                    class="text-xs text-(--error-color)"
                >
                    Select at least one collection (or disable “add to
                    collections”).
                </div>
            </div>
        </SettingsGroup>

        <SettingsGroup
            v-if="lastResult"
            title="last run summary"
            icon="lucide:clipboard-list"
            description="results from the most recent import/rescan"
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
                            {{
                                formatNumber(lastResult.scanned.calibreAuthors)
                            }}
                            <span class="opacity-70">
                                (links:
                                {{
                                    formatNumber(
                                        lastResult.scanned
                                            .calibreBookAuthorLinks,
                                    )
                                }})
                            </span>
                        </div>

                        <div>
                            tags:
                            {{ formatNumber(lastResult.scanned.calibreTags) }}
                            <span class="opacity-70">
                                (links:
                                {{
                                    formatNumber(
                                        lastResult.scanned.calibreBookTagLinks,
                                    )
                                }})
                            </span>
                        </div>

                        <div>
                            publishers:
                            {{
                                formatNumber(
                                    lastResult.scanned.calibrePublishers,
                                )
                            }}
                            <span class="opacity-70">
                                (links:
                                {{
                                    formatNumber(
                                        lastResult.scanned
                                            .calibreBookPublisherLinks,
                                    )
                                }})
                            </span>
                        </div>

                        <div>
                            series:
                            {{ formatNumber(lastResult.scanned.calibreSeries) }}
                            <span class="opacity-70">
                                (links:
                                {{
                                    formatNumber(
                                        lastResult.scanned
                                            .calibreBookSeriesLinks,
                                    )
                                }})
                            </span>
                        </div>

                        <div>
                            identifiers:
                            {{
                                formatNumber(
                                    lastResult.scanned.calibreIdentifiers,
                                )
                            }}
                        </div>
                        <div>
                            format files (from DB):
                            {{
                                formatNumber(
                                    lastResult.scanned.calibreFormatFilesFromDb,
                                )
                            }}
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
                            {{
                                formatNumber(lastResult.results.authorsCreated)
                            }}
                            <span class="opacity-70">
                                (links:
                                {{
                                    formatNumber(
                                        lastResult.results
                                            .bookAuthorLinksUpserted,
                                    )
                                }})
                            </span>
                        </div>

                        <div>
                            tags created:
                            {{ formatNumber(lastResult.results.tagsCreated) }}
                            <span class="opacity-70">
                                (links:
                                {{
                                    formatNumber(
                                        lastResult.results.bookTagLinksUpserted,
                                    )
                                }})
                            </span>
                        </div>

                        <div>
                            publishers created:
                            {{
                                formatNumber(
                                    lastResult.results.publishersCreated,
                                )
                            }}
                            <span class="opacity-70">
                                (links:
                                {{
                                    formatNumber(
                                        lastResult.results
                                            .bookPublisherLinksUpserted,
                                    )
                                }})
                            </span>
                        </div>
                        <div>
                            series created:
                            {{ formatNumber(lastResult.results.seriesCreated) }}
                            <span class="opacity-70">
                                (links:
                                {{
                                    formatNumber(
                                        lastResult.results
                                            .bookSeriesLinksUpserted,
                                    )
                                }})
                            </span>
                        </div>

                        <div>
                            identifiers upserted:
                            {{
                                formatNumber(
                                    lastResult.results.identifiersUpserted,
                                )
                            }}
                        </div>
                        <div>
                            collection links added:
                            {{
                                formatNumber(
                                    lastResult.results.collectionLinksAdded,
                                )
                            }}
                        </div>
                    </div>
                </div>

                <div class="p-3 rounded border border-(--sub-color)/30">
                    <div class="font-semibold mb-2">notes</div>
                    <div>
                        cover candidates checked:
                        {{
                            formatNumber(
                                lastResult.results.coverCandidatesFound,
                            )
                        }}
                    </div>
                    <div>
                        covers set:
                        {{ formatNumber(lastResult.results.coverPathsSet) }}
                    </div>
                    <div>
                        books missing Calibre path:
                        {{
                            formatNumber(
                                lastResult.results.bookPathsMissingInCalibre,
                            )
                        }}
                    </div>
                    <div>
                        files discovered by directory scan:
                        {{
                            formatNumber(
                                lastResult.results.filesDiscoveredByDirScan,
                            )
                        }}
                    </div>

                    <div
                        v-if="lastResult.results.warnings?.length"
                        class="mt-2"
                    >
                        <div class="font-semibold text-(--error-color)">
                            warnings
                        </div>
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
        </SettingsGroup>

        <div v-if="errorMessage" class="mt-3 text-sm text-(--error-color)">
            {{ errorMessage }}
        </div>
    </div>
</template>
