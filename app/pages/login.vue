<script setup lang="ts">
import { getLoginErrorMessage } from '~/utils/authErrors';
import { logger } from '~/utils/logger';

definePageMeta({
  auth: {
    only: 'guest',
    redirectUserTo: '/',
  },
});
useHead({
  title: 'Login',
});
const email = ref('');
const password = ref('');
const errorMessage = ref('');
const isSubmitting = ref(false);

let errorTimeout: ReturnType<typeof setTimeout> | undefined;

function showError(message: string) {
  errorMessage.value = message;
  if (errorTimeout) clearTimeout(errorTimeout);
  errorTimeout = setTimeout(() => {
    errorMessage.value = '';
  }, 5000);
}

onBeforeUnmount(() => {
  if (errorTimeout) clearTimeout(errorTimeout);
});

async function handleSubmit() {
  if (isSubmitting.value) return;
  errorMessage.value = '';

  if (!email.value.trim()) {
    showError('Please enter your email.');
    return;
  }
  if (!password.value) {
    showError('Please enter your password.');
    return;
  }

  const { signIn, fetchSession } = useAuth();
  isSubmitting.value = true;
  try {
    const { error } = await signIn.email({
      email: email.value,
      password: password.value,
    });

    if (error) {
      logger.error({ error }, 'Login failed');
      showError(getLoginErrorMessage(error));
      return;
    }

    // Fetch the session
    await fetchSession();

    // Settings sync is now:
    // - pulled once on app load when logged in
    // - pushed on change from the settings stores

    const userSettingsStore = useUserSettingsStore();
    const globalSettingsStore = useGlobalSettingsStore();
    await Promise.all([
      userSettingsStore.pull(),
      globalSettingsStore.pullLatest(),
    ]);

    // Load the theme immediately after pulling settings so there's no "default theme"
    // flash between login and the app.
    if (userSettingsStore.activeSettings.theme) {
      await loadTheme(userSettingsStore.activeSettings.theme);
    }

    // Navigate to the home page
    return navigateTo('/');
  } catch (error) {
    logger.error({ error }, 'Login failed');
    showError(getLoginErrorMessage(error));
  } finally {
    isSubmitting.value = false;
  }
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
        class="border border-(--sub-color) px-2 py-1 rounded text-[12pt] w-62.5"
      />
      <input
        v-model="password"
        type="password"
        autocomplete="current-password"
        placeholder="password"
        class="border border-(--sub-color) px-2 py-1 rounded text-[12pt] w-62.5"
      />
      <button
        class="bg-(--main-color) text-(--bg-color) rounded px-2 py-1 cursor-pointer hover:opacity-80 active:opacity-60 disabled:opacity-60 disabled:cursor-not-allowed"
        :disabled="isSubmitting"
      >
        Login
      </button>

      <AuthFormError :message="errorMessage" />
    </form>
  </div>
</template>

<style>
.logo {
  font-family: Poppins, sans-serif;
}
</style>
