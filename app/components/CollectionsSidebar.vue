<script setup lang="ts">
defineOptions({ name: "CollectionsSidebar" });

const uiStore = useUiStore();
const collectionsStore = useCollectionsStore();

const createModalOpen = ref(false);
const creating = ref(false);
const createError = ref<string | null>(null);
const newCollectionName = ref("");

type FetchErrorLike = {
    data?: { message?: string };
    statusMessage?: string;
    message?: string;
};

// Sidebar resizing (persisted in ui store)
const isResizing = ref(false);
const resizeRaf = ref<number | null>(null);

const MIN_WIDTH = 200;
const MAX_WIDTH = 520;

const sidebarWidthPx = computed(() => {
    const current = uiStore.leftSidebarWidthPx;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, current));
});

function setSidebarWidthPx(next: number) {
    uiStore.setLeftSidebarWidthPx(
        Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(next))),
    );
}

function onResizeMove(e: MouseEvent) {
    if (!isResizing.value) return;

    // Sidebar is on the left; width is mouse X from viewport's left edge.
    const nextWidth = e.clientX;

    // Throttle with rAF to avoid excessive store writes.
    if (resizeRaf.value) cancelAnimationFrame(resizeRaf.value);
    resizeRaf.value = requestAnimationFrame(() => {
        setSidebarWidthPx(nextWidth);
        resizeRaf.value = null;
    });
}

function stopResizing() {
    if (!isResizing.value) return;

    isResizing.value = false;
    document.body.classList.remove("select-none");
    document.body.style.cursor = "";

    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", stopResizing);

    if (resizeRaf.value) {
        cancelAnimationFrame(resizeRaf.value);
        resizeRaf.value = null;
    }
}

function startResizing(e: MouseEvent) {
    e.preventDefault();
    isResizing.value = true;
    document.body.classList.add("select-none");
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onResizeMove);
    window.addEventListener("mouseup", stopResizing);
}

async function refreshCollections() {
    await collectionsStore.fetchCollections();
}

function openCreateModal() {
    createError.value = null;
    newCollectionName.value = "";
    createModalOpen.value = true;
}

function closeCreateModal() {
    createModalOpen.value = false;
    createError.value = null;
    newCollectionName.value = "";
    creating.value = false;
}

async function createCollection() {
    if (creating.value) return;

    const name = newCollectionName.value.trim();
    if (!name) {
        createError.value = "Collection name is required.";
        return;
    }

    creating.value = true;
    createError.value = null;

    try {
        // Expected API shape (to be implemented server-side):
        // POST /api/collections { name: string }
        await $fetch("/api/collections", {
            method: "POST",
            body: { name },
        });

        await refreshCollections();

        // Convenience behavior:
        // After creating a collection, select it.
        const created = collectionsStore.collections.find(
            (c) => c.name === name,
        );
        if (created) {
            collectionsStore.setActiveCollection(created.id);
        }

        closeCreateModal();
    } catch (err: unknown) {
        const e = err as FetchErrorLike;
        createError.value =
            e?.data?.message ||
            e?.statusMessage ||
            e?.message ||
            "Failed to create collection.";
    } finally {
        creating.value = false;
    }
}

onMounted(async () => {
    // Load collections and keep selection consistent.
    await refreshCollections();
});

onBeforeUnmount(() => {
    stopResizing();
    if (resizeRaf.value) cancelAnimationFrame(resizeRaf.value);
});
</script>

