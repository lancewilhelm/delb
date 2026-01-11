<script setup lang="ts">
defineOptions({ name: 'BookAddByMetadataModal' });

const uiStore = useUiStore();

const emit = defineEmits<{
  (e: 'created', payload: { bookId: string; title: string }): void;
}>();

type CollectionOption = {
  id: string;
  name: string;
  isPersonal?: boolean;
};

const inputRef = ref<HTMLInputElement | null>(null);

const query = ref('');
const keepOpen = ref(false);

const creating = ref(false);
const errorMessage = ref<string | null>(null);
const successMessage = ref<string | null>(null);

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
    // Force Personal to always be selected (matches upload modal behavior).
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

    if (collections.value.length) {
      const personal = collections.value.find((c) => c.isPersonal);
      const pid = personal?.id ?? null;

      if (pid) {
        if (!selectedCollectionIds.value.includes(pid)) {
          selectedCollectionIds.value = [pid, ...selectedCollectionIds.value];
        }
      } else if (!selectedCollectionIds.value.length) {
        selectedCollectionIds.value = [collections.value[0]!.id];
      }
    }
  } finally {
    collectionsLoading.value = false;
  }
}

function focusInputSoon() {
  // Let the modal render before focusing.
  requestAnimationFrame(() => {
    inputRef.value?.focus();
    inputRef.value?.select?.();
  });
}

function close() {
  uiStore.setBookAddByMetadataModalVisible(false);
}

watch(
  () => uiStore.bookAddByMetadataModalVisible,
  async (open) => {
    if (!open) return;

    // Reset per-open to keep the flow predictable.
    errorMessage.value = null;
    successMessage.value = null;
    creating.value = false;
    query.value = '';
    keepOpen.value = false;

    // Load collections when modal opens so selection is current.
    await fetchCollections();

    focusInputSoon();
  },
);

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

async function createFromMetadata() {
  if (creating.value) return;

  const q = query.value.trim();
  if (!q) {
    errorMessage.value = 'Please enter a search query.';
    successMessage.value = null;
    focusInputSoon();
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
    emit('created', { bookId, title });

    if (keepOpen.value) {
      // Keep query box ready for the next add.
      query.value = '';
      focusInputSoon();
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
    focusInputSoon();
  } finally {
    creating.value = false;
  }
}

function onEnter(e: KeyboardEvent) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  createFromMetadata();
}
</script>

<template>
  <ModalWindow :open="uiStore.bookAddByMetadataModalVisible" @close="close">
    <div class="flex flex-col gap-3 w-[360px]">
      <div class="flex items-start justify-between gap-4">
        <div>
          <div class="text-lg font-semibold">Add book by metadata</div>
          <div class="text-sm opacity-80">
            Search using the default metadata provider and add the top result.
          </div>
        </div>

        <Icon
          name="lucide-x"
          class="scale-150 cursor-pointer opacity-80 hover:opacity-100"
          @click.stop="close"
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
              :disabled="creating || c.isPersonal"
              class="peer sr-only"
            />
            <span
              class="h-5 w-5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer"
              :class="
                creating || c.isPersonal
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
        </div>
      </div>

      <div class="space-y-1">
        <div class="text-sm font-semibold">Search query</div>
        <input
          ref="inputRef"
          v-model="query"
          type="text"
          class="w-full p-2 border border-(--sub-color) rounded-lg"
          placeholder="e.g. Dungeon Crawler Carl, 9780593820247"
          :disabled="creating"
          @keydown="onEnter"
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

      <div v-if="errorMessage" class="text-sm text-red-400">
        {{ errorMessage }}
      </div>
      <div v-else-if="successMessage" class="text-sm text-green-400">
        {{ successMessage }}
      </div>

      <div class="flex gap-2">
        <button
          type="button"
          class="flex-1 border border-(--sub-color) p-2 rounded-md hover:bg-(--main-color)/10 transition"
          :disabled="creating"
          @click="close"
        >
          Cancel
        </button>

        <button
          type="button"
          class="flex-1 border border-(--sub-color) p-2 rounded-md bg-(--main-color)/20 hover:bg-(--main-color)/30 transition"
          :disabled="creating || !query.trim() || !selectedCollectionIds.length"
          @click="createFromMetadata"
        >
          <span v-if="creating">Adding…</span>
          <span v-else>Add top result</span>
        </button>
      </div>
    </div>
  </ModalWindow>
</template>
