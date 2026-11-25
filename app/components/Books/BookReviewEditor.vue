<script setup lang="ts">
import { $fetch } from '~/utils/apiFetch';
import { extractFetchErrorMessage } from '~/utils/responseError';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

type Review = {
  text: string;
  containsSpoilers: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

const props = defineProps<{ bookId: string }>();

const review = ref<Review>({
  text: '',
  containsSpoilers: false,
  createdAt: null,
  updatedAt: null,
});
const draft = ref('');
const draftSpoilers = ref(false);
const editing = ref(false);
const loading = ref(true);
const saving = ref(false);
const revealed = ref(false);
const error = ref('');
const input = ref<HTMLTextAreaElement | null>(null);
let controller: AbortController | null = null;

const updatedLabel = computed(() => {
  if (!review.value.updatedAt) return '';
  return new Date(review.value.updatedAt).toLocaleDateString();
});

async function load() {
  loading.value = true;
  error.value = '';
  controller = new AbortController();
  try {
    const response = await $fetch<{ data: Review }>(
      `/api/books/${encodeURIComponent(props.bookId)}/review`,
      { signal: controller.signal },
    );
    review.value = response.data;
  } catch {
    if (!controller.signal.aborted)
      error.value = 'Could not load your review. Try again.';
  } finally {
    loading.value = false;
  }
}

async function edit() {
  draft.value = review.value.text;
  draftSpoilers.value = review.value.containsSpoilers;
  editing.value = true;
  error.value = '';
  await nextTick();
  input.value?.focus();
}

function cancel() {
  editing.value = false;
  error.value = '';
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  controller = new AbortController();
  try {
    const response = await $fetch<{ data: Review }>(
      `/api/books/${encodeURIComponent(props.bookId)}/review`,
      {
        method: 'PUT',
        body: { text: draft.value, containsSpoilers: draftSpoilers.value },
        signal: controller.signal,
      },
    );
    review.value = response.data;
    revealed.value = true;
    editing.value = false;
  } catch (err) {
    if (!controller.signal.aborted)
      error.value =
        extractFetchErrorMessage(err) ??
        'Could not save your review. Your draft is kept. Try again.';
  } finally {
    saving.value = false;
  }
}

onMounted(load);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <div class="grid grid-cols-[110px_1fr] gap-2 text-sm">
    <div class="opacity-70 mt-1">Review</div>
    <div class="min-w-0">
      <p v-if="loading" role="status" class="opacity-70 mt-1">
        Loading review...
      </p>
      <form
        v-else-if="editing"
        class="flex flex-col gap-2"
        @submit.prevent="save"
      >
        <textarea
          ref="input"
          v-model="draft"
          aria-label="Your review"
          maxlength="50000"
          rows="6"
          class="w-full p-2 rounded-md border border-(--contrast-border-color) bg-(--bg-color) text-(--contrast-text-color) resize-y"
          :disabled="saving"
          @keydown.esc.prevent="!saving && cancel()"
          @keydown.ctrl.enter.prevent="save"
          @keydown.meta.enter.prevent="save"
        />
        <label class="flex items-center gap-2">
          <input
            v-model="draftSpoilers"
            type="checkbox"
            class="accent-(--main-color)"
            :disabled="saving"
          />
          Contains spoilers
        </label>
        <div class="flex gap-2 items-center">
          <button
            type="submit"
            class="px-3 py-1 border border-(--contrast-border-color) rounded-md"
            :disabled="saving"
          >
            {{ saving ? 'Saving...' : error ? 'Retry save' : 'Save' }}
          </button>
          <button
            type="button"
            class="px-3 py-1"
            :disabled="saving"
            @click="cancel"
          >
            Cancel
          </button>
          <span class="text-xs opacity-60">Only you can see your review.</span>
        </div>
      </form>
      <template v-else-if="!error">
        <button
          v-if="!review.text"
          type="button"
          class="text-left! justify-start! w-full p-1 rounded-md hover:bg-(--sub-color)/10 opacity-60 italic"
          @click="edit"
        >
          Write a review
          <Icon name="lucide:pencil" class="shrink-0 ml-2 opacity-50" />
        </button>
        <div v-else class="flex flex-col gap-1">
          <button
            v-if="review.containsSpoilers && !revealed"
            type="button"
            class="self-start flex items-center gap-2 px-2 py-1 rounded-md border border-(--contrast-border-color) hover:bg-(--sub-color)/10"
            @click="revealed = true"
          >
            <Icon name="lucide:eye-off" class="opacity-70" />
            Show review with spoilers
          </button>
          <button
            v-else
            type="button"
            class="text-left! justify-start! w-full whitespace-pre-wrap wrap-anywhere p-1 rounded-md hover:bg-(--sub-color)/10"
            aria-label="Edit your review"
            @click="edit"
          >
            <span>{{ review.text }}</span>
            <Icon name="lucide:pencil" class="shrink-0 ml-2 opacity-50" />
          </button>
          <div class="text-xs opacity-60 px-1">
            <span v-if="review.containsSpoilers">Contains spoilers · </span>
            <span v-if="updatedLabel">Updated {{ updatedLabel }}</span>
          </div>
        </div>
      </template>
      <p v-if="error" role="alert" class="text-(--contrast-error-color) mt-1">
        {{ error }}
      </p>
      <button
        v-if="error && !editing && !loading"
        type="button"
        class="mt-1 px-2 py-1 border border-(--contrast-border-color) rounded-md"
        @click="load"
      >
        Retry
      </button>
    </div>
  </div>
</template>
