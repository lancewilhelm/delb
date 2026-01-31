export default defineNuxtPlugin((nuxtApp) => {
  if (import.meta.server) return;

  /**
   * Settings sync is intentionally lightweight:
   * - Pull once when the app has a session (initial load OR just after login)
   * - Push only when settings change (inside the settings stores)
   */
  const { loggedIn } = useAuth();
  const userSettingsStore = useUserSettingsStore();
  const globalSettingsStore = useGlobalSettingsStore();

  let pullInFlight: Promise<void> | null = null;
  async function pullSettingsOnce() {
    if (!loggedIn.value) return;
    if (pullInFlight) return pullInFlight;

    pullInFlight = Promise.all([
      userSettingsStore.pull(),
      globalSettingsStore.pullLatest(),
    ])
      .then(() => undefined)
      .finally(() => {
        pullInFlight = null;
      });

    return pullInFlight;
  }

  watch(
    loggedIn,
    async (isLoggedIn, wasLoggedIn) => {
      if (!isLoggedIn) return;

      // Only pull on the transition to "logged in" (plus one immediate run).
      if (wasLoggedIn) return;

      try {
        await pullSettingsOnce();
      } catch (err) {
        console.error('Failed to pull settings after login:', err);
      }
    },
    { immediate: true },
  );

  nuxtApp.hook('app:mounted', async () => {
    // Safety net: in case session hydration happens after plugin init.
    try {
      await pullSettingsOnce();
    } catch (err) {
      console.error('Failed to pull settings after mount:', err);
    }
  });
});