<template>
    <aside
        class="shrink-0 border-r border-(--sub-color) bg-(--sub-alt-color) h-full flex flex-col relative"
        :style="{ width: `${sidebarWidthPx}px` }"
    >
        <div class="px-4 py-2 border-b border-(--sub-color)">
            <div class="text-md font-semibold text-(--main-color)">
                Collections
            </div>
        </div>

        <div class="flex-1 overflow-auto px-2 py-2 space-y-1">
            <!-- All -->
            <button
                class="w-full justify-start! px-3 py-1"
                :class="
                    collectionsStore.activeSelection.kind === 'all'
                        ? 'bg-(--sub-color)/40'
                        : ''
                "
                @click="collectionsStore.setActiveAll()"
            >
                <div class="flex items-center gap-2 min-w-0">
                    <Icon
                        name="lucide:layers"
                        class="text-(--main-color) opacity-80 shrink-0"
                    />
                    <span class="truncate">All</span>
                </div>
            </button>

            <div class="h-px bg-(--sub-color) my-2 opacity-60" />

            <!-- Collections list -->
            <div
                v-if="collectionsStore.loading"
                class="px-3 py-2 text-sm opacity-70"
            >
                Loading collections…
            </div>

            <div
                v-else-if="!collectionsStore.collections.length"
                class="px-3 py-2 text-sm opacity-70"
            >
                No collections yet.
            </div>

            <button
                v-for="c in collectionsStore.collections"
                :key="c.id"
                class="w-full px-3 py-1 hover:bg-(--sub-color)/30 justify-between!"
                :class="
                    collectionsStore.activeSelection.kind === 'collection' &&
                    collectionsStore.activeSelection.collectionId === c.id
                        ? 'bg-(--sub-color)/40'
                        : ''
                "
                @click="collectionsStore.setActiveCollection(c.id)"
            >
                <div class="flex items-center gap-2 min-w-0">
                    <Icon
                        name="lucide:folder"
                        class="text-(--main-color) opacity-80 shrink-0"
                    />
                    <span class="truncate">{{ c.name }}</span>
                </div>

                <div class="text-[11px] opacity-60 shrink-0">
                    {{ c.role }}
                </div>
            </button>

            <p
                v-if="collectionsStore.errorMessage"
                class="px-3 py-2 text-sm text-red-600"
            >
                {{ collectionsStore.errorMessage }}
            </p>
        </div>

        <!-- Resize handle -->
        <div
            class="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-(--sub-color)/60 active:bg-(--sub-color) transition"
            aria-label="Resize collections sidebar"
            title="Drag to resize"
            @mousedown="startResizing"
        />

        <!-- Create button -->
        <div class="border-t border-(--sub-color) p-2">
            <button
                class="w-full px-3 py-1 border border-(--sub-color) gap-2"
                @click="openCreateModal"
            >
                <Icon name="lucide:plus" class="text-(--main-color)" />
                <span>Create collection</span>
            </button>
        </div>

        <!-- Create modal -->
        <ModalWindow :open="createModalOpen" @close="closeCreateModal">
            <div class="flex flex-col gap-3 w-90 max-w-[80vw]">
                <div class="flex items-start justify-between gap-4">
                    <div>
                        <div class="text-lg font-semibold">
                            Create collection
                        </div>
                        <div class="text-sm opacity-80">
                            Give your new collection a name.
                        </div>
                    </div>

                    <Icon
                        name="lucide:x"
                        class="scale-150 cursor-pointer opacity-80 hover:opacity-100"
                        @click="closeCreateModal"
                    />
                </div>

                <div class="space-y-2">
                    <input
                        v-model="newCollectionName"
                        type="text"
                        placeholder="e.g. Personal, Family, Favorites…"
                        class="w-full px-3 py-2 border rounded-md bg-(--bg-color)"
                        :disabled="creating"
                        @keyup.enter="createCollection"
                    />

                    <p v-if="createError" class="text-sm text-red-600">
                        {{ createError }}
                    </p>
                </div>

                <div class="flex gap-2 justify-end">
                    <button
                        class="px-3 py-2 border rounded-md disabled:opacity-50"
                        :disabled="creating"
                        @click="closeCreateModal"
                    >
                        Cancel
                    </button>

                    <button
                        class="px-3 py-2 border rounded-md disabled:opacity-50 bg-(--main-color) text-(--bg-color)"
                        :disabled="creating || !newCollectionName.trim()"
                        @click="createCollection"
                    >
                        {{ creating ? "Creating…" : "Create" }}
                    </button>
                </div>
            </div>
        </ModalWindow>
    </aside>
</template>
