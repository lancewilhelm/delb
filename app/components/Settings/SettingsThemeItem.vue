<script setup lang="ts">
// Refs
const isHovered = ref(false);

// Props
defineProps<{
  theme: {
    name: string;
    bgColor: string;
    mainColor: string;
    subColor: string;
    textColor: string;
  };
  isFavorite: boolean;
}>();

const userSettingsStore = useUserSettingsStore();
</script>
<template>
  <div
    :class="[
      'flex w-full justify-between items-center cursor-pointer rounded-full border-2 font-mono px-2 py-0.5 pl-3 theme-item',
    ]"
    :style="{
      backgroundColor: theme.bgColor,
      borderColor:
        isHovered || userSettingsStore.settings.theme === theme.name
          ? theme.mainColor
          : 'var(--bg-color)',
      color: theme.textColor,
    }"
    @mouseover="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <div class="truncate theme-name">{{ theme.name }}</div>
    <div class="flex gap-1 shrink-0 theme-colors">
      <Icon
        v-if="!isFavorite && isHovered"
        name="fa6-regular:star"
        class="cursor-pointer theme-star-off"
        :style="{ text: theme.textColor }"
        @click.stop="
          userSettingsStore.updateSettings({
            favoriteThemes: [
              ...(userSettingsStore.settings.favoriteThemes || []),
              theme.name,
            ],
          })
        "
      />
      <Icon
        v-if="isFavorite"
        name="fa6-solid:star"
        class="cursor-pointer theme-star-on"
        :style="{ text: theme.textColor }"
        @click.stop="
          userSettingsStore.updateSettings({
            favoriteThemes: userSettingsStore.settings.favoriteThemes.filter(
              (t: string) => t !== theme.name,
            ),
          })
        "
      />
      <div
        class="w-4 h-4 rounded-full theme-color-main"
        :style="{ backgroundColor: theme.mainColor }"
      />
      <div
        class="w-4 h-4 rounded-full theme-color-sub"
        :style="{ backgroundColor: theme.subColor }"
      />
      <div
        class="w-4 h-4 rounded-full theme-color-text"
        :style="{ backgroundColor: theme.textColor }"
      />
    </div>
  </div>
</template>
