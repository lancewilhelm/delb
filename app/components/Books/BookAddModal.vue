<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useDropZone } from '@vueuse/core';

defineOptions({ name: 'BookAddModal' });

const uiStore = useUiStore();

const emit = defineEmits<{
  /**
   * Fired after either flow results in new book(s) being added to the library.
   * Mirrors the prior modals behavior so callers can refresh lists.
   */
  (e: 'added' | 'book-uploaded'): void;
}>();

type Mode = 'upload' | 'metadata';

type CollectionOption = {
  id: string;
  name: string;
  isPersonal?: boolean;
};

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

const mode = ref<Mode>('upload');

// Shared collections
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
    // Force Personal to always be selected across both flows.
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
        collections?: Array<{ id: string; name: string; isPersonal?: boolean }>;
      };
      message?: string;
    }>('/api/collections', { method: 'GET' });

    collections.value = (res?.data?.collections ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      isPersonal: Boolean(c.isPersonal),
    }));

    // Ensure we always have a sensible selection.
    if (collections.value.length) {
      const personal = collections.value.find((c) => c.isPersonal);
      const pid = personal?.id ?? null;

      const collectionsStore = useCollectionsStore();
      const currentId = collectionsStore.activeCollectionId;

      if (pid) {
        if (!selectedCollectionIds.value.includes(pid)) {
          selectedCollectionIds.value = [pid, ...selectedCollectionIds.value];
        }
      }

      if (currentId && !selectedCollectionIds.value.includes(currentId)) {
        selectedCollectionIds.value = [
          ...selectedCollectionIds.value,
          currentId,
        ];
      }
    }
  } finally {
    collectionsLoading.value = false;
  }
}

// Modal open/reset behavior
const errorMessage = ref<string | null>(null);
const successMessage = ref<string | null>(null);

// Upload flow state
const dropZoneRef = ref<HTMLElement | null>(null);
const uploadInputRef = ref<HTMLInputElement | null>(null);
const files = ref<File[]>([]);
const uploading = ref(false);

// Metadata flow state
const metadataInputRef = ref<HTMLInputElement | null>(null);
const query = ref('');
const keepOpen = ref(false);
const creating = ref(false);

function focusMetadataInputSoon() {
  requestAnimationFrame(() => {
    metadataInputRef.value?.focus();
    metadataInputRef.value?.select?.();
  });
}

function resetPerOpen() {
  errorMessage.value = null;
  successMessage.value = null;

  mode.value = 'upload';

  // Upload state
  uploading.value = false;
  files.value = [];
  if (uploadInputRef.value) uploadInputRef.value.value = '';

  // Metadata state
  creating.value = false;
  query.value = '';
  keepOpen.value = false;
}

function close() {
  uiStore.setAddBookModalVisible(false);
  // Clear the selected collections
  selectedCollectionIds.value = [];
}

const isOpen = computed(() => uiStore.addBookModalVisible);

watch(
  () => uiStore.addBookModalVisible,
  async (open) => {
    if (!open) return;

    resetPerOpen();

    // Unified modal always starts in upload mode by default.
    // (If you want to preserve last-used mode later, we can persist `mode`.)
    mode.value = 'upload';

    await fetchCollections();
  },
);

// -------------------- Upload flow --------------------
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
  if (uploadInputRef.value) uploadInputRef.value.value = '';
}

function removeFile(file: File) {
  files.value = files.value.filter((f) => f !== file);
}

function browseUpload() {
  uploadInputRef.value?.click();
}

useDropZone(dropZoneRef, {
  onDrop(dropped) {
    if (!dropped) return;
    addFiles(toAllowedUploadFiles(dropped));
  },
});

