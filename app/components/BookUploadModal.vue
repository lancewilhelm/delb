<script setup lang="ts">
import { useDropZone } from "@vueuse/core";

// Explicit component name helps Nuxt's DevTools and makes intent clear.
defineOptions({ name: "BookUploadModal" });

const props = defineProps<{
    open: boolean;
}>();

const emit = defineEmits<{
    (e: "close" | "uploaded"): void;
}>();

const dropZoneRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);

const files = ref<File[]>([]);
const uploading = ref(false);
const errorMessage = ref<string | null>(null);

type CollectionOption = {
    id: string;
    name: string;
};

const collectionsLoading = ref(false);
const collections = ref<CollectionOption[]>([]);
const selectedCollectionIds = ref<string[]>([]);

async function fetchCollections() {
    collectionsLoading.value = true;
    try {
        const res = await $fetch<{
            success: boolean;
            data?: { collections?: Array<{ id: string; name: string }> };
        }>("/api/collections", { method: "GET" });

        collections.value = (res?.data?.collections ?? []).map((c) => ({
            id: c.id,
            name: c.name,
        }));

        // Default selection behavior:
        // - If nothing selected yet, pick the first available collection.
        // (Server should ensure a "Personal" collection exists; until then this
        // falls back to first.)
        if (!selectedCollectionIds.value.length && collections.value.length) {
            selectedCollectionIds.value = [collections.value[0]!.id];
        }
    } finally {
        collectionsLoading.value = false;
    }
}

function toEpubFiles(list: FileList | File[]): File[] {
    const arr = Array.from(list);
    return arr.filter((f) => {
        const nameOk = f.name.toLowerCase().endsWith(".epub");
        const typeOk = f.type === "application/epub+zip";
        // Some browsers may omit `type`, so accept by extension.
        return nameOk || typeOk;
    });
}

function addFiles(newFiles: File[]) {
    if (!newFiles.length) return;
    files.value = [...files.value, ...newFiles];
}

function clearFiles() {
    files.value = [];
    if (inputRef.value) inputRef.value.value = "";
}

function removeFile(file: File) {
    files.value = files.value.filter((f) => f !== file);
}

function browse() {
    inputRef.value?.click();
}

watch(
    () => props.open,
    async (open) => {
        if (open) {
            // Reset per-open to keep the flow simple/predictable.
            errorMessage.value = null;
            uploading.value = false;
            clearFiles();

            // Load collections when modal opens so selection is current.
            await fetchCollections();
        }
    },
);

useDropZone(dropZoneRef, {
    onDrop(dropped) {
        if (!dropped) return;
        addFiles(toEpubFiles(dropped));
    },
});

type FetchErrorLike = {
    data?: { message?: string };
    statusMessage?: string;
    message?: string;
};

async function uploadEpubs() {
    if (!files.value.length || uploading.value) return;

    uploading.value = true;
    errorMessage.value = null;

    try {
        const form = new FormData();
        for (const f of files.value) {
            form.append("file", f);
        }

        // Send selected collection ids (multi-select).
        for (const id of selectedCollectionIds.value) {
            form.append("collectionId", id);
        }

        await $fetch("/api/books/upload", {
            method: "POST",
            body: form,
        });

        emit("uploaded");
        emit("close");
    } catch (err) {
        const e = err as FetchErrorLike;
        errorMessage.value =
            e?.data?.message ||
            e?.statusMessage ||
            e?.message ||
            "Upload failed";
    } finally {
        uploading.value = false;
    }
}
</script>

<template>
    <ModalWindow :open="open" @close="emit('close')">
        <div class="flex flex-col gap-2 w-[320px]">
            <div class="flex items-start justify-between gap-4">
                <div>
                    <div class="text-lg font-semibold">Upload books</div>
                    <div class="text-sm opacity-80">
                        Drop EPUB files here or browse.
                    </div>
                </div>

                <icon
                    name="lucide-x"
                    class="scale-150 cursor-pointer opacity-80 hover:opacity-100"
                    @click="emit('close')"
                />
            </div>

            <div class="space-y-1">
                <div class="text-sm font-semibold">Collections</div>

                <div v-if="collectionsLoading" class="text-sm opacity-80">
                    Loading collections…
                </div>

                <div v-else-if="!collections.length" class="text-sm opacity-80">
                    No collections yet. Create one, then upload.
                </div>

                <div v-else class="space-y-1">
                    <label
                        v-for="c in collections"
                        :key="c.id"
                        class="flex items-center gap-2 text-sm"
                    >
                        <input
                            v-model="selectedCollectionIds"
                            type="checkbox"
                            :value="c.id"
                            :disabled="uploading"
                        />
                        <span class="truncate">{{ c.name }}</span>
                    </label>

                    <div class="text-xs opacity-70">
                        Defaults to your personal collection.
                    </div>
                </div>
            </div>

            <div
                ref="dropZoneRef"
                class="border border-dashed rounded-md p-6 flex flex-col items-center justify-center gap-3"
            >
                <div class="text-md opacity-80 text-center">
                    Drag & drop EPUB files here
                </div>
                <icon name="lucide-book" class="scale-200 opacity-80" />

                <div class="flex gap-2 items-center">
                    <input
                        ref="inputRef"
                        type="file"
                        class="hidden"
                        multiple
                        accept=".epub,application/epub+zip"
                        @change="
                            (e) => {
                                const picked =
                                    (e.target as HTMLInputElement).files ??
                                    undefined;
                                if (picked) addFiles(toEpubFiles(picked));
                            }
                        "
                    />
                </div>
            </div>

            <button
                v-tooltip="'Choose EPUB files from your computer'"
                class="px-3 py-2 bg-(--sub-color)/15"
                @click="browse"
            >
                Browse…
            </button>

            <div v-if="files.length" class="space-y-2">
                <div class="text-sm font-semibold">
                    Pending Uploads:
                    <span class="font-normal opacity-80">{{
                        files.length
                    }}</span>
                </div>

                <div class="text-sm opacity-80">
                    <div
                        v-for="f in files"
                        :key="`${f.name}-${f.size}-${f.lastModified}`"
                        class="flex items-center justify-between"
                    >
                        <div class="truncate">{{ f.name }}</div>
                        <icon
                            v-tooltip="'Remove file'"
                            name="lucide-x"
                            class="scale-100 opacity-80 text-(--error-color) cursor-pointer shrink-0"
                            @click="removeFile(f)"
                        />
                    </div>
                </div>

                <div class="flex gap-2 w-full justify-center">
                    <button
                        v-tooltip="
                            !selectedCollectionIds.length
                                ? 'Select at least one collection'
                                : 'Upload selected EPUBs'
                        "
                        class="px-3 py-2 w-full disabled:opacity-50 bg-(--sub-color)/15"
                        :disabled="
                            uploading ||
                            !files.length ||
                            !selectedCollectionIds.length
                        "
                        @click="uploadEpubs"
                    >
                        {{ uploading ? "Uploading..." : "Upload" }}
                    </button>

                    <button
                        v-tooltip="'Remove all pending uploads'"
                        class="px-3 py-2 w-full disabled:opacity-50 hover:bg-(--error-color)! bg-(--sub-color)/15"
                        :disabled="uploading"
                        @click="clearFiles"
                    >
                        Clear
                    </button>
                </div>
            </div>

            <p v-if="errorMessage" class="text-sm text-red-600">
                {{ errorMessage }}
            </p>
        </div>
    </ModalWindow>
</template>
