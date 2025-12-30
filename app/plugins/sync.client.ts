export default defineNuxtPlugin(async (nuxtApp) => {
  if (import.meta.server) return;

  /**
   * Settings sync is intentionally lightweight:
   * - Pull once on app load (when logged in)
   * - Push only when settings change (inside the settings stores)
   */
  async function pullSettingsOnce() {
    const { session } = useAuth();
    if (!session.value) return;

    const userSettingsStore = useUserSettingsStore();
    const globalSettingsStore = useGlobalSettingsStore();

    await Promise.all([
      userSettingsStore.pull(),
      globalSettingsStore.pullLatest(),
    ]);
  }

  // Try immediately; if session isn't ready yet, try again after mount.
  try {
    await pullSettingsOnce();
  } catch (err) {
    console.error("Failed to pull settings on app load:", err);
    nuxtApp.hook("app:mounted", async () => {
      try {
        await pullSettingsOnce();
      } catch (e) {
        console.error("Failed to pull settings after mount:", e);
      }
    });
  }
});
