<script setup lang="ts">
import {
  bookFieldDefinition,
  type BookFieldId,
  type BookViewMode,
} from '~/utils/bookFields';
const props = defineProps<{ mode: BookViewMode }>();
const { fields, setVisible, move } = useBookViewFields(props.mode);
const dragged = ref<BookFieldId | null>(null);
const announcement = ref('');
function moveTo(id: BookFieldId, target: BookFieldId) {
  move(id, target);
  announcement.value = `${bookFieldDefinition(id).label} moved to position ${fields.value.findIndex((f) => f.id === id) + 1}`;
}
function moveBy(id: BookFieldId, offset: number) {
  const index = fields.value.findIndex((f) => f.id === id);
  const target = fields.value[index + offset];
  if (target) moveTo(id, target.id);
}
function drop(id: BookFieldId) {
  if (dragged.value) moveTo(dragged.value, id);
  dragged.value = null;
}
function startDrag(event: DragEvent, id: BookFieldId) {
  dragged.value = id;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  }
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="text-xs opacity-70 mb-1">
      Choose fields and their order. Changes save automatically.
    </div>
    <div
      v-for="(field, index) in fields"
      :key="field.id"
      class="flex items-center gap-2 py-1 rounded hover:bg-(--sub-color)/10"
      @dragover.prevent
      @drop.prevent="drop(field.id)"
    >
      <span
        draggable="true"
        class="cursor-grab opacity-60 shrink-0"
        aria-hidden="true"
        @dragstart="startDrag($event, field.id)"
        @dragend="dragged = null"
      >
        <Icon name="lucide:grip-vertical" />
      </span>
      <label
        class="flex items-center gap-2 flex-1 cursor-pointer min-w-0 text-sm"
      >
        <input
          type="checkbox"
          class="accent-(--main-color)"
          :checked="field.visible"
          @change="setVisible(field.id, !field.visible)"
        />
        {{ bookFieldDefinition(field.id).label }}
      </label>
      <button
        type="button"
        class="p-1 disabled:opacity-25"
        :disabled="index === 0"
        :aria-label="`Move ${bookFieldDefinition(field.id).label} up`"
        @click="moveBy(field.id, -1)"
      >
        <Icon name="lucide:chevron-up" />
      </button>
      <button
        type="button"
        class="p-1 disabled:opacity-25"
        :disabled="index === fields.length - 1"
        :aria-label="`Move ${bookFieldDefinition(field.id).label} down`"
        @click="moveBy(field.id, 1)"
      >
        <Icon name="lucide:chevron-down" />
      </button>
    </div>
    <div aria-live="polite" class="sr-only">{{ announcement }}</div>
  </div>
</template>