async function uploadBooks() {
  if (!files.value.length || uploading.value) return;

  const collectionIds = selectedCollectionIds.value.filter(Boolean);
  if (!collectionIds.length) {
    errorMessage.value = 'Select at least one collection.';
    return;
  }

  uploading.value = true;
  errorMessage.value = null;
  successMessage.value = null;

  try {
    // Upload sequentially so duplicate prompts can be handled one-at-a-time.
    // This avoids the confusing "some uploaded, then a duplicate modal" state.
    while (files.value.length) {
      const file = files.value[0];
      if (!file) break;

      const form = new FormData();
      form.append('file', file);
      for (const id of collectionIds) form.append('collectionId', id);

      const res = await $fetch<{
        success: boolean;
        data?: {
          results?: Array<{
            success: boolean;
            filename?: string;
            error?: string;
            code?: string;
            details?: unknown;
          }>;
        };
      }>('/api/books/upload', { method: 'POST', body: form });

      const r = (res?.data?.results ?? [])[0];

      if (r && !r.success && r.code === 'possible_duplicate') {
        duplicateReview.value = {
          kind: 'upload',
          file,
          filename: file.name,
          details: r.details,
        };
        selectedDuplicateBookId.value = defaultSelectedDuplicate(r.details);
        duplicateReviewOpen.value = true;
        errorMessage.value = 'Possible duplicate detected. Review required.';
        return;
      }

      if (r && !r.success) {
        errorMessage.value = r.error || 'Upload failed';
        return;
      }

      files.value = files.value.filter((f) => f !== file);
      emit('added');
      emit('book-uploaded');
    }

    close();
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message || e?.statusMessage || e?.message || 'Upload failed';
  } finally {
    uploading.value = false;
  }
}

type DuplicateCandidate = {
  matchType: 'identifier' | 'fuzzy';
  score: number;
  book: {
    id: string;
    title: string;
    coverImagePath: string | null;
    authorNames: string[];
    identifiers: Array<{ type: string; value: string }>;
  };
};

type DuplicateReview = {
  kind: 'upload' | 'metadata';
  file: File | undefined;
  filename: string;
  details: unknown;
};

const duplicateReviewOpen = ref(false);
const duplicateReview = ref<DuplicateReview | null>(null);

const selectedDuplicateBookId = ref<string>('');

function defaultSelectedDuplicate(details: unknown): string {
  const candidates = parseDuplicateCandidates(details);
  return candidates[0]?.book?.id ?? '';
}

function coverThumbUrl(coverImagePath: string | null | undefined): string {
  const p = (coverImagePath ?? '').toString().trim();
  if (!p) return '';
  return `/api/media/covers/${p.replace(/^library\//, '')}`;
}

function parseDuplicateCandidates(details: unknown): DuplicateCandidate[] {
  if (!details || typeof details !== 'object') return [];
  if (!('candidates' in details)) return [];
  const raw = (details as { candidates?: unknown }).candidates;
  return Array.isArray(raw) ? (raw as DuplicateCandidate[]) : [];
}

function parseIncoming(details: unknown): { title: string; author: string } {
  if (!details || typeof details !== 'object') return { title: '', author: '' };
  const incoming = (details as { incoming?: unknown }).incoming;
  if (!incoming || typeof incoming !== 'object')
    return { title: '', author: '' };
  return {
    title: (incoming as { title?: unknown }).title
      ? String((incoming as { title?: unknown }).title)
      : '',
    author: (incoming as { author?: unknown }).author
      ? String((incoming as { author?: unknown }).author)
      : '',
  };
}

async function uploadAnyway() {
  const review = duplicateReview.value;
  if (!review || review.kind !== 'upload') return;
  const file = review?.file;
  if (!review || !file || uploading.value) return;

  const collectionIds = selectedCollectionIds.value.filter(Boolean);
  if (!collectionIds.length) {
    errorMessage.value = 'Select at least one collection.';
    return;
  }

  uploading.value = true;
  errorMessage.value = null;
  let continueQueue = false;

  try {
    const form = new FormData();
    form.append('file', file);
    for (const id of collectionIds) form.append('collectionId', id);
    form.append('allowDuplicate', '1');

    const res = await $fetch<{
      success: boolean;
      data?: {
        results?: Array<{ success: boolean; error?: string; code?: string }>;
      };
    }>('/api/books/upload', { method: 'POST', body: form });

    const failed = (res?.data?.results ?? []).find((r) => !r.success);
    if (failed) {
      errorMessage.value = failed.error || 'Upload failed';
      return;
    }

    files.value = files.value.filter((f) => f !== file);

    duplicateReviewOpen.value = false;
    duplicateReview.value = null;
    selectedDuplicateBookId.value = '';

    emit('added');
    emit('book-uploaded');

    continueQueue = files.value.length > 0;

    if (!continueQueue) {
      close();
    }
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message || e?.statusMessage || e?.message || 'Upload failed';
  } finally {
    uploading.value = false;
  }

  if (continueQueue) {
    await uploadBooks();
  }
}

