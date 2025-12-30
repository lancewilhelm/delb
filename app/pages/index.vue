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

const files = ref<File[]>([]);
const uploading = ref(false);
const errorMessage = ref<string | null>(null);

const books = ref<Book[]>([]);
const loadingBooks = ref(false);

async function refreshBooks() {
    loadingBooks.value = true;
    errorMessage.value = null;

    try {
        const res: any = await $fetch("/api/books", { method: "GET" });
        books.value = res?.data?.books ?? [];
    } catch (err: any) {
        errorMessage.value =
            err?.data?.message ||
            err?.statusMessage ||
            err?.message ||
            "Failed to load books";
    } finally {
        loadingBooks.value = false;
    }
}

async function uploadEpubs() {
    if (!files.value.length) return;

    uploading.value = true;
    errorMessage.value = null;

    try {
        const form = new FormData();
        for (const f of files.value) {
            form.append("file", f);
        }

        await $fetch("/api/books/upload", {
            method: "POST",
            body: form,
        });

        files.value = [];
        const input = document.getElementById(
            "epub-upload",
        ) as HTMLInputElement | null;
        if (input) input.value = "";

        await refreshBooks();
    } catch (err: any) {
        errorMessage.value =
            err?.data?.message ||
            err?.statusMessage ||
            err?.message ||
            "Upload failed";
    } finally {
        uploading.value = false;
    }
}

onMounted(() => {
    refreshBooks();
});
</script>

<template>
    <div class="flex flex-col w-full h-full overflow-hidden">
        <AppHeader class="w-full" />

        <div class="w-full h-full p-4 space-y-6 overflow-auto">
            <div class="space-y-2">
                <h2 class="text-xl font-semibold">Delb</h2>
                <p class="text-sm opacity-80">
                    Upload an EPUB to add it to your library.
                </p>

                <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                        id="epub-upload"
                        type="file"
                        multiple
                        accept=".epub,application/epub+zip"
                        class="block w-full sm:w-auto"
                        @change="
                            (e) => {
                                files = Array.from(
                                    (e.target as HTMLInputElement).files ?? [],
                                );
                            }
                        "
                    />

                    <button
                        class="px-3 py-2 border rounded-md disabled:opacity-50"
                        :disabled="!files.length || uploading"
                        @click="uploadEpubs"
                    >
                        {{
                            uploading
                                ? "Uploading..."
                                : files.length > 1
                                  ? `Upload ${files.length} EPUBs`
                                  : "Upload EPUB"
                        }}
                    </button>

                    <button
                        class="px-3 py-2 border rounded-md disabled:opacity-50"
                        :disabled="loadingBooks"
                        @click="refreshBooks"
                    >
                        {{ loadingBooks ? "Refreshing..." : "Refresh" }}
                    </button>
                </div>

                <p v-if="errorMessage" class="text-sm text-red-600">
                    {{ errorMessage }}
                </p>
            </div>

            <div class="space-y-2">
                <h3 class="text-lg font-semibold">Books</h3>

                <div v-if="loadingBooks" class="text-sm opacity-80">
                    Loading...
                </div>

                <div v-else-if="books.length === 0" class="text-sm opacity-80">
                    No books yet. Upload an EPUB above.
                </div>

                <div v-else class="flex gap-3 flex-wrap">
                    <div v-for="b in books" :key="b.id" class="w-45">
                        <div class="flex flex-col gap-1">
                            <BookCover
                                :src="
                                    b.coverImagePath
                                        ? `/api/media/covers/${b.coverImagePath.replace(/^data\/books\//, '')}`
                                        : null
                                "
                                :alt="`Cover for ${b.title}`"
                                class="w-37.5 cursor-pointer"
                            />
                            <div>
                                <div class="font-bold truncate">
                                    {{ b.title }}
                                </div>
                                <div class="opacity-70 truncate">
                                    {{ b.author }}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
