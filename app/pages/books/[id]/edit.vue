<script setup lang="ts">
/**
 * Note: Nuxt auto-imports composables/macros like `definePageMeta`, `useHead`, etc.
 * If TypeScript isn't recognizing them (editor/tsserver), restart the dev server
 * and make sure `.nuxt` types are being picked up.
 */
definePageMeta({
    auth: {
        only: "user",
        redirectGuestTo: "/login",
    },
    middleware: [
        async () => {
            const auth = useAuth();
            // Ensure we have a session/user loaded (global auth middleware doesn't enforce roles)
            await auth.fetchSession();
            if (!auth.isAdmin.value) {
                return navigateTo("/", { replace: true });
            }
        },
    ],
});

useHead({
    title: "Edit Book",
});

type Book = {
    id: string;
    title: string;
    coverImagePath?: string | null;
    description?: string | null;
    published?: string | null;
    language?: string | null;

    // related entities (denormalized by API)
    authors?: { id: string; name: string; position?: number | null }[];
    tags?: { id: string; name: string }[];

    publisher?: { id: string; name: string } | null;
    series?: { id: string; name: string; index?: number | null } | null;
};

type BookGetResponse = {
    success?: boolean;
    message?: string;
    data?: {
        book?: Book;
        authors?: { id: string; name: string; position?: number | null }[];
    };
};

type SearchResponse = {
    success?: boolean;
    message?: string;
    data?: {
        results?: { id: string; name: string }[];
    };
};

type NameChip = {
    id?: string; // present when linked to an existing DB row
    name: string;
};

const route = useRoute();
const router = useRouter();

const bookId = computed(() => String(route.params.id || ""));

const loading = ref(false);
const saving = ref(false);
const errorMessage = ref<string | null>(null);
const successMessage = ref<string | null>(null);

const book = ref<Book | null>(null);

const coverUrl = computed(() => {
    const b = book.value;
    if (!b?.coverImagePath) return null;

    // Stored as: library/<author>/<title>/cover.webp
    // API expects: /api/media/covers/<path under library>
    return `/api/media/covers/${b.coverImagePath.replace(/^library\//, "")}`;
});

// Cover upload UI
const coverFileInput = ref<HTMLInputElement | null>(null);
const selectedCoverFile = ref<File | null>(null);
const coverPreviewUrl = ref<string | null>(null);
const coverUploading = ref(false);

// Cover-from-URL preview (client-side fetch)
const coverUrlInput = ref("");
const coverUrlLoading = ref(false);
let lastCoverUrlAbort: AbortController | null = null;

function pickCoverFile() {
    coverFileInput.value?.click();
}

function revokeCoverPreviewUrl() {
    if (coverPreviewUrl.value) {
        URL.revokeObjectURL(coverPreviewUrl.value);
        coverPreviewUrl.value = null;
    }
}

function onCoverFileChange(e: Event) {
    const input = e.target as HTMLInputElement | null;
    const file = input?.files?.[0] ?? null;

    selectedCoverFile.value = file;

    revokeCoverPreviewUrl();
    coverPreviewUrl.value = file ? URL.createObjectURL(file) : null;
}

function clearSelectedCover() {
    selectedCoverFile.value = null;

    revokeCoverPreviewUrl();

    if (coverFileInput.value) {
        coverFileInput.value.value = "";
    }
}

async function previewCoverFromUrl() {
    const url = coverUrlInput.value.trim();
    if (!url) return;

    if (coverUrlLoading.value) return;

    // Cancel any in-flight fetch
    if (lastCoverUrlAbort) {
        lastCoverUrlAbort.abort();
        lastCoverUrlAbort = null;
    }

    const controller = new AbortController();
    lastCoverUrlAbort = controller;

    coverUrlLoading.value = true;
    errorMessage.value = null;
    successMessage.value = null;

    try {
        const res = await fetch(url, { signal: controller.signal });

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            setError(text || `Failed to fetch image (${res.status}).`);
            return;
        }

        const contentType = res.headers.get("content-type") || "";
        if (!contentType.toLowerCase().startsWith("image/")) {
            setError("URL did not return an image.");
            return;
        }

        const blob = await res.blob();

        // Convert to File so existing upload logic works unchanged
        const filenameFromUrl = (() => {
            try {
                const u = new URL(url);
                const base = u.pathname.split("/").filter(Boolean).pop() || "";
                return base || "cover";
            } catch {
                return "cover";
            }
        })();

        const file = new File([blob], filenameFromUrl, {
            type: contentType || blob.type || "image/*",
        });

        selectedCoverFile.value = file;

        revokeCoverPreviewUrl();
        coverPreviewUrl.value = URL.createObjectURL(file);

        setSuccess("Preview loaded. Click Upload to save.");
    } catch (e: unknown) {
        // Ignore abort errors
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to fetch image.");
    } finally {
        coverUrlLoading.value = false;
        lastCoverUrlAbort = null;
    }
}

