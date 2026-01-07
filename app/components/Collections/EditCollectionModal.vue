<script setup lang="ts">
import type { Collection } from "~/stores/collections";

defineOptions({ name: "EditCollectionModal" });

const props = defineProps<{
    open: boolean;
    collection: Collection | null;
}>();

const emit = defineEmits<{
    (e: "close"): void;
    (e: "saved", payload: { id: string; name: string }): void;
}>();

type FetchErrorLike = {
    data?: { message?: string };
    statusMessage?: string;
    message?: string;
};

const collectionsStore = useCollectionsStore();

const saving = ref(false);
const errorMessage = ref<string | null>(null);
const name = ref("");

watch(
    () => props.open,
    (open) => {
        if (!open) return;

        errorMessage.value = null;
        saving.value = false;
        name.value = props.collection?.name ?? "";
    },
);

const canEdit = computed(() => {
    const c = props.collection;
    if (!c) return false;
    return collectionsStore.canEditCollection(c);
});

const title = computed(() => {
    if (props.collection?.isPersonal) return "Edit Personal collection";
    return "Edit collection";
});

const subtitle = computed(() => {
    if (props.collection?.isPersonal) {
        return "This is your default collection. All uploads go here by default.";
    }
    return "Update your collection name.";
});

async function save() {
    if (saving.value) return;

    const c = props.collection;
    if (!c) return;

    if (!canEdit.value) {
        errorMessage.value =
            "You do not have permission to edit this collection.";
        return;
    }

    const trimmed = name.value.trim();
    if (!trimmed) {
        errorMessage.value = "Collection name is required.";
        return;
    }

    saving.value = true;
    errorMessage.value = null;

    try {
        await collectionsStore.updateCollectionName(c.id, trimmed);

        // Ensure any other UI reading this list also sees the latest.
        await collectionsStore.fetchCollections();

        emit("saved", { id: c.id, name: trimmed });
        emit("close");
    } catch (err: unknown) {
        const e = err as FetchErrorLike;
        errorMessage.value =
            e?.data?.message ||
            e?.statusMessage ||
            e?.message ||
            "Failed to update collection.";
    } finally {
        saving.value = false;
    }
}

function close() {
    if (saving.value) return;
    emit("close");
}
</script>

<template>
    <ModalWindow :open="open" @close="close">
        <div class="flex flex-col gap-3 w-90 max-w-[80vw]">
            <div class="flex items-start justify-between gap-4">
                <div>
                    <div class="text-lg font-semibold">{{ title }}</div>
                    <div class="text-sm opacity-80">
                        {{ subtitle }}
                    </div>
                </div>

                <Icon
                    v-tooltip="'Close'"
                    name="lucide:x"
                    class="scale-150 cursor-pointer opacity-80 hover:opacity-100"
                    @click="close"
                />
            </div>

            <div v-if="collection?.isPersonal" class="text-xs opacity-70">
                <div class="flex items-center gap-2">
                    <span
                        class="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-(--sub-color) opacity-70"
                    >
                        Personal
                    </span>
                    <span>Non-deletable and not shareable.</span>
                </div>
            </div>

            <div class="space-y-2">
                <input
                    v-model="name"
                    type="text"
                    placeholder="Collection name…"
                    class="w-full px-3 py-2 border rounded-md bg-(--bg-color)"
                    :disabled="saving || !canEdit"
                    @keyup.enter="save"
                />

                <p v-if="!canEdit" class="text-sm text-red-600">
                    You do not have permission to edit this collection.
                </p>

                <p v-else-if="errorMessage" class="text-sm text-red-600">
                    {{ errorMessage }}
                </p>
            </div>

            <div class="flex gap-2 justify-end">
                <button
                    v-tooltip="'Cancel'"
                    class="px-3 py-2"
                    :disabled="saving"
                    @click="close"
                >
                    Cancel
                </button>

                <button
                    v-tooltip="'Save changes'"
                    class="px-3 py-2 bg-(--main-color) text-(--bg-color)"
                    :disabled="saving || !canEdit || !name.trim()"
                    @click="save"
                >
                    {{ saving ? "Saving…" : "Save" }}
                </button>
            </div>
        </div>
    </ModalWindow>
</template>
