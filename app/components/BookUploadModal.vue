<script setup lang="ts">
import { useDropZone } from '@vueuse/core';

// Explicit component name helps Nuxt's DevTools and makes intent clear.
defineOptions({ name: 'BookUploadModal' });

const uiStore = useUiStore();

const emit = defineEmits<{
  (e: 'uploaded'): void;
}>();

const dropZoneRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);

const files = ref<File[]>([]);
const uploading = ref(false);
const errorMessage = ref<string | null>(null);

type CollectionOption = {
  id: string;
  name: string;
  isPersonal?: boolean;
};

const collectionsLoading = ref(false);
const collections = ref<CollectionOption[]>([]);
const selectedCollectionIds = ref<string[]>([]);

const personalCollectionId = computed(() => {
  return collections.value.find((c) => c.isPersonal)?.id ?? null;
});

watch(
  () => personalCollectionId.value,
  (id) => {
    if (!id) return;
    // Force Personal to always be selected.
    if (!selectedCollectionIds.value.includes(id)) {
      selectedCollectionIds.value = [id, ...selectedCollectionIds.value];
    }
  },
);

async function fetchCollections() {
  collectionsLoading.value = true;
  try {
    const res = await $fetch<{
      success: boolean;
      data?: {
        collections?: Array<{
          id: string;
          name: string;
          isPersonal?: boolean;
        }>;
      };
    }>('/api/collections', { method: 'GET' });

    collections.value = (res?.data?.collections ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      isPersonal: Boolean(c.isPersonal),
    }));

    // Default selection behavior:
    // - Always include the user's Personal collection (non-optional)
    // - Otherwise allow adding additional collections
    if (collections.value.length) {
      const personal = collections.value.find((c) => c.isPersonal);
      const personalId = personal?.id ?? null;

      if (personalId) {
        // Ensure Personal is always selected.
        if (!selectedCollectionIds.value.includes(personalId)) {
          selectedCollectionIds.value = [
            personalId,
            ...selectedCollectionIds.value,
          ];
        }
      } else if (!selectedCollectionIds.value.length) {
        // Fallback: if Personal isn't present for some reason, pick the first.
        selectedCollectionIds.value = [collections.value[0]!.id];
      }
    }
  } finally {
    collectionsLoading.value = false;
  }
}

const ALLOWED_EBOOK_EXTENSIONS = ['epub', 'pdf', 'mobi', 'azw3'] as const;
type AllowedEbookExtension = (typeof ALLOWED_EBOOK_EXTENSIONS)[number];

function getExtensionFromFilename(filename: string): string {
  const m = (filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m?.[1] ?? '';
}

function isAllowedUploadFile(f: File): boolean {
  const ext = getExtensionFromFilename(f.name);

  if (ext === 'epub' && (f.type === 'application/epub+zip' || f.type === '')) {
    return true;
  }

  // Some browsers omit or misreport `type` for these formats; accept by extension.
  if (ALLOWED_EBOOK_EXTENSIONS.includes(ext as AllowedEbookExtension)) {
    return true;
  }

  // Also allow by common PDF mime type.
  if (ext === 'pdf' && (f.type === 'application/pdf' || f.type === '')) {
    return true;
  }

  return false;
}

function toAllowedUploadFiles(list: FileList | File[]): File[] {
  const arr = Array.from(list);
  return arr.filter(isAllowedUploadFile);
}

function addFiles(newFiles: File[]) {
  if (!newFiles.length) return;
  files.value = [...files.value, ...newFiles];
}

function clearFiles() {
  files.value = [];
  if (inputRef.value) inputRef.value.value = '';
}

function removeFile(file: File) {
  files.value = files.value.filter((f) => f !== file);
}

function browse() {
  inputRef.value?.click();
}

watch(
  () => uiStore.bookUploadModalVisible,
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
    addFiles(toAllowedUploadFiles(dropped));
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
      form.append('file', f);
    }

    // Send selected collection ids (multi-select).
    // Personal is forced in the UI; server also defaults to Personal if none sent.
    for (const id of selectedCollectionIds.value) {
      form.append('collectionId', id);
    }

    await $fetch('/api/books/upload', {
      method: 'POST',
      body: form,
    });

    uiStore.setBookUploadModalVisible(false);
    emit('uploaded');
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message || e?.statusMessage || e?.message || 'Upload failed';
  } finally {
    uploading.value = false;
  }
}
</script>

<template>
  <ModalWindow
    :open="uiStore.bookUploadModalVisible"
    @close="uiStore.setBookUploadModalVisible(false)"
  >
    <div class="flex flex-col gap-2 w-[320px]">
      <div class="flex items-start justify-between gap-4">
        <div>
          <div class="text-lg font-semibold">Upload books</div>
          <div class="text-sm opacity-80">
            Drop ebook files here or browse (EPUB, PDF, MOBI, AZW3).
          </div>
        </div>

        <icon
          name="lucide-x"
          class="scale-150 cursor-pointer opacity-80 hover:opacity-100"
          @click.stop="uiStore.setBookUploadModalVisible(false)"
        />
      </div>

      <div class="space-y-1">
        <div class="text-sm font-semibold">Collections</div>

        <div v-if="collectionsLoading" class="text-sm opacity-80">
          Loading collections…
        </div>

        <div v-else-if="!collections.length" class="text-sm opacity-80">
          No collections available.
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
              :disabled="uploading || c.isPersonal"
              class="peer sr-only"
            />
            <span
              class="h-5 w-5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer"
              :class="
                uploading || c.isPersonal
                  ? 'peer-checked:bg-(--sub-color) cursor-default!'
                  : ''
              "
            ></span>
            <span class="truncate">{{ c.name }}</span>
            <span
              v-if="c.isPersonal"
              class="ml-1 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-(--sub-color) opacity-70"
            >
              Personal
            </span>
          </label>

          <div class="text-xs opacity-70">
            All books will be uploaded to your Personal collection by default.
            You can also add them to additional collections.
          </div>
        </div>
      </div>

      <div
        ref="dropZoneRef"
        class="border border-dashed rounded-md p-6 flex flex-col items-center justify-center gap-3 cursor-pointer"
        @click="browse"
      >
        <div class="text-md opacity-80 text-center">
          Drag & drop ebook files here
        </div>
        <icon name="lucide-book" class="scale-200 opacity-80" />
        <div class="text-md opacity-80 text-center">Or click to browse</div>

        <div class="flex gap-2 items-center">
          <input
            ref="inputRef"
            type="file"
            class="hidden"
            multiple
            accept=".epub,.pdf,.mobi,.azw3,application/epub+zip,application/pdf"
            @change="
              (e) => {
                const picked =
                  (e.target as HTMLInputElement).files ?? undefined;
                if (picked) addFiles(toAllowedUploadFiles(picked));
              }
            "
          />
        </div>
      </div>

      <div v-if="files.length" class="space-y-2">
        <div class="text-sm font-semibold">
          Pending Uploads:
          <span class="font-normal opacity-80">{{ files.length }}</span>
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
                : 'Upload selected books'
            "
            class="px-3 py-2 w-full disabled:opacity-50 bg-(--sub-color)/15"
            :disabled="
              uploading || !files.length || !selectedCollectionIds.length
            "
            @click="uploadEpubs"
          >
            {{ uploading ? 'Uploading...' : 'Upload' }}
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