function clearCoverUrlPreview() {
    coverUrlInput.value = "";
    clearSelectedCover();
}

async function uploadCover() {
    if (!book.value?.id) return;
    if (!selectedCoverFile.value) return;
    if (coverUploading.value) return;

    coverUploading.value = true;
    errorMessage.value = null;
    successMessage.value = null;

    try {
        const fd = new FormData();
        fd.append("file", selectedCoverFile.value);

        const res = await fetch(
            `/api/books/${encodeURIComponent(book.value.id)}/cover`,
            {
                method: "POST",
                body: fd,
            },
        );

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            setError(text || `Failed to upload cover (${res.status}).`);
            return;
        }

        setSuccess("Cover uploaded.");
        clearSelectedCover();

        // Reload the book so `coverImagePath` refreshes
        await loadBook();
    } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to upload cover.");
    } finally {
        coverUploading.value = false;
    }
}

onBeforeUnmount(() => {
    if (lastCoverUrlAbort) {
        lastCoverUrlAbort.abort();
        lastCoverUrlAbort = null;
    }

    revokeCoverPreviewUrl();
});

const form = reactive({
    title: "",
    description: "",
    published: "", // date-only (YYYY-MM-DD)
    language: "",

    // Chip editors store names in the UI; server resolves/creates and links.
    publisher: "" as string,
    series: "" as string,
    seriesIndex: "" as string, // keep as string for input
});

// Authors (chips + typeahead)
const authorInput = ref("");
const authorChips = ref<NameChip[]>([]);
const authorSuggestions = ref<{ id: string; name: string }[]>([]);
const authorSuggestOpen = ref(false);
const authorSearching = ref(false);
let authorSearchTimer: ReturnType<typeof setTimeout> | null = null;

const tagInput = ref("");
const tagChips = ref<NameChip[]>([]);
const tagSuggestions = ref<{ id: string; name: string }[]>([]);
const tagSuggestOpen = ref(false);
const tagSearching = ref(false);
let tagSearchTimer: ReturnType<typeof setTimeout> | null = null;

const publisherInput = ref("");
const publisherSuggestions = ref<{ id: string; name: string }[]>([]);
const publisherSuggestOpen = ref(false);
const publisherSearching = ref(false);
let publisherSearchTimer: ReturnType<typeof setTimeout> | null = null;

const seriesInput = ref("");
const seriesSuggestions = ref<{ id: string; name: string }[]>([]);
const seriesSuggestOpen = ref(false);
const seriesSearching = ref(false);
const seriesFocused = ref(false);
let seriesSearchTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeName(name: string): string {
    return (name ?? "").toString().replace(/\s+/g, " ").trim();
}

function splitTokens(input: string): string[] {
    // Split on commas; ignore empties
    return (input ?? "")
        .split(",")
        .map((s) => normalizeName(s))
        .filter((s) => s.length > 0);
}

function formatDateOnly(input: string): string {
    const raw = (input ?? "").toString().trim();
    if (!raw) return "";

    // If server stored an ISO timestamp, strip to YYYY-MM-DD.
    const isoPrefix = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoPrefix?.[1]) return isoPrefix[1];

    // If someone typed slashes (YYYY/MM/DD), normalize.
    const slash = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (slash) return `${slash[1]}-${slash[2]}-${slash[3]}`;

    // Otherwise leave it as-is (but UI hints encourage YYYY-MM-DD).
    return raw;
}

/**
 * Pure chip helpers (avoid Vue template ref auto-unwrapping issues).
 */
function chipNormalize(name: string): string {
    return normalizeName(name);
}

function chipAdd(chips: NameChip[], name: string): NameChip[] {
    const cleaned = chipNormalize(name);
    if (!cleaned) return chips;

    const exists = chips.some(
        (c) => c.name.toLowerCase() === cleaned.toLowerCase(),
    );
    if (exists) return chips;

    return [...chips, { name: cleaned }];
}

function chipAddFromSuggestion(
    chips: NameChip[],
    suggestion: { id: string; name: string },
): NameChip[] {
    const cleaned = chipNormalize(suggestion.name);
    if (!cleaned) return chips;

    const exists = chips.some((c) => {
        if (c.id && c.id === suggestion.id) return true;
        return c.name.toLowerCase() === cleaned.toLowerCase();
    });
    if (exists) return chips;

    return [...chips, { id: suggestion.id, name: cleaned }];
}

function chipRemove(chips: NameChip[], index: number): NameChip[] {
    if (index < 0 || index >= chips.length) return chips;
    return chips.filter((_, i) => i !== index);
}

