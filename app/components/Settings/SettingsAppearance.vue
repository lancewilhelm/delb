<script setup lang="ts">
import themesList from "~/assets/json/themes.json";

interface Theme {
  name: string;
  bgColor: string;
  mainColor: string;
  subColor: string;
  textColor: string;
}

const userSettingsStore = useUserSettingsStore();
const sortedByName = computed(
  () => userSettingsStore.settings.themeSorting.sortedByName,
);
const reverseSort = computed(
  () => userSettingsStore.settings.themeSorting.reverseSort,
);
function handleSortChange(target: string) {
  let tempSortedByName, tempReverseSort;
  if (target === "name") {
    if (!sortedByName.value) {
      tempSortedByName = true;
    } else {
      tempReverseSort = !reverseSort.value;
    }
  } else {
    if (sortedByName.value) {
      tempSortedByName = false;
    } else {
      tempReverseSort = !reverseSort.value;
    }
  }
  userSettingsStore.updateSettings({
    themeSorting: {
      sortedByName: tempSortedByName ?? sortedByName.value,
      reverseSort: tempReverseSort ?? reverseSort.value,
    },
  });
}

const allThemes = computed(() =>
  JSON.parse(JSON.stringify(themesList)).sort((a: Theme, b: Theme) => {
    if (sortedByName.value) {
      return reverseSort.value
        ? b.name.localeCompare(a.name)
        : a.name.localeCompare(b.name);
    }
    if (reverseSort.value) {
      return hexToLuminance(b.bgColor) - hexToLuminance(a.bgColor);
    }
    return hexToLuminance(a.bgColor) - hexToLuminance(b.bgColor);
  }),
);

const favoriteThemes = computed(() =>
  JSON.parse(JSON.stringify(themesList))
    .filter((theme: Theme) => {
      if (!userSettingsStore.settings.favoriteThemes) return false;
      return userSettingsStore.settings.favoriteThemes.includes(theme.name);
    })
    .sort((a: Theme, b: Theme) => {
      if (sortedByName.value) {
        return reverseSort.value
          ? b.name.localeCompare(a.name)
          : a.name.localeCompare(b.name);
      }
      if (reverseSort.value) {
        return hexToLuminance(b.bgColor) - hexToLuminance(a.bgColor);
      }
      return hexToLuminance(a.bgColor) - hexToLuminance(b.bgColor);
    }),
);

function hexToLuminance(hex: string) {
  hex = hex.replace(/#/, "");
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const toLinear = (c: number) => {
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}
</script>

<template>
  <div class="w-full">
    <SettingsGroup
      title="font"
      icon="ri:font-family"
      description="customize the font style"
    >
      <SettingsAppearanceFonts />
    </SettingsGroup>
    <SettingsGroup title="themes" icon="lucide:palette">
      <div class="w-full flex gap- mb-4">
        <button
          :class="[
            'flex w-full items-center justify-center p-2 rounded-lg cursor-pointer hover:opacity-80',
            sortedByName ? 'bg-(--main-color)!' : 'bg-(--sub-alt-color)!',
          ]"
          @click="handleSortChange('name')"
        >
          <Icon
            v-if="!reverseSort"
            name="lucide:arrow-down-a-z"
            :class="[
              'scale-150',
              sortedByName ? 'text-(--bg-color)!' : 'text-(--text-color)!',
            ]"
          />
          <Icon
            v-if="reverseSort"
            name="lucide:arrow-down-z-a"
            :class="[
              'scale-150',
              sortedByName ? 'text-(--bg-color)!' : 'text-(--text-color)!',
            ]"
          />
        </button>
        <button
          :class="[
            'flex w-full items-center justify-center p-2 rounded-lg cursor-pointer hover:opacity-80',
            !sortedByName ? 'bg-(--main-color)!' : 'bg-(--sub-alt-color)!',
          ]"
          @click="handleSortChange('brightness')"
        >
          <Icon
            v-if="!reverseSort"
            name="lucide:arrow-down-narrow-wide"
            :class="[
              'scale-150',
              !sortedByName ? 'text-(--bg-color)' : 'text-(--text-color)',
            ]"
          />
          <Icon
            v-if="reverseSort"
            name="lucide:arrow-down-wide-narrow"
            :class="[
              'scale-150',
              !sortedByName ? 'text-(--bg-color)' : 'text-(--text-color)',
            ]"
          />
        </button>
      </div>
      <SettingsSubGroup
        v-if="favoriteThemes.length"
        title="favorite themes"
        icon="lucide:star"
      >
        <div class="grid grid-cols-2 md:grid-cols-3 gap-2 w-full">
          <SettingsThemeItem
            v-for="theme in favoriteThemes"
            :key="theme.name"
            :theme="theme"
            :is-favorite="true"
            @click="
              () => {
                userSettingsStore.updateSettings({ theme: theme.name });
                loadTheme(theme.name);
              }
            "
          />
        </div>
      </SettingsSubGroup>
      <SettingsSubGroup title="themes" icon="lucide:palette">
        <div class="grid grid-cols-2 md:grid-cols-3 gap-2 w-full">
          <SettingsThemeItem
            v-for="theme in allThemes"
            :key="theme.name"
            :theme="theme"
            :is-favorite="
              userSettingsStore.settings.favoriteThemes?.includes(theme.name)
            "
            @click="
              () => {
                userSettingsStore.updateSettings({ theme: theme.name });
                loadTheme(theme.name);
              }
            "
          />
        </div>
      </SettingsSubGroup>
    </SettingsGroup>
  </div>
</template>

<style scoped>
.geist {
  font-family: "Geist", sans-serif;
}

.roboto-mono {
  font-family: "Roboto Mono", monospace;
}
</style>
