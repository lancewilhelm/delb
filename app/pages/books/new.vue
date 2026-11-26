<script setup lang="ts">
import { useHead } from '~/composables/useHead';
import BookEditor from '~/components/Books/BookEditor.vue';

useHead({
  title: 'New Book',
});
</script>

<template>
  <BookEditor mode="create" />
</template>