function cancelDuplicate() {
  const review = duplicateReview.value;
  if (!review) return;

  if (review.kind === 'upload') {
    // "Skip upload": drop this file and continue with remaining queue.
    const file = review.file;
    if (file) files.value = files.value.filter((f) => f !== file);
  }

  duplicateReviewOpen.value = false;
  duplicateReview.value = null;
  selectedDuplicateBookId.value = '';

  if (review.kind === 'upload') {
    // Keep the modal's errors scoped; allow the next upload to proceed.
    errorMessage.value = null;
    successMessage.value = null;

    if (!files.value.length) {
      close();
    } else {
      void uploadBooks();
    }
  }
}

async function replaceSelected() {
  const review = duplicateReview.value;
  if (!review || review.kind !== 'upload') return;

  const file = review.file;
  const replaceBookId = selectedDuplicateBookId.value.trim();
  if (!file || !replaceBookId || uploading.value) return;

  const collectionIds = selectedCollectionIds.value.filter(Boolean);
  if (!collectionIds.length) {
    errorMessage.value = 'Select at least one collection.';
    return;
  }

  uploading.value = true;
  errorMessage.value = null;
  let continueQueue = false;

  try {
    const form = new FormData();
    form.append('file', file);
    for (const id of collectionIds) form.append('collectionId', id);
    form.append('allowDuplicate', '1');
    form.append('replaceBookId', replaceBookId);

    const res = await $fetch<{
      success: boolean;
      data?: {
        results?: Array<{ success: boolean; error?: string; code?: string }>;
      };
    }>('/api/books/upload', { method: 'POST', body: form });

    const failed = (res?.data?.results ?? []).find((r) => !r.success);
    if (failed) {
      errorMessage.value = failed.error || 'Upload failed';
      return;
    }

    files.value = files.value.filter((f) => f !== file);

    duplicateReviewOpen.value = false;
    duplicateReview.value = null;
    selectedDuplicateBookId.value = '';

    emit('added');
    emit('book-uploaded');

    continueQueue = files.value.length > 0;

    if (!continueQueue) {
      close();
    }
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message || e?.statusMessage || e?.message || 'Upload failed';
  } finally {
    uploading.value = false;
  }

  if (continueQueue) {
    await uploadBooks();
  }
}

async function addFromMetadataAnyway() {
  if (creating.value) return;

  const q = query.value.trim();
  if (!q) {
    errorMessage.value = 'Please enter a search query.';
    successMessage.value = null;
    focusMetadataInputSoon();
    return;
  }

  const collectionIds = selectedCollectionIds.value.filter(Boolean);
  if (!collectionIds.length) {
    errorMessage.value = 'Select at least one collection.';
    successMessage.value = null;
    return;
  }

  creating.value = true;
  errorMessage.value = null;
  successMessage.value = null;

  try {
    const res = await $fetch<{
      success: boolean;
      data?: { book?: { id: string; title: string } };
      message?: string;
    }>('/api/books/metadata-import/create', {
      method: 'POST',
      body: {
        query: q,
        collectionIds,
        allowDuplicate: true,
      },
    });

    const bookId = res?.data?.book?.id ?? '';
    const title = res?.data?.book?.title ?? '';

    if (!bookId) {
      throw new Error(res?.message || 'Failed to create book from metadata.');
    }

    successMessage.value = title
      ? `Added “${title}”.`
      : 'Book added successfully.';

    duplicateReviewOpen.value = false;
    duplicateReview.value = null;

    emit('added');
    emit('book-uploaded');

    if (keepOpen.value) {
      query.value = '';
      focusMetadataInputSoon();
    } else {
      close();
    }
  } catch (err) {
    const e = err as FetchErrorLike & { data?: { code?: string } };
    if (e?.data?.code === 'possible_duplicate') {
      duplicateReview.value = {
        kind: 'metadata',
        file: undefined,
        filename: 'metadata',
        details: e.data,
      };
      selectedDuplicateBookId.value = defaultSelectedDuplicate(e.data);
      duplicateReviewOpen.value = true;
      errorMessage.value = 'Possible duplicate detected. Review required.';
      successMessage.value = null;
      return;
    }
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to add book from metadata.';
    successMessage.value = null;
    focusMetadataInputSoon();
  } finally {
    creating.value = false;
  }
}

