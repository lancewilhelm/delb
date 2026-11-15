<script setup lang="ts">
definePageMeta({ auth: { only: 'user', redirectGuestTo: '/login' } });
useHead({ title: 'Shelves' });
type Shelf = {
  id: string;
  name: string;
  count: number;
  previews: { id: string; title: string }[];
};
const shelves = ref<Shelf[]>([]);
const loading = ref(true);
const error = ref('');
const creating = ref(false);
const name = ref('');
const busy = ref(false);
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const response = await $fetch<{ data: { shelves: Shelf[] } }>(
      '/api/shelves',
    );
    shelves.value = response.data.shelves;
  } catch {
    error.value = 'Could not load your Shelves.';
  } finally {
    loading.value = false;
  }
}
async function create() {
  if (!name.value.trim() || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const response = await $fetch<{ data: { id: string } }>('/api/shelves', {
      method: 'POST',
      body: { name: name.value },
    });
    await navigateTo(`/shelves/${encodeURIComponent(response.data.id)}`);
  } catch {
    error.value = 'Could not create the Shelf. Try again.';
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />
    <div class="p-2 border-b border-(--contrast-border-color)">
      <ViewSelectorDropdown />
    </div>
    <main class="flex-1 min-h-0 overflow-auto p-4 sm:p-6">
      <div class="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 class="text-2xl font-semibold">My Shelves</h1>
          <p class="opacity-70 mt-1">
            Personal groups of books from your library.
          </p>
        </div>
        <button
          type="button"
          class="px-3 py-2 border rounded"
          @click="creating = true"
        >
          <Icon name="lucide:plus" /> Create Shelf
        </button>
      </div>
      <p v-if="loading" role="status">Loading your Shelves…</p>
      <p v-if="error" role="alert" class="mb-3">{{ error }}</p>
      <div v-if="!loading && !shelves.length" class="py-8">
        <p>You haven't made any Shelves yet.</p>
        <p class="opacity-70 mt-1">
          Create one to collect books from across your library.
        </p>
      </div>
      <div
        v-else
        class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4"
      >
        <NuxtLink
          v-for="shelf in shelves"
          :key="shelf.id"
          :to="`/shelves/${encodeURIComponent(shelf.id)}`"
          class="block border border-(--contrast-border-color) rounded-lg p-4 hover:bg-(--sub-color)/10"
        >
          <div class="flex gap-1 h-28 items-end mb-3">
            <BookCover
              v-for="book in shelf.previews"
              :key="book.id"
              :src="`/api/books/${encodeURIComponent(book.id)}/cover?variant=thumb`"
              :title="book.title"
              :alt="`Cover for ${book.title}`"
              class="w-12 h-20"
            /><Icon
              v-if="!shelf.previews.length"
              name="lucide:book-open"
              class="text-4xl opacity-40"
            />
          </div>
          <h2 class="font-semibold truncate">{{ shelf.name }}</h2>
          <p class="text-sm opacity-70">
            {{ shelf.count }} {{ shelf.count === 1 ? 'book' : 'books' }}
          </p>
        </NuxtLink>
      </div>
    </main>
    <ModalWindow :open="creating" @close="creating = false"
      ><form
        class="flex flex-col gap-3 w-80 max-w-full"
        @submit.prevent="create"
      >
        <h2 class="text-xl font-semibold">Create Shelf</h2>
        <label
          >Name
          <input
            v-model="name"
            maxlength="120"
            required
            autofocus
            class="block w-full p-2 border rounded mt-1"
        /></label>
        <p v-if="error" role="alert">{{ error }}</p>
        <div class="flex justify-end gap-3">
          <button type="button" @click="creating = false">Cancel</button
          ><button
            type="submit"
            class="px-3 py-2 border rounded"
            :disabled="busy || !name.trim()"
          >
            Create
          </button>
        </div>
      </form></ModalWindow
    >
  </div>
</template>
