<script setup lang="ts">
import HoverScrollText from '~/components/HoverScrollText.vue';
import {
  bookFieldParts,
  type BookFieldId,
  type BookViewBook,
} from '~/utils/bookFields';
import { sanitizeDescriptionHtml } from '~/utils/descriptionHtml';
const props = withDefaults(
  defineProps<{
    book: BookViewBook;
    field: BookFieldId;
    mode: 'grid' | 'list';
    selectable?: boolean;
    measurement?: boolean;
  }>(),
  { selectable: false, measurement: false },
);
const emit = defineEmits<{ open: [event: MouseEvent] }>();
const parts = computed(() => {
  if (props.field !== 'description')
    return bookFieldParts(props.book, props.field);
  const html = props.book.description;
  if (!html) return [];
  if (typeof document === 'undefined')
    return [
      {
        text: html
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      },
    ];
  const div = document.createElement('div');
  div.innerHTML = sanitizeDescriptionHtml(html).replace(
    /<\/(p|div|li|h[1-6]|blockquote)>|<br\s*\/?>/gi,
    ' ',
  );
  return [{ text: (div.textContent ?? '').replace(/\s+/g, ' ').trim() }];
});
const label = computed(() => parts.value.map((p) => p.text).join(''));
function follow(event: MouseEvent, to: string) {
  if (props.selectable) emit('open', event);
  else navigateTo(to);
}
</script>

<template>
  <component
    :is="mode === 'grid' ? HoverScrollText : 'div'"
    v-if="label || mode === 'list' || measurement"
    :text="mode === 'grid' ? label : undefined"
    :class="[
      mode === 'grid'
        ? 'block h-6 leading-6 text-sm'
        : 'book-list-field text-sm sm:text-base leading-6',
      field === 'title' ? '' : 'opacity-70',
      field === 'series' ? 'italic' : '',
    ]"
  >
    <template v-if="label">
      <template v-for="(part, index) in parts" :key="index">
        <a
          v-if="part.to"
          :href="part.to"
          class="hover:underline cursor-pointer"
          @click.prevent.stop="follow($event, part.to)"
          >{{ part.text }}</a
        >
        <span v-else>{{ part.text }}</span>
      </template>
    </template>
    <span v-else>{{ mode === 'list' ? '—' : '\u00a0' }}</span>
  </component>
</template>

<style scoped>
.book-list-field {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  max-height: 4.5rem;
  overflow: hidden;
  overflow-wrap: anywhere;
  white-space: normal;
}
</style>
