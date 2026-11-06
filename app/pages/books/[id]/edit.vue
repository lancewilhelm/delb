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
  middleware: [
    async () => {
      const auth = useAuth();
      // Ensure we have a session/user loaded (global auth middleware doesn't enforce roles)
      await auth.fetchSession();

      const route = useRoute();
      const bookId = String(route.params.id || '');
      if (!bookId) return navigateTo('/', { replace: true });

      try {
        const res = await $fetch<{
          success?: boolean;
          data?: { book?: { canEdit?: boolean } };
        }>(`/api/books/${encodeURIComponent(bookId)}`, { method: 'GET' });

        if (!res.data?.book?.canEdit) {
          return navigateTo('/', { replace: true });
        }
      } catch {
        return navigateTo('/', { replace: true });
      }
    },
  ],
});

useHead({
  title: 'Edit Book',
});

const route = useRoute();
const bookId = computed(() => String(route.params.id || ''));
</script>

<template>
  <BookEditor mode="edit" :book-id="bookId" />
</template>
