<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  theme: {
    name: string;
    bgColor: string;
    mainColor: string;
    subColor: string;
    textColor: string;
  };
  selected?: boolean;
  highlighted?: boolean;
  favoriteContext?: boolean;
}>();
const emit = defineEmits<{
  (e: "select", theme: typeof props.theme): void;
  (e: "preview" | "deleteFavorite" | "addFavorite", name: string): void;
}>();

const userSettingsStore = useUserSettingsStore();

const isFavorite = computed(() =>
  userSettingsStore.settings.favoriteThemes.includes(props.theme.name),
);
const isCurrentTheme = computed(
  () => userSettingsStore.settings.theme === props.theme.name,
);

function handleClick() {
  emit("select", props.theme);
}
function handleMouseOver() {
  isHovered.value = true;
  emit("preview", props.theme.name);
}
function handleDeleteFavorite() {
  emit("deleteFavorite", props.theme.name);
}
function handleAddFavorite() {
  emit("addFavorite", props.theme.name);
}

const isHovered = ref(false);
const root = ref(null);
defineExpose({ el: root });
</script>

<template>
  <div
    ref="root"
    class="h-9 cursor-pointer px-3 py-1 flex items-center justify-between gap-2 hover:bg-(--sub-alt-color) command-palette-theme-item"
    :class="[
      highlighted ? 'bg-(--sub-color) text-(--text-color)' : '',
      isCurrentTheme ? 'bg-(--main-color) text-(--bg-color)' : '',
    ]"
    @click="handleClick"
    @mouseenter.stop="handleMouseOver"
    @mouseover.stop
    @mouseleave="isHovered = false"
  >
    {{ theme.name }}
    <div class="flex gap-2 items-center">
      <Icon
        v-if="isFavorite"
        name="fa6-solid:star"
        class="text-(--text-color) scale-125 cursor-pointer"
        @click.stop.prevent="handleDeleteFavorite"
      />
      <Icon
        v-if="isHovered && !isFavorite"
        name="fa6-regular:star"
        class="text-(--text-color) scale-125 cursor-pointer"
        @click.stop.prevent="handleAddFavorite"
      />
      <div
        class="rounded-full p-1.5 flex gap-1"
        :style="{ backgroundColor: theme.bgColor }"
      >
        <div
          class="w-4 h-4 rounded-full"
          :style="{ backgroundColor: theme.mainColor }"
        />
        <div
          class="w-4 h-4 rounded-full"
          :style="{ backgroundColor: theme.subColor }"
        />
        <div
          class="w-4 h-4 rounded-full"
          :style="{ backgroundColor: theme.textColor }"
        />
      </div>
    </div>
  </div>
</template>