function chipCommitFromComma(
    chips: NameChip[],
    input: string,
): { chips: NameChip[]; input: string; committed: boolean } {
    if (!input.includes(",")) return { chips, input, committed: false };

    const tokens = splitTokens(input);
    const endsWithComma = input.trimEnd().endsWith(",");

    if (endsWithComma) {
        let next = chips;
        for (const t of tokens) next = chipAdd(next, t);
        return { chips: next, input: "", committed: true };
    }

    // commit all but last token
    if (tokens.length <= 1) return { chips, input, committed: false };

    let next = chips;
    for (const t of tokens.slice(0, -1)) next = chipAdd(next, t);

    const keep = tokens[tokens.length - 1] ?? "";
    return { chips: next, input: keep, committed: true };
}

function chipCommitOnEnter(
    chips: NameChip[],
    input: string,
): { chips: NameChip[]; input: string; committed: boolean } {
    const tokens = splitTokens(input);
    if (!tokens.length) return { chips, input, committed: false };

    let next = chips;
    for (const t of tokens) next = chipAdd(next, t);

    return { chips: next, input: "", committed: true };
}

async function fetchSuggestions(
    endpoint: string,
    query: string,
    take: number,
): Promise<{ id: string; name: string }[]> {
    const q = normalizeName(query);
    if (!q) return [];

    const res = await fetch(
        `${endpoint}?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(take))}`,
        { method: "GET", headers: { Accept: "application/json" } },
    );
    if (!res.ok) return [];

    const json = (await res.json()) as SearchResponse;
    return (json?.data?.results ?? []).slice(0, take);
}

async function fetchAuthorSuggestions(query: string) {
    const q = normalizeName(query);
    if (!q) {
        authorSuggestions.value = [];
        authorSuggestOpen.value = false;
        return;
    }

    authorSearching.value = true;
    try {
        const results = await fetchSuggestions("/api/authors/search", q, 5);

        const filtered = results.filter((r) => {
            const nm = normalizeName(r.name).toLowerCase();
            return !authorChips.value.some(
                (c) => (c.id && c.id === r.id) || c.name.toLowerCase() === nm,
            );
        });

        authorSuggestions.value = filtered;
        authorSuggestOpen.value = true;
    } finally {
        authorSearching.value = false;
    }
}

async function fetchTagSuggestions(query: string) {
    const q = normalizeName(query);
    if (!q) {
        tagSuggestions.value = [];
        tagSuggestOpen.value = false;
        return;
    }

    tagSearching.value = true;
    try {
        const results = await fetchSuggestions("/api/tags/search", q, 8);

        const filtered = results.filter((r) => {
            const nm = normalizeName(r.name).toLowerCase();
            return !tagChips.value.some(
                (c) => (c.id && c.id === r.id) || c.name.toLowerCase() === nm,
            );
        });

        tagSuggestions.value = filtered;
        tagSuggestOpen.value = true;
    } finally {
        tagSearching.value = false;
    }
}

async function fetchPublisherSuggestions(query: string) {
    const q = normalizeName(query);
    if (!q) {
        publisherSuggestions.value = [];
        publisherSuggestOpen.value = false;
        return;
    }

    publisherSearching.value = true;
    try {
        const results = await fetchSuggestions("/api/publishers/search", q, 5);
        publisherSuggestions.value = results;
        publisherSuggestOpen.value = true;
    } finally {
        publisherSearching.value = false;
    }
}

async function fetchSeriesSuggestions(query: string) {
    const q = normalizeName(query);
    if (!q) {
        seriesSuggestions.value = [];
        seriesSuggestOpen.value = false;
        return;
    }

    seriesSearching.value = true;
    try {
        const results = await fetchSuggestions("/api/series/search", q, 5);
        seriesSuggestions.value = results;
        seriesSuggestOpen.value = true;
    } finally {
        seriesSearching.value = false;
    }
}

watch(
    () => authorInput.value,
    (v) => {
        const committed = chipCommitFromComma(authorChips.value, v);
        if (committed.committed) {
            authorChips.value = committed.chips;
            authorInput.value = committed.input;
            authorSuggestOpen.value = false;
        }

        // Debounced search for typeahead (only when there is a non-empty token being typed)
        if (authorSearchTimer) {
            clearTimeout(authorSearchTimer);
            authorSearchTimer = null;
        }

        const q = normalizeName(authorInput.value);
        if (!q) {
            authorSuggestions.value = [];
            authorSuggestOpen.value = false;
            return;
        }

        authorSearchTimer = setTimeout(() => {
            fetchAuthorSuggestions(q);
        }, 250);
    },
);

watch(
    () => tagInput.value,
    (v) => {
        const committed = chipCommitFromComma(tagChips.value, v);
        if (committed.committed) {
            tagChips.value = committed.chips;
            tagInput.value = committed.input;
            tagSuggestOpen.value = false;
        }

        if (tagSearchTimer) {
            clearTimeout(tagSearchTimer);
            tagSearchTimer = null;
        }

        const q = normalizeName(tagInput.value);
        if (!q) {
            tagSuggestions.value = [];
            tagSuggestOpen.value = false;
            return;
        }

        tagSearchTimer = setTimeout(() => {
            fetchTagSuggestions(q);
        }, 250);
    },
);

