<script setup lang="ts">
definePageMeta({
    auth: {
        only: "guest",
        redirectUserTo: "/",
    },
});
useHead({
    title: "Register",
});

const email = ref("");
const name = ref("");
const password = ref("");
const verifyPassword = ref("");

async function handleSubmit() {
    if (!name.value.trim()) {
        alert("Please enter your name");
        return;
    }
    if (password.value !== verifyPassword.value) {
        alert("Passwords do not match");
        return;
    }

    const { signUp, fetchSession } = useAuth();
    const { error } = await signUp.email({
        email: email.value,
        password: password.value,
        name: name.value.trim(),
    });

    if (error) {
        console.log(error);
        alert(`Error signing up: ${error.message}`);
        return;
    }

    // Fetch the session
    await fetchSession();

    return navigateTo("/");
}
</script>

<template>
    <div
        class="login-container w-full h-full flex flex-col items-center justify-center"
    >
        <NuxtLink
            to="/login"
            class="logo text-7xl font-bold mb-6 text-(--main-color)"
            >Delb</NuxtLink
        >
        <form
            class="flex flex-col gap-2 items-center register-form"
            @submit.prevent="handleSubmit"
        >
            <input
                v-model="name"
                type="text"
                autocomplete="name"
                placeholder="name"
                class="border border-(--sub-color) px-2 py-1 rounded text-[12pt] w-[250px]"
            />
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
                autocomplete="password"
                placeholder="password"
                class="border border-(--sub-color) px-2 py-1 rounded text-[12pt] w-[250px]"
            />
            <input
                v-model="verifyPassword"
                type="password"
                autocomplete="verifyPassword"
                placeholder="retype password"
                :class="[
                    'border px-2 py-1 rounded text-[12pt] w-[250px]',
                    password && verifyPassword && password !== verifyPassword
                        ? 'border-(--error-color)'
                        : 'border-(--sub-color)',
                ]"
            />
            <button
                class="bg-(--main-color) text-(--bg-color) rounded px-2 py-1 hover:opacity-80 active:opacity-60"
            >
                register
            </button>
        </form>
    </div>
</template>

<style>
.logo {
    font-family: Poppins, sans-serif;
}
</style>
