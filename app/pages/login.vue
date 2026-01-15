<script setup lang="ts">
definePageMeta({
    auth: {
        only: "guest",
        redirectUserTo: "/",
    },
});
useHead({
    title: "Login",
});
const email = ref("");
const password = ref("");

async function handleSubmit() {
    const { signIn, fetchSession } = useAuth();
    const { error } = await signIn.email({
        email: email.value,
        password: password.value,
    });

    if (error) {
        alert("Login failed:");
        return;
    }

    // Fetch the session
    await fetchSession();

    // Settings sync is now:
    // - pulled once on app load when logged in
    // - pushed on change from the settings stores

    // Load the theme
    const userSettingsStore = useUserSettingsStore();
    if (userSettingsStore.activeSettings.theme) {
        loadTheme(userSettingsStore.activeSettings.theme);
    }

    // Navigate to the home page
    return navigateTo("/");
}
</script>

<template>
    <div
        class="login-container w-full h-full flex flex-col items-center justify-center"
    >
        <div class="text-7xl font-bold mb-6 text-(--main-color) logo">Delb</div>
        <form
            class="flex flex-col gap-2 items-center login-form"
            @submit.prevent="handleSubmit"
        >
            <input
                v-model="email"
                type="email"
                autocomplete="email"
                placeholder="email"
                class="border border-(--sub-color) px-2 py-1 rounded text-[12pt] w-[250px]"
            />
            <input
                v-model="password"
                type="password"
                autocomplete="current-password"
                placeholder="password"
                class="border border-(--sub-color) px-2 py-1 rounded text-[12pt] w-[250px]"
            />
            <button
                class="bg-(--main-color) text-(--bg-color) rounded px-2 py-1 cursor-pointer hover:opacity-80 active:opacity-60"
            >
                login
            </button>
        </form>
    </div>
</template>

<style>
.logo {
    font-family: Poppins, sans-serif;
}
</style>