watch(
    () => publisherInput.value,
    (v) => {
        if (publisherSearchTimer) {
            clearTimeout(publisherSearchTimer);
            publisherSearchTimer = null;
        }

        const q = normalizeName(v);
        if (!q) {
            publisherSuggestions.value = [];
            publisherSuggestOpen.value = false;
            return;
        }

        publisherSearchTimer = setTimeout(() => {
            fetchPublisherSuggestions(q);
        }, 250);
    },
);

watch(
    () => seriesInput.value,
    (v) => {
        // Only search/show suggestions while the input is actively focused.
        // This prevents the dropdown from opening on initial hydration when the field has a value.
        if (!seriesFocused.value) return;

        if (seriesSearchTimer) {
            clearTimeout(seriesSearchTimer);
            seriesSearchTimer = null;
        }

        const q = normalizeName(v);
        if (!q) {
            seriesSuggestions.value = [];
            seriesSuggestOpen.value = false;
            return;
        }

        seriesSearchTimer = setTimeout(() => {
            fetchSeriesSuggestions(q);
        }, 250);
    },
);

onBeforeUnmount(() => {
    if (authorSearchTimer) {
        clearTimeout(authorSearchTimer);
        authorSearchTimer = null;
    }
    if (tagSearchTimer) {
        clearTimeout(tagSearchTimer);
        tagSearchTimer = null;
    }
    if (publisherSearchTimer) {
        clearTimeout(publisherSearchTimer);
        publisherSearchTimer = null;
    }
    if (seriesSearchTimer) {
        clearTimeout(seriesSearchTimer);
        seriesSearchTimer = null;
    }
});

function setError(msg: string) {
    errorMessage.value = msg;
    successMessage.value = null;
}

function setSuccess(msg: string) {
    successMessage.value = msg;
    errorMessage.value = null;
}

function bookToForm(b: Book) {
    form.title = b.title ?? "";

    // Hydrate author chips from the ordered author list.
    // We keep both `id` and `name` so chips can be linked to DB authors.
    authorChips.value = (b.authors ?? [])
        .slice()
        .sort((a, c) => {
            const aPos = typeof a.position === "number" ? a.position : 10_000;
            const cPos = typeof c.position === "number" ? c.position : 10_000;
            return aPos - cPos;
        })
        .map((a) => ({
            id: a.id,
            name: a.name,
        }));

    authorInput.value = "";
    authorSuggestions.value = [];
    authorSuggestOpen.value = false;

    form.description = b.description ?? "";
    form.published = formatDateOnly(b.published ?? "");
    form.language = b.language ?? "";

    // Series / publisher are edited by name in the UI.
    form.publisher = b.publisher?.name ?? "";
    form.series = b.series?.name ?? "";
    form.seriesIndex =
        typeof b.series?.index === "number" && !Number.isNaN(b.series.index)
            ? String(b.series.index)
            : "";

    // Tags (chips)
    tagChips.value = (b.tags ?? []).map((t) => ({ id: t.id, name: t.name }));
    tagInput.value = "";
    tagSuggestions.value = [];
    tagSuggestOpen.value = false;

    // Single-value typeaheads
    publisherInput.value = form.publisher;
    seriesInput.value = form.series;
    publisherSuggestions.value = [];
    publisherSuggestOpen.value = false;
    seriesSuggestions.value = [];
    seriesSuggestOpen.value = false;
}

async function loadBook() {
    if (!bookId.value) {
        setError("Missing book id.");
        return;
    }

    loading.value = true;
    errorMessage.value = null;
    successMessage.value = null;

    try {
        const res = await fetch(
            `/api/books/${encodeURIComponent(bookId.value)}`,
            {
                method: "GET",
                headers: {
                    Accept: "application/json",
                },
            },
        );

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            setError(text || `Failed to load book (${res.status}).`);
            return;
        }

        const json = (await res.json()) as BookGetResponse;
        if (!json?.success || !json.data?.book) {
            setError(json?.message || "Failed to load book.");
            return;
        }

        // Ensure authors are present on the book object for form hydration.
        const hydratedBook: Book = {
            ...json.data.book,
            authors: (
                json.data.authors ??
                json.data.book.authors ??
                []
            ).slice(),
        };

        book.value = hydratedBook;
        bookToForm(hydratedBook);
    } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to load book.");
    } finally {
        loading.value = false;
    }
}

function normalizeStringOrNullFromOptional(
    input: string | null | undefined,
): string | null {
    const v = (input ?? "").toString().trim();
    return v.length ? v : null;
}

function normalizeSeriesIndex(input: string): number | null {
    const v = (input ?? "").trim();
    if (!v.length) return null;
    const n = Number(v);
    if (Number.isNaN(n)) {
        throw new Error("Series index must be a number.");
    }
    return n;
}

