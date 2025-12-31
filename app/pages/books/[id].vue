<script setup lang="ts">
definePageMeta({
    auth: {
        only: "user",
        redirectGuestTo: "/login",
    },
});

// Page metadata
useHead({
    title: "Book",
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

type BookGetResponse = {
    data?: {
        book?: Book;
    };
    success?: boolean;
    message?: string;
};

type FetchErrorLike = {
    data?: { message?: string };
    statusMessage?: string;
    message?: string;
};

const route = useRoute();
const bookId = computed(() => String(route.params.id || ""));

const loading = ref(false);
const errorMessage = ref<string | null>(null);
const book = ref<Book | null>(null);

const { isAdmin } = useAuth();

const showDeleteConfirm = ref(false);
const deleting = ref(false);

const coverUrl = computed(() => {
    const b = book.value;
    if (!b?.coverImagePath) return null;

    // Stored as: data/books/<author>/<title>/cover.webp
    // API expects: /api/media/covers/<path under data/books>
    return `/api/media/covers/${b.coverImagePath.replace(/^data\/books\//, "")}`;
});

const downloadUrl = computed(() => {
    if (!bookId.value) return null;
    return `/api/books/${encodeURIComponent(bookId.value)}/download`;
});

const downloading = ref(false);

function guessDownloadFilename(b: Book) {
    const title = (b.title || "book").trim();
    const ext = (b.format || "epub").trim().toLowerCase() || "epub";
    return `${title}.${ext}`;
}

async function downloadBook() {
    if (!book.value || !downloadUrl.value || downloading.value) return;

    downloading.value = true;

    try {
        const res = await fetch(downloadUrl.value, { method: "GET" });
        if (!res.ok) {
            throw new Error(`Download failed (${res.status})`);
        }

        const blob = await res.blob();

        // Try to honor server-provided filename when available
        const contentDisposition = res.headers.get("content-disposition") || "";
        const match =
            /filename\*=UTF-8''([^;]+)|filename="([^"]+)"|filename=([^;]+)/i.exec(
                contentDisposition,
            );
        const fromHeader = match?.[1] || match?.[2] || match?.[3];
        const filename =
            (fromHeader ? decodeURIComponent(fromHeader.trim()) : null) ||
            guessDownloadFilename(book.value);

        const url = URL.createObjectURL(blob);
        try {
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            a.remove();
        } finally {
            URL.revokeObjectURL(url);
        }
    } catch (err) {
        const e = err as FetchErrorLike;
        errorMessage.value =
            e?.data?.message ||
            e?.statusMessage ||
            e?.message ||
            "Failed to download book";
    } finally {
        downloading.value = false;
    }
}

async function deleteBook() {
    if (!bookId.value || deleting.value) return;

    deleting.value = true;
    errorMessage.value = null;

    try {
        const res = await fetch(
            `/api/books/${encodeURIComponent(bookId.value)}`,
            {
                method: "DELETE",
            },
        );

        if (!res.ok) {
            throw new Error(`Delete failed (${res.status})`);
        }

        showDeleteConfirm.value = false;
        await navigateTo("/");
    } catch (err) {
        const e = err as FetchErrorLike;
        errorMessage.value =
            e?.data?.message ||
            e?.statusMessage ||
            e?.message ||
            "Failed to delete book";
    } finally {
        deleting.value = false;
    }
}

