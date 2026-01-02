<script setup lang="ts">
definePageMeta({
    auth: {
        only: "user",
        redirectGuestTo: "/login",
    },
});

type FetchErrorLike = {
    data?: { message?: string };
    statusMessage?: string;
    message?: string;
};

type Book = {
    id: string;
    title: string;
    coverImagePath?: string | null;

    // List API denormalized fields (best-effort)
    authors?: { id: string; name: string }[];
    authorNames?: string[];
    author?: string;

    publisher?: { id: string; name: string } | null;
    series?: { id: string; name: string } | null;

    createdAt: string | number | Date;
};

type AuthorBooksResponse = {
    data?: {
        books?: Book[];
    };
    success?: boolean;
    message?: string;
};

const route = useRoute();
const collectionsStore = useCollectionsStore();

const authorParam = computed(() => String(route.params.id || "").trim());
const authorId = computed(() => decodeURIComponent(authorParam.value));

const loading = ref(false);
const errorMessage = ref<string | null>(null);

const authorName = ref<string>("Author");
const books = ref<Book[]>([]);

const bookCount = computed(() => books.value.length);

function deriveAuthorNameFromBooks(list: Book[], id: string) {
    // Prefer exact author id match from `authors[]`
    for (const b of list) {
        const match = b.authors?.find((a) => a.id === id);
        if (match?.name) return match.name;
    }

    // Back-compat for name-derived ids if any old links exist
    if (id.startsWith("name:")) {
        const raw = id.slice("name:".length);
        if (raw) return raw;
    }

    return "Author";
}

async function refresh() {
    if (!authorId.value) return;

    loading.value = true;
    errorMessage.value = null;

    try {
        // Ensure collections are loaded so collection-scoped queries work after navigation.
        if (!collectionsStore.collections.length) {
            await collectionsStore.fetchCollections();
        }

        const query: Record<string, string> = {};
        if (
            collectionsStore.activeSelection.kind === "collection" &&
            collectionsStore.activeSelection.collectionId
        ) {
            query.collectionId = collectionsStore.activeSelection.collectionId;
        }

        const res = await $fetch<AuthorBooksResponse>(
            `/api/authors/${encodeURIComponent(authorId.value)}/books`,
            {
                method: "GET",
                query,
            },
        );

        const list = res?.data?.books ?? [];

        // Stable ordering: newest first (match Home behavior)
        list.sort((a, b) => {
            const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
            return bTime - aTime;
        });

        books.value = list;
        authorName.value = deriveAuthorNameFromBooks(list, authorId.value);

        useHead({
            title: `${authorName.value} · Author`,
        });
    } catch (err) {
        const e = err as FetchErrorLike;
        errorMessage.value =
            e?.data?.message ||
            e?.statusMessage ||
            e?.message ||
            "Failed to load author";
    } finally {
        loading.value = false;
    }
}

onMounted(refresh);
watch(authorId, refresh);
watch(
    () => collectionsStore.activeSelection,
    () => refresh(),
    { deep: true },
);
</script>

<template>
    <div class="flex flex-col w-full h-full overflow-hidden">
        <AppHeader class="w-full" />

        <div class="w-full h-full p-4 overflow-auto">
            <div class="flex items-center gap-2 mb-4 text-(--main-color)">
                <NuxtLink
                    v-tooltip="'Go back'"
                    to="/"
                    class="opacity-80 hover:opacity-100"
                >
                    <Icon name="lucide:arrow-left" />
                </NuxtLink>

                <div class="text-2xl font-serif truncate">
                    {{ authorName }}
                </div>

                <div class="text-sm opacity-70">
                    · {{ bookCount }} book{{ bookCount === 1 ? "" : "s" }}
                </div>
            </div>

            <div v-if="loading" class="text-sm opacity-80">Loading...</div>

            <div v-else-if="errorMessage" class="text-sm text-red-600">
                {{ errorMessage }}
            </div>

            <div v-else-if="books.length === 0" class="text-sm opacity-80">
                No books found for this author in your accessible collections.
            </div>

            <div v-else class="flex gap-3 flex-wrap">
                <BookThumbnail v-for="b in books" :key="b.id" :book="b" />
            </div>
        </div>
    </div>
</template>
