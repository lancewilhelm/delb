<script setup lang="ts">
import EditCollectionModal from '~/components/Collections/EditCollectionModal.vue';

defineOptions({ name: 'CollectionPickerDropdown' });

const collectionsStore = useCollectionsStore();

const open = ref(false);
const anchorRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);

const createModalOpen = ref(false);
const creating = ref(false);
const createError = ref<string | null>(null);
const newCollectionName = ref('');

const editModalOpen = ref(false);
const editingCollectionId = ref<string | null>(null);

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

const activeLabel = computed(() => {
  if (collectionsStore.activeSelection.kind === 'all') return 'All';
  return collectionsStore.activeCollection?.name ?? 'Collection';
});

const editingCollection = computed(() => {
  const id = editingCollectionId.value;
  if (!id) return null;
  return collectionsStore.collections.find((c) => c.id === id) ?? null;
});

function closeDropdown() {
  open.value = false;
}

function toggleDropdown() {
  open.value = !open.value;
}

function openCreateModal() {
  createError.value = null;
  newCollectionName.value = '';
  createModalOpen.value = true;
}

function closeCreateModal() {
  createModalOpen.value = false;
  createError.value = null;
  newCollectionName.value = '';
  creating.value = false;
}

async function createCollection() {
  if (creating.value) return;

  const name = newCollectionName.value.trim();
  if (!name) {
    createError.value = 'Collection name is required.';
    return;
  }

  creating.value = true;
  createError.value = null;

  try {
    await $fetch('/api/collections', {
      method: 'POST',
      body: { name },
    });

    await collectionsStore.fetchCollections();

    const created = collectionsStore.collections.find((c) => c.name === name);
    if (created) {
      collectionsStore.setActiveCollection(created.id);
    }

    closeCreateModal();
    closeDropdown();
  } catch (err: unknown) {
    const e = err as FetchErrorLike;
    createError.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to create collection.';
  } finally {
    creating.value = false;
  }
}

function openEditModal(collectionId: string) {
  const c = collectionsStore.collections.find((x) => x.id === collectionId);
  if (!c) return;

  if (!collectionsStore.canEditCollection(c)) return;

  editingCollectionId.value = collectionId;
  editModalOpen.value = true;
}

function closeEditModal() {
  editModalOpen.value = false;
  editingCollectionId.value = null;
}

function selectAll() {
  collectionsStore.setActiveAll();
  closeDropdown();
}

function selectCollection(id: string) {
  collectionsStore.setActiveCollection(id);
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
  if (e.key === 'Escape') closeDropdown();
}

watch(
  () => open.value,
  async (isOpen) => {
    if (isOpen) {
      // Ensure list is fresh when opening.
      await collectionsStore.fetchCollections();
    }
  },
);

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeyDown);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointerDown);
  document.removeEventListener('keydown', onDocumentKeyDown);
});
</script>

<template>
  <div class="relative">
    <!-- Trigger -->
    <button
      ref="anchorRef"
      v-tooltip="'Switch collection'"
      class="sm:pl-1 flex items-center gap-2 px-1"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="toggleDropdown"
    >
      <Icon
        :name="activeLabel === 'All' ? 'lucide:library-big' : 'lucide:folder'"
        class="text-(--main-color) opacity-80 shrink-0"
      />
      <span class="max-w-48 truncate text-sm opacity-80">{{
        activeLabel
      }}</span>
      <Icon
        name="lucide:chevron-down"
        class="text-(--main-color) opacity-80 shrink-0"
      />
    </button>

    <!-- Panel -->
    <div
      v-if="open"
      ref="panelRef"
      class="absolute left-0 mt-2 w-72 border border-(--sub-color) bg-(--bg-color) rounded-md shadow-lg z-50 overflow-hidden"
      role="menu"
    >
      <div class="px-3 py-2 border-b border-(--sub-color)">
        <div class="text-md opacity-70">Collection</div>
      </div>

      <div class="max-h-80 overflow-auto">
        <button
          v-tooltip="'Show items from all collections you can access'"
          class="w-full px-3 py-2 text-left flex justify-start! gap-2 rounded-none!"
          :class="
            collectionsStore.activeSelection.kind === 'all'
              ? 'bg-(--sub-color)/40'
              : ''
          "
          role="menuitem"
          @click="selectAll"
        >
          <Icon
            name="lucide:library-big"
            class="text-(--main-color) opacity-80 shrink-0"
          />
          <span class="truncate">All</span>
        </button>

        <div class="h-px bg-(--sub-color) opacity-60" />

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
          class="w-full px-3 py-2 text-left flex justify-between! gap-3 rounded-none!"
          :class="
            collectionsStore.activeSelection.kind === 'collection' &&
            collectionsStore.activeSelection.collectionId === c.id
              ? 'bg-(--sub-color)/40'
              : ''
          "
          role="menuitem"
          @click="selectCollection(c.id)"
        >
          <div class="flex items-center gap-2 min-w-0">
            <Icon
              name="lucide:folder"
              class="text-(--main-color) opacity-80 shrink-0"
            />
            <span class="truncate">{{ c.name }}</span>
            <span
              v-if="c.isPersonal"
              class="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-(--sub-color) opacity-70 shrink-0"
            >
              Personal
            </span>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            <button
              v-if="collectionsStore.canEditCollection(c)"
              v-tooltip="'Edit collection'"
              class="p-1 opacity-80 hover:opacity-100"
              type="button"
              @click.stop="
                () => {
                  closeDropdown();
                  openEditModal(c.id);
                }
              "
            >
              <Icon name="lucide:pencil" class="text-(--main-color)" />
            </button>

            <span class="text-[11px] opacity-60 shrink-0">{{ c.role }}</span>
          </div>
        </button>

        <p
          v-if="collectionsStore.errorMessage"
          class="px-3 py-2 text-sm text-red-600"
        >
          {{ collectionsStore.errorMessage }}
        </p>
      </div>

      <div class="border-t border-(--sub-color) p-2">
        <button
          v-tooltip="'Create a new collection'"
          class="w-full px-3 py-2 border border-(--sub-color) flex items-center justify-center gap-2"
          role="menuitem"
          @click="
            () => {
              closeDropdown();
              openCreateModal();
            }
          "
        >
          <Icon name="lucide:plus" class="text-(--main-color)" />
          <span>Create collection</span>
        </button>
      </div>
    </div>

    <!-- Create modal -->
    <ModalWindow :open="createModalOpen" @close="closeCreateModal">
      <div class="flex flex-col gap-3 w-90 max-w-[80vw]">
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="text-lg font-semibold">Create collection</div>
            <div class="text-sm opacity-80">
              Give your new collection a name.
            </div>
          </div>

          <Icon
            v-tooltip="'Close'"
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
            v-tooltip="'Cancel'"
            class="px-3 py-2"
            :disabled="creating"
            @click="closeCreateModal"
          >
            Cancel
          </button>

          <button
            v-tooltip="'Create this collection'"
            class="px-3 py-2 bg-(--main-color) text-(--bg-color)"
            :disabled="creating || !newCollectionName.trim()"
            @click="createCollection"
          >
            {{ creating ? 'Creating…' : 'Create' }}
          </button>
        </div>
      </div>
    </ModalWindow>

    <EditCollectionModal
      :open="editModalOpen"
      :collection="editingCollection"
      @close="closeEditModal"
      @saved="
        () => {
          // no-op for now; the modal refreshes the store on save
        }
      "
    />
  </div>
</template>
