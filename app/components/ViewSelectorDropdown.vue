<script setup lang="ts">
defineOptions({ name: "ViewSelectorDropdown" });

export type LibraryView = "books" | "authors" | "series" | "publishers";

const props = withDefaults(
    defineProps<{
        modelValue?: LibraryView;
    }>(),
    {
        modelValue: "books",
    },
);

const emit = defineEmits<{
    (e: "update:modelValue", value: LibraryView): void;
}>();

const open = ref(false);
const anchorRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);

const views: Array<{
    id: LibraryView;
    label: string;
    icon: string;
    enabled: boolean;
    subtitle?: string;
}> = [
    { id: "books", label: "Books", icon: "lucide:book", enabled: true },
    {
        id: "authors",
        label: "Authors",
        icon: "lucide:user",
        enabled: false,
        subtitle: "Coming soon",
    },
    {
        id: "series",
        label: "Series",
        icon: "lucide:layers",
        enabled: false,
        subtitle: "Coming soon",
    },
    {
        id: "publishers",
        label: "Publishers",
        icon: "lucide:building-2",
        enabled: false,
        subtitle: "Coming soon",
    },
];

const activeView = computed(() => {
    return views.find((v) => v.id === props.modelValue) ?? views[0]!;
});

function closeDropdown() {
    open.value = false;
}

function toggleDropdown() {
    open.value = !open.value;
}

function selectView(view: LibraryView) {
    const v = views.find((x) => x.id === view);
    if (!v?.enabled) return;
    emit("update:modelValue", view);
    closeDropdown();
}

function onDocumentPointerDown(e: MouseEvent) {
    if (!open.value) return;
    const target = e.target as Node | null;

    if (
        (panelRef.value && target && panelRef.value.contains(target)) ||
        (anchorRef.value && target && anchorRef.value.contains(target))
    ) {
        return;
    }

    closeDropdown();
}

function onDocumentKeyDown(e: KeyboardEvent) {
    if (!open.value) return;
    if (e.key === "Escape") closeDropdown();
}

onMounted(() => {
    document.addEventListener("mousedown", onDocumentPointerDown);
    document.addEventListener("keydown", onDocumentKeyDown);
});

onBeforeUnmount(() => {
    document.removeEventListener("mousedown", onDocumentPointerDown);
    document.removeEventListener("keydown", onDocumentKeyDown);
});
</script>

<template>
    <div class="relative">
        <!-- Trigger -->
        <button
            ref="anchorRef"
            class="px-1 py-1 rounded-md flex items-center gap-2 hover:bg-(--sub-color)/30 transition"
            :aria-expanded="open"
            aria-haspopup="menu"
            @click="toggleDropdown"
        >
            <Icon
                :name="activeView.icon"
                class="text-(--main-color) opacity-90 shrink-0 scale-150"
            />
            <span class="text-3xl font-serif text-(--main-color)">
                {{ activeView.label }}
            </span>
            <Icon
                name="lucide:chevron-down"
                class="text-(--main-color) opacity-70 shrink-0"
            />
        </button>

        <!-- Panel -->
        <div
            v-if="open"
            ref="panelRef"
            class="absolute left-0 mt-2 w-40 bg-(--bg-color) border border-(--sub-color) rounded-md shadow-lg z-50 overflow-hidden"
            role="menu"
        >
            <div class="px-3 py-2 border-b border-(--sub-color)">
                <div class="text-xs opacity-70">View</div>
                <div class="text-sm font-semibold truncate">
                    {{ activeView.label }}
                </div>
            </div>

            <div>
                <button
                    v-for="v in views"
                    :key="v.id"
                    class="w-full px-3 py-2 text-left justify-start! gap-3 transition rounded-none!"
                    :class="[
                        props.modelValue === v.id
                            ? 'bg-(--sub-color)/20'
                            : 'hover:bg-(--sub-color)/15',
                        !v.enabled ? 'opacity-60 cursor-not-allowed' : '',
                    ]"
                    role="menuitem"
                    :disabled="!v.enabled"
                    @click="selectView(v.id)"
                >
                    <div class="flex items-center gap-2 min-w-0">
                        <Icon
                            :name="v.icon"
                            class="text-(--main-color) opacity-80 shrink-0"
                        />
                        <div class="min-w-0">
                            <div class="truncate text-sm">
                                {{ v.label }}
                            </div>
                            <div v-if="v.subtitle" class="text-xs opacity-70">
                                {{ v.subtitle }}
                            </div>
                        </div>
                    </div>

                    <Icon
                        v-if="props.modelValue === v.id"
                        name="lucide:check"
                        class="text-(--main-color) opacity-80 shrink-0"
                    />
                </button>
            </div>
        </div>
    </div>
</template>
