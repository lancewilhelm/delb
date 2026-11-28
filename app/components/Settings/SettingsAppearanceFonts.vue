<script setup lang="ts">
import { useUserSettingsStore } from '~/stores/userSettings';
import { fontFamilies } from '~/utils/fontFamilies';

const userSettingsStore = useUserSettingsStore();
</script>

<template>
  <div class="w-full grid grid-cols-2 md:grid-cols-4 gap-2">
    <button
      v-for="[family, fallback] in fontFamilies"
      :key="family"
      type="button"
      class="rounded-lg"
      :class="
        userSettingsStore.activeSettings.fontFamily === family
          ? 'bg-(--main-color) text-(--contrast-inverse-color)'
          : 'bg-(--sub-color)'
      "
      :style="{ fontFamily: `'${family}', ${fallback}` }"
      :aria-pressed="userSettingsStore.activeSettings.fontFamily === family"
      @click="userSettingsStore.updateSettings({ fontFamily: family })"
    >
      {{ family }}
    </button>
  </div>
</template>
