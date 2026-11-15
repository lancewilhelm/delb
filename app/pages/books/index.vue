<script setup lang="ts">
definePageMeta({ auth: { only: 'user', redirectGuestTo: '/login' } });
</script>
<template><BooksLibraryView /></template>
