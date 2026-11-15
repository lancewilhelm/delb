<script setup lang="ts">
import BookshelfView from '~/components/Books/BookshelfView.vue';
definePageMeta({ auth: { only: 'user', redirectGuestTo: '/login' } });
useHead({ title: 'Shelf' });
const route = useRoute();
const id = computed(() => String(route.params.id));
type Shelf = { id: string; name: string; books: { id: string }[] };
const shelf = ref<Shelf | null>(null);
const loading = ref(true);
const error = ref('');
const mode = ref<'grid' | 'list' | 'bookshelf'>('grid');
const picker = ref<'add' | 'remove' | null>(null);
const viewKey = ref(0);
const visual = ref<InstanceType<typeof BookshelfView> | null>(null);
const endpoint = computed(
  () => `/api/books?shelfId=${encodeURIComponent(id.value)}`,
);
const editingName = ref(false);
const name = ref('');
async function load() {
  loading.value = true;
  error.value = '';
  try {
    shelf.value = await $fetch<Shelf>(
      `/api/shelves/${encodeURIComponent(id.value)}`,
    );
    name.value = shelf.value.name;
  } catch {
    error.value = 'Could not load this Shelf.';
  } finally {
    loading.value = false;
  }
}
async function updated() {
  await load();
  viewKey.value++;
}
async function rename() {
  if (!name.value.trim()) return;
  try {
    await $fetch(`/api/shelves/${encodeURIComponent(id.value)}`, {
      method: 'PATCH',
      body: { name: name.value },
    });
    editingName.value = false;
    await load();
  } catch {
    error.value = 'Could not rename this Shelf.';
  }
}
async function removeShelf() {
  if (!confirm('Delete this Shelf? The books will stay in their collections.'))
    return;
  try {
    await $fetch(`/api/shelves/${encodeURIComponent(id.value)}`, {
      method: 'DELETE',
    });
    await navigateTo('/shelves');
  } catch {
    error.value = 'Could not delete this Shelf.';
  }
}
function switchMode(next: typeof mode.value) {
  if (mode.value === 'bookshelf' && visual.value && !visual.value.canLeave())
    return;
  mode.value = next;
}
function openPicker(next: 'add' | 'remove') {
  if (mode.value === 'bookshelf' && visual.value && !visual.value.canLeave())
    return;
  picker.value = next;
}
onMounted(load);
</script>
<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />
    <div class="p-2 border-b border-(--contrast-border-color)">
      <ViewSelectorDropdown />
    </div>
    <div v-if="loading" class="p-5" role="status">Loading Shelf…</div>
    <div v-else-if="!shelf" class="p-5" role="alert">
      {{ error }}
      <NuxtLink to="/shelves" class="underline">Back to Shelves</NuxtLink>
    </div>
    <template v-else>
      <div
        class="p-3 border-b border-(--contrast-border-color) flex flex-wrap gap-3 items-center"
      >
        <NuxtLink to="/shelves" aria-label="Back to Shelves"
          ><Icon name="lucide:arrow-left"
        /></NuxtLink>
        <form v-if="editingName" class="flex gap-2" @submit.prevent="rename">
          <input
            v-model="name"
            maxlength="120"
            class="p-1 border rounded"
            aria-label="Shelf name"
          /><button type="submit">Save</button
          ><button type="button" @click="editingName = false">Cancel</button>
        </form>
        <h1 v-else class="font-semibold text-xl">{{ shelf.name }}</h1>
        <details class="relative">
          <summary aria-label="Shelf options" class="cursor-pointer">
            <Icon name="lucide:ellipsis" />
          </summary>
          <div
            class="absolute z-50 min-w-40 bg-(--bg-color) border rounded p-2 flex flex-col"
          >
            <button type="button" @click="editingName = true">
              Rename Shelf</button
            ><button type="button" @click="removeShelf">Delete Shelf</button>
          </div>
        </details>
        <span class="text-sm opacity-70"
          >{{ shelf.books.length }}
          {{ shelf.books.length === 1 ? 'book' : 'books' }}</span
        >
        <div class="flex-1" />
        <button
          type="button"
          class="px-2 py-1 border rounded"
          @click="openPicker('add')"
        >
          <Icon name="lucide:plus" /> Add books
        </button>
        <button
          v-if="shelf.books.length"
          type="button"
          class="px-2 py-1 border rounded"
          @click="openPicker('remove')"
        >
          Remove books
        </button>
        <div role="group" aria-label="Shelf view" class="flex gap-1">
          <button
            v-for="view in ['grid', 'list', 'bookshelf'] as const"
            :key="view"
            type="button"
            :aria-label="`${view} view`"
            :aria-pressed="mode === view"
            class="px-2 py-1 border rounded capitalize"
            @click="switchMode(view)"
          >
            {{ view }}
          </button>
        </div>
      </div>
      <p v-if="error" role="alert" class="p-2">{{ error }}</p>
      <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
        <BooksInfiniteGrid
          v-if="mode === 'grid'"
          :key="`grid-${viewKey}`"
          :endpoint="endpoint"
          :selection-enabled="false"
          empty-message="This Shelf is empty. Add books to get started."
          class="flex-1 min-h-0"
          @error="error = $event"
        />
        <BooksInfiniteList
          v-else-if="mode === 'list'"
          :key="`list-${viewKey}`"
          :endpoint="endpoint"
          :selection-enabled="false"
          empty-message="This Shelf is empty. Add books to get started."
          class="flex-1 min-h-0"
          @error="error = $event"
        />
        <BookshelfView
          v-else
          :key="`visual-${viewKey}`"
          ref="visual"
          :endpoint="endpoint"
          :personal-shelf-id="id"
        />
      </div>
      <ShelvesBookPicker
        :open="picker !== null"
        :mode="picker || 'add'"
        :existing="shelf.books.map((b) => b.id)"
        :shelf-id="id"
        @close="picker = null"
        @added="updated"
      />
    </template>
  </div>
</template>
