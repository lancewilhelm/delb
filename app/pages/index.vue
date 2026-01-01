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

// Collections state (sidebar selection governs what books are shown)
const collectionsStore = useCollectionsStore();

type Book = {
    id: string;
    title: string;
    // Canonical schema no longer has a single author string, but keep optional here
    // to avoid breaking the UI while we build out richer book display.
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

const uploadModalOpen = ref(false);

async function refreshBooks() {
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

watch(
    () => collectionsStore.activeSelection,
    () => {
        refreshBooks();
    },
    { deep: true },
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
            @uploaded="refreshBooks"
        />

        <div class="flex w-full h-full overflow-hidden">
            <!-- Collections sidebar -->
            <CollectionsSidebar class="hidden md:flex w-auto" />

            <!-- Main content -->
            <div class="flex-1 p-4 space-y-6 overflow-auto">
                <div class="space-y-2">
                    <div class="flex items-end justify-between gap-4">
                        <div class="text-4xl font-serif text-(--main-color)">
                            Books
                        </div>

                        <div class="text-sm opacity-70 text-right">
                            <span
                                v-if="
                                    collectionsStore.activeSelection.kind ===
                                    'all'
                                "
                            >
                                All collections
                            </span>
                            <span v-else>
                                {{
                                    collectionsStore.activeCollection?.name ??
                                    "Collection"
                                }}
                            </span>
                        </div>
                    </div>

                    <div v-if="loadingBooks" class="text-sm opacity-80">
                        Loading...
                    </div>

                    <div v-else-if="errorMessage" class="text-sm text-red-600">
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
                                        {{ b.author ?? "" }}
                                    </HoverScrollText>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
