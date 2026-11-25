<script setup lang="ts">
import { $fetch } from '~/utils/apiFetch';
import { extractFetchErrorMessage } from '~/utils/responseError';
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

type Note = {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
};

const props = defineProps<{ bookId: string }>();

const notes = ref<Note[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const adding = ref(false);
const newText = ref('');
const editingId = ref<string | null>(null);
const editText = ref('');
const newInput = ref<HTMLTextAreaElement | null>(null);
let controller: AbortController | null = null;

const base = () => `/api/books/${encodeURIComponent(props.bookId)}/notes`;

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString();
}

async function load() {
  loading.value = true;
  error.value = '';
  controller = new AbortController();
  try {
    const response = await $fetch<{ data: Note[] }>(base(), {
      signal: controller.signal,
    });
    notes.value = response.data;
  } catch {
    if (!controller.signal.aborted)
      error.value = 'Could not load your notes. Try again.';
  } finally {
    loading.value = false;
  }
}

async function startAdd() {
  adding.value = true;
  newText.value = '';
  error.value = '';
  await nextTick();
  newInput.value?.focus();
}

async function add() {
  if (busy.value || !newText.value.trim()) return;
  busy.value = true;
  error.value = '';
  try {
    const response = await $fetch<{ data: Note }>(base(), {
      method: 'POST',
      body: { text: newText.value },
    });
    notes.value.push(response.data);
    adding.value = false;
    newText.value = '';
  } catch (err) {
    error.value =
      extractFetchErrorMessage(err) ??
      'Could not save the note. Your draft is kept.';
  } finally {
    busy.value = false;
  }
}

function startEdit(note: Note) {
  editingId.value = note.id;
  editText.value = note.text;
  error.value = '';
}

async function saveEdit(note: Note) {
  if (busy.value || !editText.value.trim()) return;
  busy.value = true;
  error.value = '';
  try {
    const response = await $fetch<{ data: Note }>(
      `${base()}/${encodeURIComponent(note.id)}`,
      { method: 'PUT', body: { text: editText.value } },
    );
    Object.assign(note, response.data);
    editingId.value = null;
  } catch (err) {
    error.value =
      extractFetchErrorMessage(err) ??
      'Could not save the note. Your draft is kept.';
  } finally {
    busy.value = false;
  }
}

async function remove(note: Note) {
  if (busy.value || !confirm('Delete this note?')) return;
  busy.value = true;
  error.value = '';
  try {
    await $fetch(`${base()}/${encodeURIComponent(note.id)}`, {
      method: 'DELETE',
    });
    notes.value = notes.value.filter((n) => n.id !== note.id);
  } catch {
    error.value = 'Could not delete the note.';
  } finally {
    busy.value = false;
  }
}

onMounted(load);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <div class="grid grid-cols-[110px_1fr] gap-2 text-sm">
    <div class="opacity-70 mt-1">Notes</div>
    <div class="min-w-0 flex flex-col gap-2">
      <p v-if="loading" role="status" class="opacity-70 mt-1">
        Loading notes...
      </p>
      <template v-else>
        <div
          v-for="note in notes"
          :key="note.id"
          class="flex flex-col gap-1 border-l-2 border-(--contrast-border-color) pl-2"
        >
          <form
            v-if="editingId === note.id"
            class="flex flex-col gap-2"
            @submit.prevent="saveEdit(note)"
          >
            <textarea
              v-model="editText"
              aria-label="Edit note"
              maxlength="10000"
              rows="3"
              class="w-full p-2 rounded-md border border-(--contrast-border-color) bg-(--bg-color) text-(--contrast-text-color) resize-y"
              :disabled="busy"
              @keydown.esc.prevent="!busy && (editingId = null)"
              @keydown.ctrl.enter.prevent="saveEdit(note)"
              @keydown.meta.enter.prevent="saveEdit(note)"
            />
            <div class="flex gap-2">
              <button
                type="submit"
                class="px-3 py-1 border border-(--contrast-border-color) rounded-md"
                :disabled="busy || !editText.trim()"
              >
                Save
              </button>
              <button
                type="button"
                class="px-3 py-1"
                :disabled="busy"
                @click="editingId = null"
              >
                Cancel
              </button>
            </div>
          </form>
          <template v-else>
            <div class="whitespace-pre-wrap wrap-anywhere">{{ note.text }}</div>
            <div class="flex gap-3 text-xs opacity-60">
              <span>{{ formatDate(note.createdAt) }}</span>
              <button
                type="button"
                class="underline hover:opacity-100"
                :disabled="busy"
                @click="startEdit(note)"
              >
                Edit
              </button>
              <button
                type="button"
                class="underline hover:opacity-100"
                :disabled="busy"
                @click="remove(note)"
              >
                Delete
              </button>
            </div>
          </template>
        </div>

        <form v-if="adding" class="flex flex-col gap-2" @submit.prevent="add">
          <textarea
            ref="newInput"
            v-model="newText"
            aria-label="New note"
            maxlength="10000"
            rows="3"
            class="w-full p-2 rounded-md border border-(--contrast-border-color) bg-(--bg-color) text-(--contrast-text-color) resize-y"
            :disabled="busy"
            @keydown.esc.prevent="!busy && (adding = false)"
            @keydown.ctrl.enter.prevent="add"
            @keydown.meta.enter.prevent="add"
          />
          <div class="flex gap-2 items-center">
            <button
              type="submit"
              class="px-3 py-1 border border-(--contrast-border-color) rounded-md"
              :disabled="busy || !newText.trim()"
            >
              {{ busy ? 'Saving...' : 'Add note' }}
            </button>
            <button
              type="button"
              class="px-3 py-1"
              :disabled="busy"
              @click="adding = false"
            >
              Cancel
            </button>
            <span class="text-xs opacity-60">Only you can see your notes.</span>
          </div>
        </form>
        <button
          v-else-if="!error || notes.length"
          type="button"
          class="text-left! justify-start! self-start p-1 rounded-md hover:bg-(--sub-color)/10 opacity-60 italic"
          @click="startAdd"
        >
          <Icon name="lucide:plus" class="shrink-0 mr-1 opacity-70" />
          Add a private note
        </button>
      </template>
      <p v-if="error" role="alert" class="text-(--contrast-error-color)">
        {{ error }}
      </p>
      <button
        v-if="error && !loading && !notes.length && !adding"
        type="button"
        class="self-start px-2 py-1 border border-(--contrast-border-color) rounded-md"
        @click="load"
      >
        Retry
      </button>
    </div>
  </div>
</template>