function normalizeDateOnlyOrNull(input: string): string | null {
    const v = formatDateOnly(input);
    if (!v) return null;

    // Enforce date-only display/saves as YYYY-MM-DD when it looks like a date.
    // If it doesn't match, still allow raw (lean v1), but we won't preserve timestamps.
    const m = v.match(/^(\d{4}-\d{2}-\d{2})$/);
    const dateOnly = m?.[1] ?? null;
    return dateOnly ?? v;
}

async function save() {
    if (!book.value) return;

    saving.value = true;
    errorMessage.value = null;
    successMessage.value = null;

    try {
        // Commit any remaining typed author/tags before saving
        {
            const committed = chipCommitOnEnter(
                authorChips.value,
                authorInput.value,
            );
            if (committed.committed) {
                authorChips.value = committed.chips;
                authorInput.value = committed.input;
                authorSuggestOpen.value = false;
            }
        }
        {
            const committed = chipCommitOnEnter(tagChips.value, tagInput.value);
            if (committed.committed) {
                tagChips.value = committed.chips;
                tagInput.value = committed.input;
                tagSuggestOpen.value = false;
            }
        }

        const payload = {
            title: normalizeStringOrNullFromOptional(form.title),
            // send names (server will link/create as needed)
            authors: authorChips.value.map((c) => c.name),
            tags: tagChips.value.map((c) => c.name),

            description: normalizeStringOrNullFromOptional(form.description),
            published: normalizeDateOnlyOrNull(form.published),
            language: normalizeStringOrNullFromOptional(form.language),

            publisherName: normalizeStringOrNullFromOptional(form.publisher),
            seriesName: normalizeStringOrNullFromOptional(form.series),
            seriesIndex: normalizeSeriesIndex(form.seriesIndex),
        };

        // Title is required server-side; keep lean client-side validation
        if (!payload.title) {
            setError("Title is required.");
            return;
        }

        const res = await fetch(
            `/api/books/${encodeURIComponent(book.value.id)}`,
            {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify(payload),
            },
        );

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            setError(text || `Failed to save (${res.status}).`);
            return;
        }

        setSuccess("Saved.");

        // After a successful save, return to the book page
        backToBook();
    } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to save.");
    } finally {
        saving.value = false;
    }
}

function resetForm() {
    if (book.value) bookToForm(book.value);
    errorMessage.value = null;
    successMessage.value = null;
}

function backToBook() {
    router.push(`/books/${encodeURIComponent(bookId.value)}`);
}

onMounted(() => {
    loadBook();
});

watch(
    () => bookId.value,
    () => {
        loadBook();
    },
);
</script>

