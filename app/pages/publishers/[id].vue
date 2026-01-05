<script setup lang="ts">
definePageMeta({
    auth: {
        only: "user",
        redirectGuestTo: "/login",
    },
});

const route = useRoute();
const collectionsStore = useCollectionsStore();

const publisherParam = computed(() => String(route.params.id || "").trim());
const publisherId = computed(() => decodeURIComponent(publisherParam.value));

const activeCollectionId = computed<string | undefined>(() => {
    if (
        collectionsStore.activeSelection.kind === "collection" &&
        collectionsStore.activeSelection.collectionId
    ) {
        return collectionsStore.activeSelection.collectionId;
    }
    return undefined;
});

const publisherName = computed(() => {
    // Back-compat: name-derived ids from earlier list aggregation
    if (publisherId.value.startsWith("name:")) {
        const raw = publisherId.value.slice("name:".length);
        if (raw) return raw;
    }

    // We don't currently fetch publisher metadata separately; the grid endpoint is book-driven.
    // Keep a stable header title; we can enhance later by adding a metadata endpoint.
    return "Publisher";
});

useHead({
    title: `${publisherName.value} · Publisher`,
});

// Keep the grid stable; force reload on collection scope change if desired later.
const gridEndpoint = computed(
    () => `/api/publishers/${encodeURIComponent(publisherId.value)}/books`,
);

function handleGridError(_message: string) {
    // Page-level error UI can be added if needed; grid already displays errors internally.
}
</script>

<template>
    <div class="flex flex-col w-full h-full overflow-hidden">
        <AppHeader class="w-full" />

        <!-- Fixed header + scrollable books grid -->
        <div class="w-full h-full overflow-hidden flex flex-col min-h-0">
            <div class="p-4 shrink-0">
                <div class="flex items-center gap-2 text-(--main-color)">
                    <NuxtLink
                        v-tooltip="'Go back'"
                        to="/"
                        class="opacity-80 hover:opacity-100"
                    >
                        <Icon name="lucide:arrow-left" />
                    </NuxtLink>

                    <div class="text-2xl font-serif truncate">
                        {{ publisherName }}
                    </div>
                </div>
            </div>

            <BooksInfiniteGrid
                :endpoint="gridEndpoint"
                :collection-id="activeCollectionId"
                class="flex-1 min-h-0"
                @error="handleGridError"
            />
        </div>
    </div>
</template>
