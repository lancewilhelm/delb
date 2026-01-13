<script setup lang="ts">
definePageMeta({
  auth: {
    only: 'user',
    redirectGuestTo: '/login',
  },
});

useHead({
  title: 'Home',
});

// Root route should redirect to the primary view page now that views are separate routes.
await navigateTo('/books', { replace: true });
</script>

<template>
  <div />
</template>
