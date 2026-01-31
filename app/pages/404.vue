<script setup lang="ts">
definePageMeta({
  // Allow everyone to hit a 404, even when auth is enabled.
  auth: false,
});

useHead({
  title: 'Page not found',
});

const route = useRoute();
const path = computed(() => String(route.fullPath || ''));
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />

    <div class="w-full h-full p-6 overflow-auto">
      <div class="max-w-2xl mx-auto flex flex-col gap-4">
        <div class="text-4xl font-semibold font-serif">
          404 — Page not found
        </div>

        <div class="text-sm opacity-80">
          The page you requested doesn’t exist.
        </div>

        <div class="text-sm opacity-70">
          <span class="opacity-70">Path:</span>
          <span class="font-mono break-all">{{ path }}</span>
        </div>

        <div class="flex flex-wrap gap-2 pt-2">
          <NuxtLink
            to="/"
            class="px-3 py-2 rounded-md bg-(--main-color) text-(--bg-color) hover:opacity-90 text-sm"
          >
            Go home
          </NuxtLink>

          <button
            type="button"
            class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm"
            @click="$router.back()"
          >
            Go back
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
