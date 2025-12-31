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

type Book = {
    id: string;
    title: string;
    author: string;
    format: string;
    relativePath: string;
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
        const res = await $fetch<BooksListResponse>("/api/books", {
            method: "GET",
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

onMounted(() => {
    refreshBooks();
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

        <div class="w-full h-full p-4 space-y-6 overflow-auto">
            <div class="space-y-2">
                <div class="text-4xl font-serif">Books</div>

                <div v-if="loadingBooks" class="text-sm opacity-80">
                    Loading...
                </div>

                <div v-else-if="books.length === 0" class="text-sm opacity-80">
                    No books yet. Use Upload in the header to add one.
                </div>

                <div v-else class="flex gap-3 flex-wrap">
                    <div v-for="b in books" :key="b.id" class="w-43">
                        <div class="flex flex-col gap-1">
                            <NuxtLink :to="`/books/${b.id}`">
                                <BookCover
                                    :src="
                                        b.coverImagePath
                                            ? `/api/media/covers/${b.coverImagePath.replace(/^data\/books\//, '')}`
                                            : null
                                    "
                                    :alt="`Cover for ${b.title}`"
                                    class="cursor-pointer"
                                />
                            </NuxtLink>
                            <div class="flex flex-col">
                                <NuxtLink :to="`/books/${b.id}`" class="flex">
                                    <HoverScrollText>{{
                                        b.title
                                    }}</HoverScrollText>
                                </NuxtLink>
                                <HoverScrollText class="opacity-70">{{
                                    b.author
                                }}</HoverScrollText>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
