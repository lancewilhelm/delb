<script setup lang="ts">
import { useHead } from '~/composables/useHead';
import { useUserSettingsStore } from '~/stores/userSettings';
import { $fetch } from '~/utils/apiFetch';
import { BROWSE_CARD_PREVIEWS } from '~/utils/browseCards';
import type { CardArtStyle } from '~/utils/dashboardArt';
import type { DashboardShelfSummary } from '~/utils/dashboardCache';
import { navigateTo } from '~/utils/navigation';
import { computed, onMounted, ref } from 'vue';
import AppHeader from '~/components/AppHeader.vue';
import BrowseCardArtSelect from '~/components/BrowseCardArtSelect.vue';
import BrowseCardGrid from '~/components/BrowseCardGrid.vue';
import ModalWindow from '~/components/ModalWindow.vue';
import ViewSelectorDropdown from '~/components/ViewSelectorDropdown.vue';
useHead({ title: 'Shelves' });
const cardArt = useUserSettingsStore().settingRef<CardArtStyle>(
  'browseCardArt.shelves',
);
const shelves = ref<DashboardShelfSummary[]>([]);
const cards = computed(() =>
  shelves.value.map(({ id, name, count, previews }) => ({
    id,
    name,
    bookCount: count,
    books: previews,
  })),
);
const loading = ref(true);
const error = ref('');
const creating = ref(false);
const name = ref('');
const busy = ref(false);
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const response = await $fetch<{
      data: { shelves: DashboardShelfSummary[] };
    }>('/api/shelves', { query: { previews: BROWSE_CARD_PREVIEWS } });
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
    <div class="px-2 shrink-0 border-b border-(--contrast-border-color)">
      <div class="flex items-center justify-between gap-4">
        <ViewSelectorDropdown />
      </div>
    </div>
    <main class="w-full flex-1 min-h-0 p-4 overflow-auto">
      <div class="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1
            class="text-2xl sm:text-3xl font-serif text-(--contrast-main-color)"
          >
            Shelves
          </h1>
          <p
            v-if="!loading"
            class="text-sm italic text-(--contrast-sub-color) mt-1"
          >
            {{ shelves.length }}
            {{ shelves.length === 1 ? 'shelf' : 'shelves' }}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-4">
          <BrowseCardArtSelect v-model="cardArt" />
          <button
            type="button"
            class="p-1 flex items-center gap-2 opacity-80 hover:opacity-100"
            @click="creating = true"
          >
            <Icon name="lucide:plus" class="text-lg" />
            <span class="text-sm">Create Shelf</span>
          </button>
        </div>
      </div>
      <p v-if="loading" role="status">Loading your Shelves…</p>
      <p v-if="error" role="alert" class="mb-3">{{ error }}</p>
      <div v-if="!loading && !shelves.length" class="py-8">
        <p>You haven't made any Shelves yet.</p>
        <p class="opacity-70 mt-1">
          Create one to collect books from across your library.
        </p>
      </div>
      <BrowseCardGrid
        v-else
        page="shelves"
        :rows="cards"
        :art-style="cardArt"
      />
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
