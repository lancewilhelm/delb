<script setup lang="ts">
/**
 * Note: Nuxt auto-imports composables/macros like `definePageMeta`, `useHead`, etc.
 * If TypeScript isn't recognizing them (editor/tsserver), restart the dev server
 * and make sure `.nuxt` types are being picked up.
 */
import BookEditor from '~/components/Books/BookEditor.vue';

definePageMeta({
  auth: {
    only: 'user',
    redirectGuestTo: '/login',
  },
});

useHead({
  title: 'New Book',
});

const route = useRoute();

const initialCollectionIds = computed(() => {
  const raw = route.query.collections;

  const values = Array.isArray(raw)
    ? raw.flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
    : typeof raw === 'string'
      ? raw.split(',')
      : [];

  return values.map((v) => v.trim()).filter((v) => v.length > 0);
});
</script>

<template>
  <BookEditor mode="create" :initial-collection-ids="initialCollectionIds" />
</template>
