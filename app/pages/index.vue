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

type Book = {
    id: string;
    title: string;

    // New schema: authors live in `book_authors` (many-to-many).
    // Home page should prefer a pre-joined/stringified author list when available.
    authors?: { id: string; name: string }[];
    authorNames?: string[];

    // Back-compat (older API responses)
    author?: string;

    coverImagePath?: string | null;
    createdAt: string | number | Date;
};

type BooksListResponse = {
    data?: {
        books?: Book[];
    };
};

type FetchErrorLike = {
    data?: { message?: string };
    statusMessage?: string;
    message?: string;
};

const errorMessage = ref<string | null>(null);

const books = ref<Book[]>([]);
const loadingBooks = ref(false);

const authorLabelForBook = (b: Book) => {
    // Prefer new-schema shapes first.
    if (Array.isArray(b.authors) && b.authors.length > 0) {
        return b.authors
            .map((a) => a.name)
            .filter(Boolean)
            .join(", ");
    }

    if (Array.isArray(b.authorNames) && b.authorNames.length > 0) {
        return b.authorNames.filter(Boolean).join(", ");
    }

    // Fallback for older API payloads
    return b.author ?? "";
};

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

// When scope changes, refresh the result set for the active view.
watch(
    () => collectionsStore.activeSelection,
    () => {
        if (uiStore.libraryView === "books") refreshBooks();
    },
    { deep: true },
);

// When view changes, fetch only what's needed for that view.
// v1: only Books view is implemented; others are placeholders.
watch(
    () => uiStore.libraryView,
    (mode) => {
        errorMessage.value = null;
        if (mode === "books") refreshBooks();
    },
);

onMounted(async () => {
    await collectionsStore.fetchCollections();
    await refreshBooks();
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

                    <!-- Render per-view. v1: only Books is implemented; others are placeholders. -->
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
                            <div v-for="b in books" :key="b.id" class="w-43">
                                <div class="flex flex-col gap-1">
                                    <NuxtLink :to="`/books/${b.id}`">
                                        <BookCover
                                            :src="
                                                b.coverImagePath
                                                    ? `/api/media/covers/${b.coverImagePath.replace(/^library\//, '')}`
                                                    : null
                                            "
                                            :alt="`Cover for ${b.title}`"
                                            class="cursor-pointer"
                                        />
                                    </NuxtLink>
                                    <div class="flex flex-col">
                                        <NuxtLink
                                            :to="`/books/${b.id}`"
                                            class="flex"
                                        >
                                            <HoverScrollText>{{
                                                b.title
                                            }}</HoverScrollText>
                                        </NuxtLink>
                                        <HoverScrollText class="opacity-70">
                                            {{ authorLabelForBook(b) }}
                                        </HoverScrollText>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div v-else class="text-sm opacity-80">
                        <div class="text-2xl font-serif text-(--main-color)">
                            {{ viewLabel }}
                        </div>
                        <div class="mt-2">
                            Coming soon. This view will render items in the
                            selected collection, filtered by the sidebar facets.
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
