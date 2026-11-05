<script setup lang="ts">
const props = defineProps<{
  bookId: string;
  title: string;
  favorite: boolean;
}>();
const emit = defineEmits<{ updated: [favorite: boolean] }>();
const saving = ref(false);
const errorMessage = ref('');
const controller = new AbortController();
const label = computed(
  () =>
    `${props.favorite ? 'Remove' : 'Add'} ${props.title} ${props.favorite ? 'from' : 'to'} favorites`,
);

async function toggleFavorite() {
  if (saving.value) return;
  saving.value = true;
  errorMessage.value = '';
  try {
    const result = await $fetch<{
      success: true;
      data: { userFavorite: boolean };
    }>(`/api/books/${encodeURIComponent(props.bookId)}/favorite`, {
      method: 'PUT',
      body: { favorite: !props.favorite },
      signal: controller.signal,
    });
    if (!controller.signal.aborted) emit('updated', result.data.userFavorite);
  } catch {
    if (!controller.signal.aborted)
      errorMessage.value = 'Could not save favorite. Try again.';
  } finally {
    saving.value = false;
  }
}
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <span class="favorite-control">
    <button
      v-tooltip="label"
      type="button"
      :aria-label="label"
      :aria-pressed="favorite"
      :aria-busy="saving"
      :disabled="saving"
      @click.stop="toggleFavorite"
    >
      <Icon name="lucide:star" :class="{ 'fill-current': favorite }" />
    </button>
    <span v-if="errorMessage" class="favorite-error" role="alert">{{
      errorMessage
    }}</span>
  </span>
</template>

<style scoped>
.favorite-control {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
}
.favorite-control button {
  background: transparent;
  color: var(--main-color);
  border: 0;
  padding: 3px;
  line-height: 1;
  opacity: 0.65;
}
.favorite-control button[aria-pressed='true'],
.favorite-control button:hover {
  opacity: 1;
}
.favorite-control button:disabled {
  cursor: wait;
  opacity: 0.4;
}
.favorite-control button:focus-visible {
  outline: 2px solid var(--main-color);
  outline-offset: 3px;
}
.favorite-error {
  color: var(--error-color);
  font-size: 11px;
  line-height: 1.4;
  max-width: 160px;
}
</style>
