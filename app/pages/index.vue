<script setup lang="ts">
definePageMeta({
    auth: {
        only: "user",
        redirectGuestTo: "/login",
    },
});

// Page metadata
useHead({
    title: "Home",
});

// Scope (collection) lives in the header collection switcher dropdown.
// View (mode) lives on this page (top-left view selector dropdown).
const uiStore = useUiStore();
const collectionsStore = useCollectionsStore();

type FetchErrorLike = {
    data?: { message?: string };
    statusMessage?: string;
    message?: string;
};

const seriesHref = (id: string) => `/series/${encodeURIComponent(id)}`;

// ------------------------------
// Books view
// ------------------------------
type Book = {
    id: string;
    title: string;

    // New schema: authors live in `book_authors` (many-to-many).
    // Home page should prefer a pre-joined/stringified author list when available.
    authors?: { id: string; name: string }[];
    authorNames?: string[];

    // Back-compat (older API responses)
    author?: string;

    // List API now also includes these denormalized display objects
    publisher?: { id: string; name: string } | null;
    series?: { id: string; name: string } | null;

    coverImagePath?: string | null;
    createdAt: string | number | Date;
};

type BooksListResponse = {
    data?: {
        books?: Book[];
    };
};

const errorMessage = ref<string | null>(null);

// ------------------------------
// Books view state
// ------------------------------
const books = ref<Book[]>([]);
const loadingBooks = ref(false);

async function refreshBooks() {
    // Only fetch books when we're in Books view.
    if (uiStore.libraryView !== "books") return;

    loadingBooks.value = true;
    errorMessage.value = null;

    try {
        const query: Record<string, string> = {};
        if (
            collectionsStore.activeSelection.kind === "collection" &&
            collectionsStore.activeSelection.collectionId
        ) {
            query.collectionId = collectionsStore.activeSelection.collectionId;
        }

        const res = await $fetch<BooksListResponse>("/api/books", {
            method: "GET",
            query,
        });

        books.value = res?.data?.books ?? [];
    } catch (err) {
        const e = err as FetchErrorLike;
        errorMessage.value =
            e?.data?.message ||
            e?.statusMessage ||
            e?.message ||
            "Failed to load books";
    } finally {
        loadingBooks.value = false;
    }
}

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
const authorQuery = ref("");

const filteredAuthors = computed(() => {
    const q = authorQuery.value.trim().toLowerCase();
    const list = authors.value;
    if (!q) return list;
    return list.filter((a) => a.name.toLowerCase().includes(q));
});

