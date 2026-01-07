<script setup lang="ts">
defineOptions({ name: "AppSidebar" });

const uiStore = useUiStore();

// Collapsed state (persisted in ui store)
const isCollapsed = computed(() => uiStore.leftSidebarCollapsed);
function toggleCollapsed() {
    uiStore.setLeftSidebarCollapsed(!uiStore.leftSidebarCollapsed);
}

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

onBeforeUnmount(() => {
    stopResizing();
    if (resizeRaf.value) cancelAnimationFrame(resizeRaf.value);
});
</script>

<template>
    <aside
        class="shrink-0 border-r border-(--sub-color) bg-(--sub-alt-color) h-full flex flex-col relative"
        :style="{ width: `${isCollapsed ? 56 : sidebarWidthPx}px` }"
    >
        <!-- Header -->
        <div
            class="px-2 py-2.5 border-b border-(--sub-color) flex items-center gap-2"
            :class="isCollapsed ? 'justify-center' : 'justify-between'"
        >
            <div v-if="!isCollapsed" class="flex items-center gap-2 min-w-0">
                <div class="min-w-0">
                    <div class="text-md font-semibold text-(--main-color)">
                        Filters
                    </div>
                </div>
            </div>

            <button
                v-tooltip="isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
                class="p-1"
                :aria-label="
                    isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
                "
                @click="toggleCollapsed"
            >
                <Icon
                    :name="
                        isCollapsed
                            ? 'lucide:chevrons-right'
                            : 'lucide:chevrons-left'
                    "
                    class="text-(--main-color)"
                />
            </button>
        </div>

        <!-- Filter section placeholders (v1) -->
        <div class="flex-1 py-2 overflow-auto space-y-4">
            <!-- Shelves (state) -->
            <section class="m-0">
                <div
                    v-if="!isCollapsed"
                    class="px-2 py-1 text-xs uppercase tracking-wide opacity-70"
                >
                    Shelves
                </div>

                <div>
                    <button
                        v-tooltip="'Shelf filter (coming soon)'"
                        class="w-full px-3 py-2 flex items-center gap-2 opacity-70 rounded-none!"
                        :class="isCollapsed ? '' : 'justify-start!'"
                        disabled
                    >
                        <Icon
                            name="lucide:book-open"
                            class="text-(--main-color) opacity-80 shrink-0"
                        />
                        <span v-if="!isCollapsed" class="truncate"
                            >Reading</span
                        >
                    </button>

                    <button
                        v-tooltip="'Shelf filter (coming soon)'"
                        class="w-full px-3 py-2 flex items-center gap-2 opacity-70 rounded-none!"
                        :class="isCollapsed ? '' : 'justify-start!'"
                        disabled
                    >
                        <Icon
                            name="lucide:bookmark"
                            class="text-(--main-color) opacity-80 shrink-0"
                        />
                        <span v-if="!isCollapsed" class="truncate"
                            >To Read</span
                        >
                    </button>

                    <button
                        v-tooltip="'Shelf filter (coming soon)'"
                        class="w-full px-3 py-2 flex items-center gap-2 opacity-70 rounded-none!"
                        :class="isCollapsed ? '' : 'justify-start!'"
                        disabled
                    >
                        <Icon
                            name="lucide:check"
                            class="text-(--main-color) opacity-80 shrink-0"
                        />
                        <span v-if="!isCollapsed" class="truncate">Read</span>
                    </button>
                </div>
            </section>

            <!-- Tags (classification) -->
            <section class="m-0">
                <div
                    v-if="!isCollapsed"
                    class="px-2 py-1 text-xs uppercase tracking-wide opacity-70"
                >
                    Tags
                </div>

                <button
                    v-tooltip="'Tag filters (coming soon)'"
                    class="w-full px-3 py-2 flex items-center gap-2 opacity-70 rounded-none!"
                    :class="isCollapsed ? '' : 'justify-start!'"
                    disabled
                >
                    <Icon
                        name="lucide:tag"
                        class="text-(--main-color) opacity-80 shrink-0"
                    />
                    <span v-if="!isCollapsed" class="truncate"
                        >Multi-select (soon)</span
                    >
                </button>
            </section>

            <!-- Ratings -->
            <section class="m-0">
                <div
                    v-if="!isCollapsed"
                    class="px-2 py-1 text-xs uppercase tracking-wide opacity-70"
                >
                    Ratings
                </div>

                <button
                    v-tooltip="'Rating filter (coming soon)'"
                    class="w-full px-3 py-2 flex items-center gap-2 opacity-70 rounded-none!"
                    :class="isCollapsed ? '' : 'justify-start!'"
                    disabled
                >
                    <Icon
                        name="lucide:star"
                        class="text-(--main-color) opacity-80 shrink-0"
                    />
                    <span v-if="!isCollapsed" class="truncate"
                        >Stars (soon)</span
                    >
                </button>
            </section>

            <!-- Later facets -->
            <section
                class="m-0 flex flex-col"
                :class="isCollapsed ? 'items-center' : ''"
            >
                <div
                    v-if="!isCollapsed"
                    class="px-2 py-1 text-xs uppercase tracking-wide opacity-70"
                >
                    More
                </div>

                <button
                    v-tooltip="'More facets (coming soon)'"
                    class="w-full px-3 py-2 flex items-center gap-2 opacity-70 rounded-none!"
                    :class="isCollapsed ? '' : 'justify-start!'"
                    disabled
                >
                    <Icon
                        name="lucide:sliders-horizontal"
                        class="text-(--main-color) opacity-80 shrink-0"
                    />
                    <span v-if="!isCollapsed" class="truncate"
                        >Language, format, year… (soon)</span
                    >
                </button>
            </section>
        </div>

        <!-- Resize handle (hide while collapsed) -->
        <div
            v-if="!isCollapsed"
            v-tooltip="'Drag to resize'"
            class="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-(--sub-color)/60 active:bg-(--sub-color) transition"
            aria-label="Resize sidebar"
            @mousedown="startResizing"
        />
    </aside>
</template>