<template>
    <div class="flex flex-col w-full h-full overflow-hidden">
        <AppHeader class="w-full" />

        <div class="w-full h-full p-4 overflow-auto">
            <div class="flex items-center gap-2 mb-4 text-(--main-color)">
                <div
                    v-tooltip="'Back to book'"
                    type="button"
                    class="opacity-80 hover:opacity-100 cursor-pointer"
                    @click="backToBook"
                >
                    <icon
                        name="lucide:arrow-left"
                        class="scale-200 translate-x-1"
                    />
                </div>
            </div>

            <div v-if="loading" class="text-sm opacity-80">Loading...</div>

            <div
                v-else-if="errorMessage"
                class="text-sm text-(--error-color) mb-4"
            >
                {{ errorMessage }}
            </div>

            <div v-else-if="!book" class="text-sm opacity-80">
                No book loaded.
            </div>

            <div v-else class="flex flex-col md:flex-row gap-6 items-start">
                <!-- Left column: cover preview + upload -->
                <div
                    class="flex flex-col justify-center items-center w-80 shrink-0"
                >
                    <BookCover
                        :src="coverPreviewUrl ?? coverUrl"
                        :alt="`Cover for ${book.title}`"
                    />

                    <input
                        ref="coverFileInput"
                        class="hidden"
                        type="file"
                        accept="image/*"
                        @change="onCoverFileChange"
                    />

                    <div class="flex flex-wrap gap-1 pt-2 justify-center">
                        <button
                            class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm gap-2! disabled:opacity-60 disabled:cursor-not-allowed"
                            type="button"
                            :disabled="saving || coverUrlLoading"
                            @click="pickCoverFile"
                        >
                            <icon name="lucide:image-up" class="scale-135" />
                            Choose cover
                        </button>

                        <button
                            v-if="selectedCoverFile"
                            class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm gap-2!"
                            type="button"
                            :disabled="saving"
                            @click="clearSelectedCover"
                        >
                            <icon name="lucide:x" class="scale-135" />
                            Clear
                        </button>

                        <button
                            class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm gap-2! disabled:opacity-60 disabled:cursor-not-allowed"
                            type="button"
                            :disabled="
                                saving || coverUploading || !selectedCoverFile
                            "
                            @click="uploadCover"
                        >
                            <icon
                                :name="
                                    coverUploading
                                        ? 'lucide:loader-circle'
                                        : 'lucide:upload'
                                "
                                :class="[
                                    coverUploading ? 'animate-spin' : '',
                                    'scale-135',
                                ]"
                            />
                            {{ coverUploading ? "Uploading..." : "Upload" }}
                        </button>
                    </div>

                    <div class="w-full pt-3">
                        <div class="text-xs opacity-70 mb-1 text-left">
                            Or fetch cover from URL
                        </div>
                        <div class="flex gap-2">
                            <input
                                v-model="coverUrlInput"
                                class="min-w-0 flex-1 px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm"
                                type="url"
                                placeholder="https://example.com/cover.jpg"
                                :disabled="saving || coverUploading"
                                @keydown.enter.prevent="previewCoverFromUrl"
                            />
                            <button
                                class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm gap-2! disabled:opacity-60 disabled:cursor-not-allowed"
                                type="button"
                                :disabled="
                                    saving ||
                                    coverUploading ||
                                    coverUrlLoading ||
                                    !coverUrlInput.trim()
                                "
                                @click="previewCoverFromUrl"
                            >
                                <icon
                                    :name="
                                        coverUrlLoading
                                            ? 'lucide:loader-circle'
                                            : 'lucide:download'
                                    "
                                    :class="[
                                        coverUrlLoading ? 'animate-spin' : '',
                                        'scale-135',
                                    ]"
                                />
                                {{ coverUrlLoading ? "Fetching..." : "Fetch" }}
                            </button>
                            <button
                                class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm gap-2! disabled:opacity-60 disabled:cursor-not-allowed"
                                type="button"
                                :disabled="
                                    saving ||
                                    coverUploading ||
                                    coverUrlLoading ||
                                    (!coverUrlInput.trim() &&
                                        !selectedCoverFile)
                                "
                                @click="clearCoverUrlPreview"
                            >
                                <icon name="lucide:x" class="scale-135" />
                                Clear
                            </button>
                        </div>

                        <div
                            v-if="coverUrlInput.trim()"
                            class="text-xs opacity-60 mt-1 text-left"
                        >
                            Press Enter to fetch. This only previews until you
                            click Upload.
                        </div>
                    </div>

                    <div
                        v-if="selectedCoverFile"
                        class="text-xs opacity-70 pt-2 text-center break-all"
                    >
                        Selected: {{ selectedCoverFile.name }}
                    </div>

                    <div class="text-xs opacity-60 pt-2 text-center">
                        Covers are stored as
                        <span class="font-mono">cover.webp</span>
                        next to the book file.
                    </div>
                </div>

                <!-- Right column: metadata fields -->
                <div class="min-w-0 flex flex-col gap-4 grow max-w-3xl">
                    <div class="flex items-start justify-between gap-4">
                        <div class="min-w-0">
                            <div class="text-sm opacity-70">
                                ID: <span class="font-mono">{{ book.id }}</span>
                            </div>
                        </div>

                        <div class="flex gap-2 shrink-0">
                            <button
                                class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm"
                                type="button"
                                :disabled="saving"
                                @click="resetForm"
                            >
                                Reset
                            </button>

                            <button
                                class="px-3 py-2 rounded-md bg-(--main-color) text-(--bg-color) hover:opacity-90 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                                type="button"
                                :disabled="saving"
                                @click="save"
                            >
                                <span v-if="saving">Saving...</span>
                                <span v-else>Save</span>
                            </button>
                        </div>
                    </div>

                    <div v-if="successMessage" class="text-sm text-green-600">
                        {{ successMessage }}
                    </div>

                    <div class="grid gap-4">
                        <div class="grid gap-2">
                            <label class="text-sm opacity-70">Title</label>
                            <input
                                v-model="form.title"
                                class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                                type="text"
                                placeholder="Title"
                            />
                        </div>

                        <div class="grid gap-2">
                            <label class="text-sm opacity-70">Authors</label>

                            <!-- Selected author chips -->
                            <div
                                v-if="authorChips.length"
                                class="flex flex-wrap gap-2"
                            >
                                <div
                                    v-for="(c, i) in authorChips"
                                    :key="(c.id ?? c.name) + ':' + i"
                                    class="inline-flex items-center gap-2 px-2 py-1 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm"
                                >
                                    <span class="truncate max-w-60">
                                        {{ c.name }}
                                    </span>
                                    <button
                                        type="button"
                                        class="opacity-70 hover:opacity-100"
                                        aria-label="Remove author"
                                        @click.stop="
                                            authorChips = chipRemove(
                                                authorChips,
                                                i,
                                            )
                                        "
                                    >
                                        <icon
                                            name="lucide:x"
                                            class="scale-110"
                                        />
                                    </button>
                                </div>
                            </div>

                            <!-- Author input + suggestions -->
                            <div class="relative">
                                <input
                                    v-model="authorInput"
                                    class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                                    type="text"
                                    placeholder="Type an author name… (comma to create chips)"
                                    @keydown.enter.prevent="
                                        (() => {
                                            const committed = chipCommitOnEnter(
                                                authorChips,
                                                authorInput,
                                            );
                                            if (committed.committed) {
                                                authorChips = committed.chips;
                                                authorInput = committed.input;
                                                authorSuggestOpen = false;
                                            }
                                        })()
                                    "
                                    @keydown.esc="
                                        (() => {
                                            authorSuggestions = [];
                                            authorSuggestOpen = false;
                                        })()
                                    "
                                    @focus="
                                        authorSuggestOpen =
                                            !!authorSuggestions.length
                                    "
                                />

                                <div
                                    v-if="
                                        authorSuggestOpen &&
                                        (authorSearching ||
                                            authorSuggestions.length)
                                    "
                                    class="absolute z-50 mt-1 w-full rounded-md border border-(--sub-color) bg-(--bg-color) shadow-lg overflow-hidden"
                                >
                                    <div
                                        v-if="authorSearching"
                                        class="px-3 py-2 text-sm opacity-70"
                                    >
                                        Searching…
                                    </div>

                                    <button
                                        v-for="s in authorSuggestions"
                                        :key="s.id"
                                        type="button"
                                        class="w-full px-3 py-2 text-left text-sm hover:bg-(--sub-color)/10"
                                        @click="
                                            authorChips = chipAddFromSuggestion(
                                                authorChips,
                                                s,
                                            );
                                            authorInput = '';
                                            authorSuggestOpen = false;
                                        "
                                    >
                                        {{ s.name }}
                                    </button>
                                </div>
                            </div>

                            <div class="text-xs opacity-60">
                                Type commas to create chips. Pause to see
                                suggestions from existing authors.
                            </div>
                        </div>

                        <div class="grid gap-2">
                            <label class="text-sm opacity-70"
                                >Description</label
                            >
                            <textarea
                                v-model="form.description"
                                class="w-full min-h-32 px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                                placeholder="Description (HTML/text allowed; rendering happens on the book page)"
                            />
                        </div>

                        <div class="grid sm:grid-cols-2 gap-4">
                            <div class="grid gap-2">
                                <label class="text-sm opacity-70"
                                    >Published</label
                                >
                                <input
                                    v-model="form.published"
                                    class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                                    type="date"
                                    placeholder="YYYY-MM-DD"
                                />
                            </div>

                            <div class="grid gap-2">
                                <label class="text-sm opacity-70"
                                    >Language</label
                                >
                                <input
                                    v-model="form.language"
                                    class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                                    type="text"
                                    placeholder="e.g. en"
                                />
                            </div>
                        </div>

                        <div class="grid gap-4">
                            <div class="grid gap-2">
                                <label class="text-sm opacity-70">Tags</label>

                                <!-- Selected tag chips -->
                                <div
                                    v-if="tagChips.length"
                                    class="flex flex-wrap gap-2"
                                >
                                    <div
                                        v-for="(c, i) in tagChips"
                                        :key="(c.id ?? c.name) + ':' + i"
                                        class="inline-flex items-center gap-2 px-2 py-1 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm"
                                    >
                                        <span class="truncate max-w-60">
                                            {{ c.name }}
                                        </span>
                                        <button
                                            type="button"
                                            class="opacity-70 hover:opacity-100"
                                            aria-label="Remove tag"
                                            @click.stop="
                                                tagChips = chipRemove(
                                                    tagChips,
                                                    i,
                                                )
                                            "
                                        >
                                            <icon
                                                name="lucide:x"
                                                class="scale-110"
                                            />
                                        </button>
                                    </div>
                                </div>

                                <!-- Tag input + suggestions -->
                                <div class="relative">
                                    <input
                                        v-model="tagInput"
                                        class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                                        type="text"
                                        placeholder="Type tags… (comma to create chips)"
                                        @keydown.enter.prevent="
                                            (() => {
                                                const committed =
                                                    chipCommitOnEnter(
                                                        tagChips,
                                                        tagInput,
                                                    );
                                                if (committed.committed) {
                                                    tagChips = committed.chips;
                                                    tagInput = committed.input;
                                                    tagSuggestOpen = false;
                                                }
                                            })()
                                        "
                                        @keydown.esc="
                                            (() => {
                                                tagSuggestions = [];
                                                tagSuggestOpen = false;
                                            })()
                                        "
                                        @focus="
                                            tagSuggestOpen =
                                                !!tagSuggestions.length
                                        "
                                    />

                                    <div
                                        v-if="
                                            tagSuggestOpen &&
                                            (tagSearching ||
                                                tagSuggestions.length)
                                        "
                                        class="absolute z-50 mt-1 w-full rounded-md border border-(--sub-color) bg-(--bg-color) shadow-lg overflow-hidden"
                                    >
                                        <div
                                            v-if="tagSearching"
                                            class="px-3 py-2 text-sm opacity-70"
                                        >
                                            Searching…
                                        </div>

                                        <button
                                            v-for="s in tagSuggestions"
                                            :key="s.id"
                                            type="button"
                                            class="w-full px-3 py-2 text-left text-sm hover:bg-(--sub-color)/10"
                                            @click="
                                                tagChips =
                                                    chipAddFromSuggestion(
                                                        tagChips,
                                                        s,
                                                    );
                                                tagInput = '';
                                                tagSuggestOpen = false;
                                            "
                                        >
                                            {{ s.name }}
                                        </button>
                                    </div>
                                </div>

                                <div class="text-xs opacity-60">
                                    Type commas to create chips. Pause to see
                                    suggestions from existing tags.
                                </div>
                            </div>

                            <div class="grid sm:grid-cols-2 gap-4">
                                <div class="grid gap-2">
                                    <label class="text-sm opacity-70">
                                        Publisher
                                    </label>

                                    <div class="relative">
                                        <input
                                            v-model="form.publisher"
                                            class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                                            type="text"
                                            placeholder="Publisher name"
                                            @input="
                                                publisherInput = form.publisher
                                            "
                                            @keydown.esc="
                                                (() => {
                                                    publisherSuggestions = [];
                                                    publisherSuggestOpen = false;
                                                })()
                                            "
                                            @focus="
                                                publisherSuggestOpen =
                                                    !!publisherSuggestions.length
                                            "
                                        />

                                        <div
                                            v-if="
                                                publisherSuggestOpen &&
                                                (publisherSearching ||
                                                    publisherSuggestions.length)
                                            "
                                            class="absolute z-50 mt-1 w-full rounded-md border border-(--sub-color) bg-(--bg-color) shadow-lg overflow-hidden"
                                        >
                                            <div
                                                v-if="publisherSearching"
                                                class="px-3 py-2 text-sm opacity-70"
                                            >
                                                Searching…
                                            </div>

                                            <button
                                                v-for="s in publisherSuggestions"
                                                :key="s.id"
                                                type="button"
                                                class="w-full px-3 py-2 text-left text-sm hover:bg-(--sub-color)/10"
                                                @click="
                                                    form.publisher = s.name;
                                                    publisherInput = s.name;
                                                    publisherSuggestOpen = false;
                                                "
                                            >
                                                {{ s.name }}
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                <div class="grid gap-2">
                                    <label class="text-sm opacity-70">
                                        Series
                                    </label>

                                    <div class="relative">
                                        <input
                                            v-model="form.series"
                                            class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                                            type="text"
                                            placeholder="Series name"
                                            @input="seriesInput = form.series"
                                            @keydown.esc="
                                                (() => {
                                                    seriesSuggestions = [];
                                                    seriesSuggestOpen = false;
                                                })()
                                            "
                                            @focus="
                                                (() => {
                                                    seriesFocused = true;
                                                    seriesSuggestOpen =
                                                        !!seriesSuggestions.length;
                                                })()
                                            "
                                            @blur="
                                                (() => {
                                                    seriesFocused = false;
                                                    seriesSuggestOpen = false;
                                                })()
                                            "
                                        />

                                        <div
                                            v-if="
                                                seriesSuggestOpen &&
                                                (seriesSearching ||
                                                    seriesSuggestions.length)
                                            "
                                            class="absolute z-50 mt-1 w-full rounded-md border border-(--sub-color) bg-(--bg-color) shadow-lg overflow-hidden"
                                        >
                                            <div
                                                v-if="seriesSearching"
                                                class="px-3 py-2 text-sm opacity-70"
                                            >
                                                Searching…
                                            </div>

                                            <button
                                                v-for="s in seriesSuggestions"
                                                :key="s.id"
                                                type="button"
                                                class="w-full px-3 py-2 text-left text-sm hover:bg-(--sub-color)/10"
                                                @click="
                                                    form.series = s.name;
                                                    seriesInput = s.name;
                                                    seriesSuggestOpen = false;
                                                "
                                            >
                                                {{ s.name }}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="grid sm:grid-cols-2 gap-4">
                            <div class="grid gap-2">
                                <label class="text-sm opacity-70">
                                    Series Index
                                    <span class="opacity-60">(number)</span>
                                </label>
                                <input
                                    v-model="form.seriesIndex"
                                    class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                                    type="text"
                                    inputmode="decimal"
                                    placeholder="(blank to clear)"
                                />
                            </div>

                            <div class="grid gap-2">
                                <label class="text-sm opacity-70">Notes</label>
                                <div class="text-sm opacity-70">
                                    This page edits only canonical book
                                    metadata. Authors/tags/files aren’t editable
                                    yet.
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