async function proceedWithDuplicate() {
  const review = duplicateReview.value;
  if (!review) return;
  if (review.kind === 'upload') {
    await uploadAnyway();
  } else {
    await addFromMetadataAnyway();
  }
}

// -------------------- Metadata flow --------------------
async function createFromMetadata() {
  if (creating.value) return;

  const q = query.value.trim();
  if (!q) {
    errorMessage.value = 'Please enter a search query.';
    successMessage.value = null;
    focusMetadataInputSoon();
    return;
  }

  const collectionIds = selectedCollectionIds.value.filter(Boolean);
  if (!collectionIds.length) {
    errorMessage.value = 'Select at least one collection.';
    successMessage.value = null;
    return;
  }

  creating.value = true;
  errorMessage.value = null;
  successMessage.value = null;

  try {
    const res = await $fetch<{
      success: boolean;
      data?: { book?: { id: string; title: string } };
      message?: string;
    }>('/api/books/metadata-import/create', {
      method: 'POST',
      body: {
        query: q,
        collectionIds,
      },
    });

    const bookId = res?.data?.book?.id ?? '';
    const title = res?.data?.book?.title ?? '';

    if (!bookId) {
      throw new Error(res?.message || 'Failed to create book from metadata.');
    }

    successMessage.value = title
      ? `Added “${title}”.`
      : 'Book added successfully.';

    emit('added');
    emit('book-uploaded');

    if (keepOpen.value) {
      query.value = '';
      focusMetadataInputSoon();
    } else {
      close();
    }
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to add book from metadata.';
    successMessage.value = null;
    focusMetadataInputSoon();
  } finally {
    creating.value = false;
  }
}

function onMetadataEnter(e: KeyboardEvent) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  createFromMetadata();
}

watch(
  () => mode.value,
  (next) => {
    // switch UX nicety
    errorMessage.value = null;
    successMessage.value = null;

    if (next === 'metadata') {
      focusMetadataInputSoon();
    }
  },
);

const actionDisabled = computed(() => {
  const noCollections = !selectedCollectionIds.value.length;

  if (mode.value === 'upload') {
    return uploading.value || !files.value.length || noCollections;
  }

  return creating.value || !query.value.trim() || noCollections;
});

const busy = computed(() => uploading.value || creating.value);

const titleText = computed(() =>
  mode.value === 'upload' ? 'Add books' : 'Add book by metadata',
);
const subtitleText = computed(() =>
  mode.value === 'upload'
    ? 'Drop ebook files here or browse (EPUB, PDF, MOBI, AZW3). Metadata will be extracted from the file.'
    : 'Search using the default metadata provider and add the top result. No file will be downloaded.',
);
</script>

