<script setup lang="ts">
import { getRegisterErrorMessage } from '~/utils/authErrors';
import { logger } from '~/utils/logger';

definePageMeta({
  auth: {
    only: 'guest',
    redirectUserTo: '/',
  },
});
useHead({
  title: 'Register',
});

const email = ref('');
const name = ref('');
const password = ref('');
const verifyPassword = ref('');
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

  if (!name.value.trim()) {
    showError('Please enter your name.');
    return;
  }
  if (!email.value.trim()) {
    showError('Please enter your email.');
    return;
  }
  if (!password.value) {
    showError('Please enter a password.');
    return;
  }
  if (password.value.length < 6) {
    showError('Password must be at least 6 characters.');
    return;
  }
  if (!verifyPassword.value) {
    showError('Please retype your password.');
    return;
  }
  if (password.value !== verifyPassword.value) {
    showError('Passwords do not match.');
    return;
  }

  const { signUp, fetchSession } = useAuth();
  isSubmitting.value = true;
  try {
    const { error } = await signUp.email({
      email: email.value,
      password: password.value,
      name: name.value.trim(),
    });

    if (error) {
      logger.error({ error }, 'Error signing up');
      showError(getRegisterErrorMessage(error));
      return;
    }

    // Fetch the session
    await fetchSession();

    // Pull settings immediately after register/login so theme + prefs apply without a reload.
    const userSettingsStore = useUserSettingsStore();
    const globalSettingsStore = useGlobalSettingsStore();
    await Promise.all([
      userSettingsStore.pull(),
      globalSettingsStore.pullLatest(),
    ]);

    if (userSettingsStore.activeSettings.theme) {
      await loadTheme(userSettingsStore.activeSettings.theme);
    }

    return navigateTo('/');
  } catch (error) {
    logger.error({ error }, 'Error signing up');
    showError(getRegisterErrorMessage(error));
  } finally {
    isSubmitting.value = false;
  }
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
        class="border border-(--sub-color) px-2 py-1 rounded text-[12pt] w-62.5"
      />
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
        autocomplete="password"
        placeholder="password"
        class="border border-(--sub-color) px-2 py-1 rounded text-[12pt] w-62.5"
      />
      <input
        v-model="verifyPassword"
        type="password"
        autocomplete="verifyPassword"
        placeholder="retype password"
        :class="[
          'border px-2 py-1 rounded text-[12pt] w-62.5',
          password && verifyPassword && password !== verifyPassword
            ? 'border-(--error-color)'
            : 'border-(--sub-color)',
        ]"
      />
      <button
        class="bg-(--main-color) text-(--bg-color) rounded px-2 py-1 hover:opacity-80 active:opacity-60 disabled:opacity-60 disabled:cursor-not-allowed"
        :disabled="isSubmitting"
      >
        Register
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