async function loadBook() {
    if (!bookId.value) return;

    loading.value = true;
    errorMessage.value = null;

    try {
        const res = await fetch(
            `/api/books/${encodeURIComponent(bookId.value)}`,
            { method: "GET" },
        );

        if (!res.ok) {
            throw new Error(`Failed to load book (${res.status})`);
        }

        const json = (await res.json()) as BookGetResponse;

        book.value = json?.data?.book ?? null;

        if (!book.value) {
            errorMessage.value = "Book not found";
        } else {
            useHead({ title: book.value.title });
        }
    } catch (err) {
        const e = err as FetchErrorLike;
        errorMessage.value =
            e?.data?.message ||
            e?.statusMessage ||
            e?.message ||
            "Failed to load book";
        book.value = null;
    } finally {
        loading.value = false;
    }
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
            <div class="flex items-center gap-2 mb-4">
                <NuxtLink
                    v-tooltip="'Go back'"
                    to="/"
                    class="opacity-80 hover:opacity-100"
                >
                    <icon
                        name="lucide:arrow-left"
                        class="scale-200 translate-x-1"
                    />
                </NuxtLink>
            </div>

            <div v-if="loading" class="text-sm opacity-80">Loading...</div>

            <div v-else-if="errorMessage" class="text-sm text-(--error-color)">
                {{ errorMessage }}
            </div>

            <div v-else-if="book" class="grid gap-6 md:grid-cols-[320px_1fr]">
                <!-- Cover (left) -->
                <div class="max-w-[200px] md:max-w-[320px]">
                    <!-- Keep a consistent aspect ratio; cover itself is max 320px wide -->
                    <div class="w-full aspect-[2/3]">
                        <BookCover
                            :src="coverUrl"
                            :alt="`Cover for ${book.title}`"
                            class="w-full h-full"
                        />
                    </div>
                </div>

                <!-- Details (right) -->
                <div class="min-w-0 flex flex-col gap-4">
                    <div class="min-w-0 space-y-1">
                        <div class="text-4xl leading-tight font-serif">
                            {{ book.title }}
                        </div>

                        <div class="text-xl font-light opacity-80 font-serif">
                            <span>{{ book.author }}</span>
                        </div>
                    </div>

                    <div class="grid gap-2 text-sm">
                        <div class="grid grid-cols-[110px_1fr] gap-2">
                            <div class="opacity-70">Format</div>
                            <div class="min-w-0">{{ book.format }}</div>
                        </div>

                        <div class="grid grid-cols-[110px_1fr] gap-2">
                            <div class="opacity-70">Added</div>
                            <div class="min-w-0">
                                {{
                                    typeof book.createdAt === "string" ||
                                    typeof book.createdAt === "number"
                                        ? new Date(
                                              book.createdAt,
                                          ).toLocaleString()
                                        : new Date(
                                              book.createdAt,
                                          ).toLocaleString()
                                }}
                            </div>
                        </div>

                        <div class="grid grid-cols-[110px_1fr] gap-2">
                            <div class="opacity-70">Path</div>
                            <div class="min-w-0 break-all opacity-80">
                                {{ book.relativePath }}
                            </div>
                        </div>
                    </div>

                    <!-- Actions -->
                    <div class="flex flex-wrap gap-1 pt-2">
                        <button
                            class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm gap-2! disabled:opacity-60 disabled:cursor-not-allowed"
                            type="button"
                            :disabled="downloading"
                            @click="downloadBook"
                        >
                            <icon
                                :name="
                                    downloading
                                        ? 'lucide:loader-circle'
                                        : 'lucide:book-down'
                                "
                                :class="[
                                    downloading ? 'animate-spin' : '',
                                    'scale-135',
                                ]"
                            />
                            {{ downloading ? "Downloading..." : "Download" }}
                        </button>

                        <button
                            v-if="isAdmin"
                            class="px-3 py-2 rounded-md border border-(--error-color) text-(--error-color) hover:bg-(--error-color)/90! text-sm gap-2! disabled:opacity-60 disabled:cursor-not-allowed"
                            type="button"
                            :disabled="deleting"
                            @click="showDeleteConfirm = true"
                        >
                            <icon name="lucide:trash-2" class="scale-135" />
                            Delete
                        </button>
                    </div>

                    <ModalWindow
                        :open="showDeleteConfirm"
                        @close="() => (showDeleteConfirm = false)"
                    >
                        <div class="flex flex-col gap-4 w-[360px] max-w-full">
                            <div
                                class="text-lg font-semibold text-(--error-color)"
                            >
                                Delete book?
                            </div>

                            <div class="text-sm opacity-80">
                                This will permanently delete the database record
                                and remove the file from the data folder. This
                                action cannot be undone.
                            </div>

                            <div class="text-sm">
                                <div class="opacity-70">Book</div>
                                <div class="font-medium">
                                    {{ book.title }}
                                </div>
                                <div class="opacity-70">
                                    {{ book.author }}
                                </div>
                            </div>

                            <div class="flex gap-2 justify-end">
                                <button
                                    class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm"
                                    type="button"
                                    :disabled="deleting"
                                    @click="showDeleteConfirm = false"
                                >
                                    Cancel
                                </button>

                                <button
                                    class="px-3 py-2 rounded-md bg-(--error-color) text-(--bg-color) hover:opacity-90 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                                    type="button"
                                    :disabled="deleting"
                                    @click="deleteBook"
                                >
                                    <span v-if="deleting">Deleting...</span>
                                    <span v-else>Yes, delete</span>
                                </button>
                            </div>
                        </div>
                    </ModalWindow>

                    <!-- Future sections placeholder -->
                    <div
                        class="pt-4 border-t border-(--sub-color)/40 space-y-2"
                    >
                        <div class="text-sm font-medium">Details</div>
                        <div class="text-sm opacity-70">
                            More metadata (series, publisher, identifiers,
                            description) can be added here later.
                        </div>
                    </div>
                </div>
            </div>

            <div v-else class="text-sm opacity-80">No book loaded.</div>
        </div>
    </div>
</template>
