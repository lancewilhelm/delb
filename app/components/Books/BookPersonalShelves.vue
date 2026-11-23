<script setup lang="ts">
import { $fetch } from '~/utils/apiFetch';
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
const props = defineProps<{ bookId: string }>();
type Shelf = { id: string; name: string; containsBook: boolean };
const shelves = ref<Shelf[]>([]);
const loading = ref(true);
const editing = ref(false);
const saving = ref(false);
const error = ref('');
const selected = computed(() =>
  shelves.value.filter((shelf) => shelf.containsBook),
);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    shelves.value = await $fetch<Shelf[]>(
      `/api/books/${encodeURIComponent(props.bookId)}/shelves`,
    );
  } catch {
    error.value = 'Could not load your Shelves.';
  } finally {
    loading.value = false;
  }
}
async function toggle(shelf: Shelf) {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    await $fetch(`/api/shelves/${encodeURIComponent(shelf.id)}/books`, {
      method: 'POST',
      body: {
        bookIds: [props.bookId],
        action: shelf.containsBook ? 'remove' : 'add',
      },
    });
    shelf.containsBook = !shelf.containsBook;
  } catch {
    error.value = 'Could not update this Shelf. Try again.';
  } finally {
    saving.value = false;
  }
}
onMounted(load);
</script>

<template>
  <div class="grid grid-cols-[min-content_1fr] gap-4 items-start">
    <div class="flex gap-2 items-center whitespace-nowrap">
      <div class="font-semibold">My Shelves</div>
      <button
        v-if="!loading && shelves.length"
        type="button"
        :aria-label="editing ? 'Done editing my Shelves' : 'Edit my Shelves'"
        :aria-expanded="editing"
        @click="editing = !editing"
      >
        <Icon
          :name="editing ? 'lucide:check' : 'lucide:pencil'"
          class="text-md opacity-50 hover:opacity-80"
        />
      </button>
    </div>
    <div class="min-w-0 flex flex-col items-end gap-2 text-sm">
      <span v-if="loading" role="status" class="opacity-70">Loading…</span>
      <template v-else>
        <div class="flex flex-wrap justify-end items-center gap-2">
          <RouterLink
            v-for="shelf in selected"
            :key="shelf.id"
            :to="`/shelves/${encodeURIComponent(shelf.id)}`"
            class="border border-(--contrast-border-color) px-2 py-1 rounded-md text-xs hover:bg-(--sub-color)/10"
          >
            {{ shelf.name }}
          </RouterLink>
          <span v-if="!selected.length && !error" class="opacity-70">{{
            shelves.length ? 'Not on any Shelves.' : 'No Shelves yet.'
          }}</span>
          <RouterLink
            v-if="!shelves.length && !error"
            to="/shelves"
            class="underline text-xs"
            >Create a Shelf</RouterLink
          >
        </div>
        <fieldset v-if="editing" class="w-full flex flex-col items-end gap-2">
          <legend class="sr-only">Choose your Shelves for this book</legend>
          <label
            v-for="shelf in shelves"
            :key="shelf.id"
            class="flex items-center gap-2 cursor-pointer"
          >
            <input
              type="checkbox"
              :checked="shelf.containsBook"
              :disabled="saving"
              @click.prevent="toggle(shelf)"
            />
            {{ shelf.name }}
          </label>
        </fieldset>
        <span v-if="saving" role="status" class="text-xs opacity-70"
          >Saving…</span
        >
        <div
          v-if="error"
          role="alert"
          class="text-(--contrast-error-color) text-right"
        >
          {{ error }}
          <button
            v-if="!shelves.length"
            type="button"
            class="underline"
            @click="load"
          >
            Retry
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
