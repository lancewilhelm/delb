<script setup lang="ts">
const userSettingsStore = useUserSettingsStore();
</script>

<template>
  <div class="w-full grid grid-cols-2 md:grid-cols-4 gap-2">
    <button
      class="rounded-lg fira-code"
      :class="
        userSettingsStore.settings.fontFamily === 'Fira Code'
          ? 'bg-(--main-color) text-(--bg-color)'
          : 'bg-(--sub-color)'
      "
      @click="
        () => {
          userSettingsStore.updateSettings({
            fontFamily: 'Fira Code',
          });
        }
      "
    >
      Fira Code
    </button>
    <button
      class="rounded-lg geist"
      :class="
        userSettingsStore.settings.fontFamily === 'Geist'
          ? 'bg-(--main-color) text-(--bg-color)'
          : 'bg-(--sub-color)'
      "
      @click="
        () => {
          userSettingsStore.updateSettings({
            fontFamily: 'Geist',
          });
        }
      "
    >
      Geist
    </button>
    <button
      class="rounded-lg ibm-plex-mono"
      :class="
        userSettingsStore.settings.fontFamily === 'IBM Plex Mono'
          ? 'bg-(--main-color) text-(--bg-color)'
          : 'bg-(--sub-color)'
      "
      @click="
        () => {
          userSettingsStore.updateSettings({
            fontFamily: 'IBM Plex Mono',
          });
        }
      "
    >
      IBM Plex Mono
    </button>
    <button
      class="rounded-lg inter"
      :class="
        userSettingsStore.settings.fontFamily === 'Inter'
          ? 'bg-(--main-color) text-(--bg-color)'
          : 'bg-(--sub-color)'
      "
      @click="
        () => {
          userSettingsStore.updateSettings({
            fontFamily: 'Inter',
          });
        }
      "
    >
      Inter
    </button>
    <button
      class="rounded-lg montserrat"
      :class="
        userSettingsStore.settings.fontFamily === 'Montserrat'
          ? 'bg-(--main-color) text-(--bg-color)'
          : 'bg-(--sub-color)'
      "
      @click="
        () => {
          userSettingsStore.updateSettings({
            fontFamily: 'Montserrat',
          });
        }
      "
    >
      Montserrat
    </button>
    <button
      class="rounded-lg nunito"
      :class="
        userSettingsStore.settings.fontFamily === 'Nunito'
          ? 'bg-(--main-color) text-(--bg-color)'
          : 'bg-(--sub-color)'
      "
      @click="
        () => {
          userSettingsStore.updateSettings({
            fontFamily: 'Nunito',
          });
        }
      "
    >
      Nunito
    </button>
    <button
      class="rounded-lg poppins"
      :class="
        userSettingsStore.settings.fontFamily === 'Poppins'
          ? 'bg-(--main-color) text-(--bg-color)'
          : 'bg-(--sub-color)'
      "
      @click="
        () => {
          userSettingsStore.updateSettings({
            fontFamily: 'Poppins',
          });
        }
      "
    >
      Poppins
    </button>
    <button
      class="rounded-lg roboto-mono"
      :class="
        userSettingsStore.settings.fontFamily === 'Roboto Mono'
          ? 'bg-(--main-color) text-(--bg-color)'
          : 'bg-(--sub-color)'
      "
      @click="
        () => {
          userSettingsStore.updateSettings({
            fontFamily: 'Roboto Mono',
          });
        }
      "
    >
      Roboto Mono
    </button>
  </div>
</template>

<style scoped>
.georgia {
  font-family: "Georgia", serif;
}
.fira-code {
  font-family: "Fira Code", monospace;
}
.ibm-plex-mono {
  font-family: "IBM Plex Mono", monospace;
}
.inter {
  font-family: "Inter", sans-serif;
}
.montserrat {
  font-family: "Montserrat", sans-serif;
}
.nunito {
  font-family: "Nunito", sans-serif;
}
.poppins {
  font-family: "Poppins", sans-serif;
}
.geist {
  font-family: "Geist", sans-serif;
}
.roboto-mono {
  font-family: "Roboto Mono", monospace;
}
</style>
