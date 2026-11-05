<script setup lang="ts">
const props = defineProps<{ bookId: string; rationale?: string }>();
const emit = defineEmits<{ saved: [value: string] }>();
const saved = ref(props.rationale ?? '');
const draft = ref('');
const editing = ref(false);
const loading = ref(props.rationale === undefined);
const saving = ref(false);
const error = ref('');
const input = ref<HTMLTextAreaElement | null>(null);
let controller: AbortController | null = null;

watch(
  () => props.rationale,
  (value) => {
    if (value !== undefined) saved.value = value;
  },
);

async function load() {
  if (props.rationale !== undefined) return;
  loading.value = true;
  error.value = '';
  controller = new AbortController();
  try {
    const response = await $fetch<{ data: { rationale: string } }>(
      `/api/books/${encodeURIComponent(props.bookId)}/rationale`,
      { signal: controller.signal },
    );
    saved.value = response.data.rationale;
  } catch {
    if (!controller.signal.aborted)
      error.value = 'Could not load your rationale. Try again.';
  } finally {
    loading.value = false;
  }
}

async function edit() {
  draft.value = saved.value;
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
    const response = await $fetch<{ data: { rationale: string } }>(
      `/api/books/${encodeURIComponent(props.bookId)}/rationale`,
      {
        method: 'PUT',
        body: { rationale: draft.value },
        signal: controller.signal,
      },
    );
    saved.value = response.data.rationale;
    emit('saved', saved.value);
    editing.value = false;
  } catch {
    if (!controller.signal.aborted)
      error.value =
        'Could not save your rationale. Your draft is kept. Try again.';
  } finally {
    saving.value = false;
  }
}

onMounted(load);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <div class="min-w-0 text-sm">
    <div class="text-xs uppercase tracking-wide opacity-60 mb-1">
      Your TBR rationale
    </div>
    <p v-if="loading" role="status" class="opacity-70">Loading rationale...</p>
    <form
      v-else-if="editing"
      class="flex flex-col gap-2"
      @submit.prevent="save"
    >
      <textarea
        ref="input"
        v-model="draft"
        aria-label="Your TBR rationale"
        maxlength="10000"
        rows="3"
        class="w-full p-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-(--text-color) resize-y"
        :disabled="saving"
        @keydown.esc.prevent="!saving && cancel()"
        @keydown.ctrl.enter.prevent="save"
        @keydown.meta.enter.prevent="save"
      />
      <div class="flex gap-2 items-center">
        <button
          type="submit"
          class="px-3 py-1 border border-(--sub-color) rounded-md"
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
      </div>
    </form>
    <button
      v-else-if="!error"
      type="button"
      class="text-left! justify-start! w-full whitespace-pre-wrap wrap-anywhere p-2 rounded-md hover:bg-(--sub-color)/10"
      :aria-label="saved ? 'Edit your TBR rationale' : 'Add rationale'"
      @click="edit"
    >
      <span :class="saved ? '' : 'opacity-60 italic'">{{
        saved || 'Add rationale'
      }}</span>
      <Icon name="lucide:pencil" class="shrink-0 ml-2 opacity-50" />
    </button>
    <p v-if="error" role="alert" class="text-(--error-color) mt-2">
      {{ error }}
    </p>
    <button
      v-if="error && !editing && !loading"
      type="button"
      class="mt-1 px-2 py-1 border border-(--sub-color) rounded-md"
      @click="load"
    >
      Retry
    </button>
  </div>
</template>
