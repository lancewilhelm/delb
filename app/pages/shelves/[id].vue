<script setup lang="ts">
import BooksLibraryView from '~/components/Books/LibraryView.vue';
definePageMeta({ auth: { only: 'user', redirectGuestTo: '/login' } });
const route = useRoute();
const id = computed(() => String(route.params.id));
type Shelf = { id: string; name: string; books: { id: string }[] };
const shelf = ref<Shelf | null>(null);
const loading = ref(true);
const error = ref('');
const picker = ref<'add' | 'remove' | null>(null);
const library = ref<InstanceType<typeof BooksLibraryView> | null>(null);
const editingName = ref(false);
const name = ref('');
async function load() {
  if (!shelf.value) loading.value = true;
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
  library.value?.refreshBooksGrid();
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
  if (library.value && !library.value.canLeave()) return;
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
function openPicker(next: 'add' | 'remove') {
  if (library.value && !library.value.canLeave()) return;
  picker.value = next;
}
onMounted(load);
</script>
<template>
  <div v-if="loading" class="p-5" role="status">Loading Shelf…</div>
  <div v-else-if="!shelf" class="p-5" role="alert">
    {{ error }}
    <NuxtLink to="/shelves" class="underline">Back to Shelves</NuxtLink>
  </div>
  <BooksLibraryView v-else ref="library" :shelf-id="id">
    <template #scope>
      <div
        class="px-3 py-2 border-b border-(--contrast-border-color) flex flex-wrap gap-3 items-center"
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
      </div>
      <p v-if="error" role="alert" class="p-2">{{ error }}</p>
      <ShelvesBookPicker
        :open="picker !== null"
        :mode="picker || 'add'"
        :existing="shelf.books.map((b) => b.id)"
        :shelf-id="id"
        @close="picker = null"
        @added="updated"
      />
    </template>
  </BooksLibraryView>
</template>
