<script setup lang="ts">
definePageMeta({
    auth: {
        only: "user",
        redirectGuestTo: "/login",
    },
});

// Page metadata
useHead({
    title: "Home",
});
</script>

<template>
    <div class="flex flex-col w-full h-full overflow-hidden">
        <AppHeader class="w-full" />
        <div class="w-full h-full p-4">
            <h2>OpenTome</h2>
            <p>
                Welcome to OpenTome — a modern, web-based library manager
                inspired by calibre. You can start building your app from here.
            </p>
        </div>
    </div>
</template>
