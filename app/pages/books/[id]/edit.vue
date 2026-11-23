<script setup lang="ts">
import { useHead } from '~/composables/useHead';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
/**
 * Note: Nuxt auto-imports composables/macros like `definePageMeta`, `useHead`, etc.
 * If TypeScript isn't recognizing them (editor/tsserver), restart the dev server
 * and make sure `.nuxt` types are being picked up.
 */
import BookEditor from '~/components/Books/BookEditor.vue';

useHead({
  title: 'Edit Book',
});

const route = useRoute();
const bookId = computed(() => String(route.params.id || ''));
</script>

<template>
  <BookEditor mode="edit" :book-id="bookId" />
</template>