async function refreshAuthors() {
    if (uiStore.libraryView !== "authors") return;

    loadingAuthors.value = true;
    errorMessage.value = null;

    try {
        const query: Record<string, string> = {};
        if (
            collectionsStore.activeSelection.kind === "collection" &&
            collectionsStore.activeSelection.collectionId
        ) {
            query.collectionId = collectionsStore.activeSelection.collectionId;
        }

        // Reuse /api/books (works for regular users) and aggregate authors client-side.
        const res = await $fetch<BooksListResponse>("/api/books", {
            method: "GET",
            query,
        });

        const list = res?.data?.books ?? [];

        const byKey = new Map<
            string,
            { id: string; name: string; bookCount: number }
        >();

        for (const b of list) {
            const aList =
                Array.isArray(b.authors) && b.authors.length > 0
                    ? b.authors
                    : Array.isArray(b.authorNames) && b.authorNames.length > 0
                      ? b.authorNames
                            .filter(Boolean)
                            .map((name) => ({ id: `name:${name}`, name }))
                      : b.author
                        ? [{ id: `name:${b.author}`, name: b.author }]
                        : [];

            // Count each author once per book (avoid oddities if API ever duplicates).
            const seenThisBook = new Set<string>();
            for (const a of aList as Array<{ id: string; name: string }>) {
                const id = (a.id ?? "").toString();
                const name = (a.name ?? "").toString();
                if (!name) continue;

                const key =
                    id && !id.startsWith("name:")
                        ? `id:${id}`
                        : `name:${name.toLowerCase()}`;
                if (seenThisBook.has(key)) continue;
                seenThisBook.add(key);

                const existing = byKey.get(key);
                if (existing) {
                    existing.bookCount += 1;
                } else {
                    byKey.set(key, {
                        id: id && !id.startsWith("name:") ? id : key,
                        name,
                        bookCount: 1,
                    });
                }
            }
        }

        const out = Array.from(byKey.values()).sort((a, b) => {
            if (b.bookCount !== a.bookCount) return b.bookCount - a.bookCount;
            return a.name.localeCompare(b.name);
        });

        authors.value = out;
    } catch (err) {
        const e = err as FetchErrorLike;
        errorMessage.value =
            e?.data?.message ||
            e?.statusMessage ||
            e?.message ||
            "Failed to load authors";
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
const seriesQuery = ref("");

const filteredSeries = computed(() => {
    const q = seriesQuery.value.trim().toLowerCase();
    const list = seriesRows.value;
    if (!q) return list;
    return list.filter((s) => s.name.toLowerCase().includes(q));
});

async function refreshSeries() {
    if (uiStore.libraryView !== "series") return;

    loadingSeries.value = true;
    errorMessage.value = null;

    try {
        const query: Record<string, string> = {};
        if (
            collectionsStore.activeSelection.kind === "collection" &&
            collectionsStore.activeSelection.collectionId
        ) {
            query.collectionId = collectionsStore.activeSelection.collectionId;
        }

        // Reuse /api/books and aggregate series client-side.
        // The list API now includes `series: {id,name} | null`.
        const res = await $fetch<BooksListResponse>("/api/books", {
            method: "GET",
            query,
        });

        const list = res?.data?.books ?? [];

        const byKey = new Map<
            string,
            { id: string; name: string; bookCount: number }
        >();

        for (const b of list) {
            const s = b.series ?? null;
            if (!s?.id || !s?.name) continue;

            const key = `id:${s.id}`;
            const existing = byKey.get(key);
            if (existing) {
                existing.bookCount += 1;
            } else {
                byKey.set(key, {
                    id: s.id,
                    name: s.name,
                    bookCount: 1,
                });
            }
        }

        const out = Array.from(byKey.values()).sort((a, b) => {
            if (b.bookCount !== a.bookCount) return b.bookCount - a.bookCount;
            return a.name.localeCompare(b.name);
        });

        seriesRows.value = out;
    } catch (err) {
        const e = err as FetchErrorLike;
        errorMessage.value =
            e?.data?.message ||
            e?.statusMessage ||
            e?.message ||
            "Failed to load series";
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
const publisherQuery = ref("");

const filteredPublishers = computed(() => {
    const q = publisherQuery.value.trim().toLowerCase();
    const list = publishers.value;
    if (!q) return list;
    return list.filter((p) => p.name.toLowerCase().includes(q));
});

async function refreshPublishers() {
    if (uiStore.libraryView !== "publishers") return;

    loadingPublishers.value = true;
    errorMessage.value = null;

    try {
        const query: Record<string, string> = {};
        if (
            collectionsStore.activeSelection.kind === "collection" &&
            collectionsStore.activeSelection.collectionId
        ) {
            query.collectionId = collectionsStore.activeSelection.collectionId;
        }

        // Reuse /api/books and aggregate publishers client-side.
        // The list API now includes `publisher: {id,name} | null`.
        const res = await $fetch<BooksListResponse>("/api/books", {
            method: "GET",
            query,
        });

        const list = res?.data?.books ?? [];

        const byKey = new Map<
            string,
            { id: string; name: string; bookCount: number }
        >();

        for (const b of list) {
            const p = b.publisher ?? null;
            if (!p?.id || !p?.name) continue;

            const key = `id:${p.id}`;
            const existing = byKey.get(key);
            if (existing) {
                existing.bookCount += 1;
            } else {
                byKey.set(key, {
                    id: p.id,
                    name: p.name,
                    bookCount: 1,
                });
            }
        }

        const out = Array.from(byKey.values()).sort((a, b) => {
            if (b.bookCount !== a.bookCount) return b.bookCount - a.bookCount;
            return a.name.localeCompare(b.name);
        });

        publishers.value = out;
    } catch (err) {
        const e = err as FetchErrorLike;
        errorMessage.value =
            e?.data?.message ||
            e?.statusMessage ||
            e?.message ||
            "Failed to load publishers";
        publishers.value = [];
    } finally {
        loadingPublishers.value = false;
    }
}

// ------------------------------
// UI helpers
// ------------------------------
const uploadModalOpen = ref(false);

const viewLabel = computed(() => {
    switch (uiStore.libraryView) {
        case "books":
            return "Books";
        case "authors":
            return "Authors";
        case "series":
            return "Series";
        case "publishers":
            return "Publishers";
        default:
            return "Books";
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
    if (uiStore.libraryView === "books") await refreshBooks();
    if (uiStore.libraryView === "authors") await refreshAuthors();
    if (uiStore.libraryView === "series") await refreshSeries();
    if (uiStore.libraryView === "publishers") await refreshPublishers();
}

onMounted(async () => {
    await refreshActiveView();
});
</script>

<template>
    <div class="flex flex-col w-full h-full overflow-hidden">
        <AppHeader class="w-full" @upload="uploadModalOpen = true" />

        <BookUploadModal
            :open="uploadModalOpen"
            @close="uploadModalOpen = false"
            @uploaded="
                () => {
                    if (uiStore.libraryView === 'books') refreshBooks();
                }
            "
        />

        <div class="flex w-full h-full overflow-hidden">
            <!-- Sidebar = filters (placeholders for now) -->
            <Sidebar class="hidden md:flex w-auto" />

            <!-- Main content -->
            <div class="flex-1 p-4 space-y-6 overflow-auto">
                <div class="space-y-2">
                    <div class="flex items-end justify-between gap-4">
                        <!-- View selector (mode) lives here (top-left) -->
                        <ViewSelectorDropdown
                            :model-value="uiStore.libraryView"
                            @update:model-value="uiStore.setLibraryView"
                        />
                    </div>

                    <!-- Render per-view. -->
                    <div v-if="uiStore.libraryView === 'books'">
                        <div v-if="loadingBooks" class="text-sm opacity-80">
                            Loading...
                        </div>

                        <div
                            v-else-if="errorMessage"
                            class="text-sm text-red-600"
                        >
                            {{ errorMessage }}
                        </div>

                        <div
                            v-else-if="books.length === 0"
                            class="text-sm opacity-80"
                        >
                            No books yet. Use Upload in the header to add one.
                        </div>

                        <div v-else class="flex gap-3 flex-wrap">
                            <BookThumbnail
                                v-for="b in books"
                                :key="b.id"
                                :book="b"
                                :lock-aspect-ratio="true"
                            />
                        </div>
                    </div>

                    <div v-else-if="uiStore.libraryView === 'authors'">
                        <div class="flex items-center justify-between gap-3">
                            <div
                                class="text-2xl font-serif text-(--main-color)"
                            >
                                Authors
                            </div>

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

                        <div
                            v-else-if="errorMessage"
                            class="text-sm text-red-600"
                        >
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
                                class="flex items-center justify-between border border-(--sub-color) rounded-md px-3 py-2"
                            >
                                <div class="min-w-0">
                                    <NuxtLink
                                        :to="`/authors/${a.id}`"
                                        class="truncate hover:underline text-(--main-color)"
                                    >
                                        {{ a.name }}
                                    </NuxtLink>
                                    <div class="text-xs opacity-70">
                                        {{ a.bookCount }} book{{
                                            a.bookCount === 1 ? "" : "s"
                                        }}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div v-else-if="uiStore.libraryView === 'series'">
                        <div class="flex items-center justify-between gap-3">
                            <div
                                class="text-2xl font-serif text-(--main-color)"
                            >
                                Series
                            </div>

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

                        <div
                            v-else-if="errorMessage"
                            class="text-sm text-red-600"
                        >
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
                                class="flex items-center justify-between border border-(--sub-color) rounded-md px-3 py-2"
                            >
                                <div class="min-w-0">
                                    <NuxtLink
                                        :to="seriesHref(s.id)"
                                        class="truncate hover:underline"
                                    >
                                        {{ s.name }}
                                    </NuxtLink>
                                    <div class="text-xs opacity-70">
                                        {{ s.bookCount }} book{{
                                            s.bookCount === 1 ? "" : "s"
                                        }}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div v-else-if="uiStore.libraryView === 'publishers'">
                        <div class="flex items-center justify-between gap-3">
                            <div
                                class="text-2xl font-serif text-(--main-color)"
                            >
                                Publishers
                            </div>

                            <input
                                v-model="publisherQuery"
                                class="px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm w-56"
                                placeholder="Filter publishers..."
                                type="text"
                            />
                        </div>

                        <div
                            v-if="loadingPublishers"
                            class="text-sm opacity-80"
                        >
                            Loading...
                        </div>

                        <div
                            v-else-if="errorMessage"
                            class="text-sm text-red-600"
                        >
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
                                class="flex items-center justify-between border border-(--sub-color) rounded-md px-3 py-2"
                            >
                                <div class="min-w-0">
                                    <NuxtLink
                                        :to="`/publishers/${p.id}`"
                                        class="truncate hover:underline"
                                    >
                                        {{ p.name }}
                                    </NuxtLink>
                                    <div class="text-xs opacity-70">
                                        {{ p.bookCount }} book{{
                                            p.bookCount === 1 ? "" : "s"
                                        }}
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
</template>