<template>
  <ModalWindow :open="isOpen" @close="close">
    <div class="flex flex-col gap-3 sm:w-95">
      <div class="flex items-start justify-between gap-4">
        <div>
          <div class="text-lg font-semibold">{{ titleText }}</div>
          <div class="text-sm opacity-80">
            {{ subtitleText }}
          </div>
        </div>

        <Icon
          name="lucide-x"
          class="shrink-0 text-xl cursor-pointer opacity-80 hover:opacity-100"
          @click.stop="close"
        />
      </div>

      <!-- Mode toggle -->
      <div class="flex gap-2">
        <button
          type="button"
          class="flex-1 border border-(--sub-color) p-2 rounded-md transition"
          :class="
            mode === 'upload'
              ? 'bg-(--main-color)/20'
              : 'hover:bg-(--main-color)/10'
          "
          :disabled="busy"
          @click="mode = 'upload'"
        >
          <span class="flex items-center justify-center gap-2">
            <Icon name="lucide:upload" />
            <span>Upload files</span>
          </span>
        </button>

        <button
          type="button"
          class="flex-1 border border-(--sub-color) p-2 rounded-md transition"
          :class="
            mode === 'metadata'
              ? 'bg-(--main-color)/20'
              : 'hover:bg-(--main-color)/10'
          "
          :disabled="busy"
          @click="mode = 'metadata'"
        >
          <span class="flex items-center justify-center gap-2">
            <Icon name="lucide:search" />
            <span>By metadata</span>
          </span>
        </button>
      </div>

      <!-- Shared collections -->
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
              :disabled="busy || c.isPersonal"
              class="peer sr-only"
            />
            <span
              class="h-5 w-5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer"
              :class="
                busy || c.isPersonal
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
            Your Personal collection is always included (required). You can also
            add to additional collections.
          </div>
        </div>
      </div>

      <ModalWindow
        :open="duplicateReviewOpen"
        :width-full="true"
        @close="cancelDuplicate"
      >
        <div class="flex flex-col gap-3 w-full max-w-200">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="text-lg font-semibold">Possible duplicate</div>
              <div class="text-sm opacity-80">
                Review the existing match(es) and decide what to do.
              </div>
            </div>

            <Icon
              name="lucide-x"
              class="shrink-0 text-xl cursor-pointer opacity-80 hover:opacity-100"
              @click.stop="cancelDuplicate"
            />
          </div>

          <div
            v-if="duplicateReview"
            class="p-3 rounded border border-(--sub-color)/30"
          >
            <div class="text-sm font-semibold">Incoming</div>
            <div class="text-sm opacity-90 mt-1">
              <span class="font-mono">{{ duplicateReview.filename }}</span>
            </div>
            <div class="text-sm opacity-90 mt-1">
              <span class="font-semibold">title:</span>
              {{ parseIncoming(duplicateReview.details).title || '—' }}
            </div>
            <div class="text-sm opacity-90">
              <span class="font-semibold">author:</span>
              {{ parseIncoming(duplicateReview.details).author || '—' }}
            </div>
          </div>

          <div class="space-y-2">
            <div class="text-sm font-semibold">Existing candidates</div>

            <div
              v-for="c in parseDuplicateCandidates(duplicateReview?.details)"
              :key="c.book.id"
              class="flex gap-3 p-3 rounded border border-(--sub-color)/30"
            >
              <input
                v-model="selectedDuplicateBookId"
                type="radio"
                :value="c.book.id"
                class="mt-1"
                :disabled="busy"
              />
              <div class="shrink-0">
                <img
                  v-if="c.book.coverImagePath"
                  :src="coverThumbUrl(c.book.coverImagePath)"
                  class="w-16 h-24 object-cover rounded border border-(--sub-color)/30"
                  alt=""
                />
                <div
                  v-else
                  class="w-16 h-24 rounded border border-(--sub-color)/30 flex items-center justify-center text-xs opacity-60"
                >
                  no cover
                </div>
              </div>

              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <div class="font-semibold truncate">{{ c.book.title }}</div>
                  <div class="text-xs opacity-70 font-mono">
                    {{ c.matchType }} {{ Math.round(c.score * 100) }}%
                  </div>
                </div>
                <div class="text-sm opacity-80 truncate">
                  {{
                    (c.book.authorNames || []).join(', ') || 'Unknown Author'
                  }}
                </div>
                <div class="flex flex-wrap gap-2 mt-2">
                  <button
                    type="button"
                    class="px-3 py-2 bg-(--sub-color)/15 disabled:opacity-50"
                    :disabled="busy"
                    @click="navigateTo(`/books/${c.book.id}`)"
                  >
                    View book
                  </button>
                </div>
              </div>
            </div>

            <div
              v-if="
                duplicateReview &&
                !parseDuplicateCandidates(duplicateReview.details).length
              "
              class="text-sm opacity-70"
            >
              No candidates returned.
            </div>
          </div>

          <div class="flex flex-wrap gap-2 justify-end">
            <button
              type="button"
              class="px-3 py-2 bg-(--sub-color)/15 disabled:opacity-50"
              :disabled="busy"
              @click="cancelDuplicate"
            >
              {{ duplicateReview?.kind === 'upload' ? 'Skip upload' : 'Cancel' }}
            </button>

            <button
              type="button"
              class="px-3 py-2 bg-(--sub-color)/15 disabled:opacity-50"
              :disabled="busy"
              @click="proceedWithDuplicate"
            >
              {{ duplicateReview?.kind === 'metadata' ? 'Add anyway' : 'Upload anyway' }}
            </button>

            <button
              v-if="duplicateReview?.kind === 'upload'"
              type="button"
              class="px-3 py-2 bg-(--sub-color)/15 disabled:opacity-50"
              :disabled="busy || !selectedDuplicateBookId"
              @click="replaceSelected"
            >
              Replace selected
            </button>
          </div>
        </div>
      </ModalWindow>

      <!-- Upload mode -->
      <div v-if="mode === 'upload'" class="space-y-3">
        <div
          ref="dropZoneRef"
          class="border border-dashed rounded-md p-6 flex flex-col items-center justify-center gap-3 cursor-pointer"
          @click="browseUpload"
        >
          <div class="text-md opacity-80 text-center">
            Drag & drop ebook files here
          </div>
          <Icon name="lucide:book" class="scale-200 opacity-80" />
          <div class="text-md opacity-80 text-center">Or click to browse</div>

          <input
            ref="uploadInputRef"
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

        <div v-if="files.length" class="space-y-2">
          <div class="text-sm font-semibold">
            Pending uploads:
            <span class="font-normal opacity-80">{{ files.length }}</span>
          </div>

          <div class="text-sm opacity-80">
            <div
              v-for="f in files"
              :key="`${f.name}-${f.size}-${f.lastModified}`"
              class="flex items-center justify-between"
            >
              <div class="truncate">{{ f.name }}</div>
              <Icon
                v-tooltip="'Remove file'"
                name="lucide-x"
                class="scale-100 opacity-80 text-(--error-color) cursor-pointer shrink-0"
                @click="removeFile(f)"
              />
            </div>
          </div>

          <div class="flex gap-2 w-full justify-center">
            <button
              v-tooltip="'Remove all pending uploads'"
              class="px-3 py-2 w-full disabled:opacity-50 hover:bg-(--error-color)! bg-(--sub-color)/15"
              :disabled="uploading"
              @click="clearFiles"
            >
              Clear
            </button>

            <button
              v-tooltip="
                !selectedCollectionIds.length
                  ? 'Select at least one collection'
                  : 'Upload selected books'
              "
              class="px-3 py-2 w-full disabled:opacity-50 bg-(--sub-color)/15"
              :disabled="actionDisabled"
              @click="uploadBooks"
            >
              {{ uploading ? 'Uploading...' : 'Upload' }}
            </button>
          </div>
        </div>

        <div v-else class="text-xs opacity-70">
          Tip: you can select multiple files and upload them in one go.
        </div>
      </div>

      <!-- Metadata mode -->
      <div v-else class="space-y-2">
        <div class="space-y-1">
          <div class="text-sm font-semibold">Search query</div>
          <input
            ref="metadataInputRef"
            v-model="query"
            type="text"
            class="w-full p-2 border border-(--sub-color) rounded-lg"
            placeholder="e.g. Dungeon Crawler Carl, 9780593820247"
            :disabled="creating"
            @keydown="onMetadataEnter"
          />
          <div class="text-xs opacity-70">
            This will auto-fetch the top result from the default provider and
            create a new book record.
          </div>
        </div>

        <label class="flex items-center gap-2 text-sm select-none">
          <input
            v-model="keepOpen"
            type="checkbox"
            class="peer sr-only"
            :disabled="creating"
          />
          <span
            class="h-5 w-5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer"
            :class="
              keepOpen ? 'peer-checked:bg-(--sub-color) cursor-default!' : ''
            "
          ></span>
          <span>Keep open and refocus after each add</span>
        </label>

        <div class="flex gap-2">
          <button
            type="button"
            class="flex-1 border border-(--sub-color) p-2 rounded-md bg-(--main-color)/20 hover:bg-(--main-color)/30 transition"
            :disabled="actionDisabled"
            @click="createFromMetadata"
          >
            <span v-if="creating">Adding…</span>
            <span v-else>Add top result</span>
          </button>
        </div>
      </div>

      <div v-if="errorMessage" class="text-sm text-(--error-color)">
        {{ errorMessage }}
      </div>
      <div v-else-if="successMessage" class="text-sm text-green-400">
        {{ successMessage }}
      </div>
    </div>
  </ModalWindow>
</template>
