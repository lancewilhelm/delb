<script setup lang="ts">
import themesList from '~/assets/json/themes.json';

interface Theme {
  name: string;
  bgColor: string;
  mainColor: string;
  subColor: string;
  textColor: string;
}

const userSettingsStore = useUserSettingsStore();

// ------------------------------
// Cover Style controls
// ------------------------------
const coverStyleGlossy = computed<boolean>({
  get() {
    return userSettingsStore.settings.coverStyle.glossySpine;
  },
  set(value) {
    userSettingsStore.updateSettings({
      coverStyle: {
        ...userSettingsStore.settings.coverStyle,
        glossySpine: value,
      },
    });
  },
});

const coverStyleRoundedRight = computed<boolean>({
  get() {
    return userSettingsStore.settings.coverStyle.roundedRight;
  },
  set(value) {
    userSettingsStore.updateSettings({
      coverStyle: {
        ...userSettingsStore.settings.coverStyle,
        roundedRight: value,
      },
    });
  },
});

const coverStyleGrayscale = computed<boolean>({
  get() {
    return userSettingsStore.settings.coverStyle.grayscale;
  },
  set(value) {
    userSettingsStore.updateSettings({
      coverStyle: {
        ...userSettingsStore.settings.coverStyle,
        grayscale: value,
      },
    });
  },
});

// ------------------------------
// Book grid appearance controls
// ------------------------------
const gridCoverDynamicSizing = computed<boolean>({
  get() {
    return userSettingsStore.settings.bookGrid.dynamicCoverSizing;
  },
  set(value) {
    userSettingsStore.updateSettings({
      bookGrid: {
        ...userSettingsStore.settings.bookGrid,
        dynamicCoverSizing: value,
      },
    });
  },
});

const gridCoverSizeValue = computed<number>({
  get() {
    return userSettingsStore.settings.bookGrid.coverWidthPresetPx;
  },
  set(value) {
    userSettingsStore.updateSettings({
      bookGrid: {
        ...userSettingsStore.settings.bookGrid,
        coverWidthPresetPx: value,
      },
    });
  },
});

const gridCoverGapValue = computed<number>({
  get() {
    return userSettingsStore.settings.bookGrid.gap;
  },
  set(value) {
    userSettingsStore.updateSettings({
      bookGrid: {
        ...userSettingsStore.settings.bookGrid,
        gap: value,
      },
    });
  },
});

const gridCoverShowTitle = computed<boolean>({
  get() {
    return userSettingsStore.settings.bookGrid.showTitle;
  },
  set(value) {
    userSettingsStore.updateSettings({
      bookGrid: {
        ...userSettingsStore.settings.bookGrid,
        showTitle: value,
      },
    });
  },
});

const gridCoverShowAuthors = computed<boolean>({
  get() {
    return userSettingsStore.settings.bookGrid.showAuthors;
  },
  set(value) {
    userSettingsStore.updateSettings({
      bookGrid: {
        ...userSettingsStore.settings.bookGrid,
        showAuthors: value,
      },
    });
  },
});

const gridCoverShowSeries = computed<boolean>({
  get() {
    return userSettingsStore.settings.bookGrid.showSeries;
  },
  set(value) {
    userSettingsStore.updateSettings({
      bookGrid: {
        ...userSettingsStore.settings.bookGrid,
        showSeries: value,
      },
    });
  },
});

// ------------------------------
// Theme items
// ------------------------------

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
  hex = hex.replace(/#/, '');
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const toLinear = (c: number) => {
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

const sortedByName = computed(
  () => userSettingsStore.settings.themeSorting.sortedByName,
);
const reverseSort = computed(
  () => userSettingsStore.settings.themeSorting.reverseSort,
);

function handleSortChange(target: string) {
  let tempSortedByName, tempReverseSort;
  if (target === 'name') {
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
</script>

<template>
  <div class="w-full">
    <SettingsUIGroup
      title="cover style"
      icon="lucide:book-image"
      description="customize the cover style"
    >
      <SettingsUIToggle
        v-model="coverStyleGlossy"
        title="Glossy Spine"
        description="Creates an Apple Books style glossy cover effect"
      />
      <SettingsUIToggle
        v-model="coverStyleRoundedRight"
        title="Rounded Right"
        description="Rounds the right edge of the cover like some covers in Goodreads"
      />
      <SettingsUIToggle
        v-model="coverStyleGrayscale"
        title="Grayscale"
        description="Applies a grayscale filter to the cover"
      />
    </SettingsUIGroup>

    <SettingsUIGroup
      title="book grid"
      icon="lucide:layout-grid"
      description="customize grid cover sizing"
    >
      <SettingsUIToggle
        v-model="gridCoverDynamicSizing"
        title="Dynamic cover sizing"
        description="When enabled, covers grow/shrink together to fill the row. When disabled, covers keep a fixed width."
      />
      <SettingsUISlider
        v-model="gridCoverSizeValue"
        title="Cover size"
        description="Sets the minimum cover width used by the grid (default: 172px)"
        :min="100"
        :max="250"
        :value-input="true"
        :suffix="'px'"
      />
      <SettingsUISlider
        v-model="gridCoverGapValue"
        title="Cover gap"
        description="Sets the distance between cover thumbnails (default: 12px)"
        :min="2"
        :max="100"
        :value-input="true"
        :suffix="'px'"
      />
      <SettingsUIToggle
        v-model="gridCoverShowTitle"
        title="Show Book Title"
        description="Show the book title under the cover"
      />
      <SettingsUIToggle
        v-model="gridCoverShowAuthors"
        title="Show Book Authors"
        description="Show the book authors under the cover"
      />
      <SettingsUIToggle
        v-model="gridCoverShowSeries"
        title="Show Book Series"
        description="Show the book series under the cover"
      />
    </SettingsUIGroup>

    <SettingsUIGroup
      title="font"
      icon="ri:font-family"
      description="customize the font style"
    >
      <SettingsAppearanceFonts />
    </SettingsUIGroup>
    <SettingsUIGroup title="themes" icon="lucide:palette">
      <div class="w-full flex gap-2 mb-4">
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
      <SettingsUISubGroup
        v-if="favoriteThemes.length"
        title="favorite themes"
        icon="lucide:star"
      >
        <div class="grid grid-cols-2 md:grid-cols-3 gap-2 w-full">
          <SettingsUITheme
            v-for="theme in favoriteThemes"
            :key="theme.name"
            :theme="theme"
            :is-favorite="true"
            @click="
              () => {
                userSettingsStore.updateSettings({
                  theme: theme.name,
                });
                loadTheme(theme.name);
              }
            "
          />
        </div>
      </SettingsUISubGroup>
      <SettingsUISubGroup title="themes" icon="lucide:palette">
        <div class="grid grid-cols-2 md:grid-cols-3 gap-2 w-full">
          <SettingsUITheme
            v-for="theme in allThemes"
            :key="theme.name"
            :theme="theme"
            :is-favorite="
              userSettingsStore.settings.favoriteThemes?.includes(theme.name)
            "
            @click="
              () => {
                userSettingsStore.updateSettings({
                  theme: theme.name,
                });
                loadTheme(theme.name);
              }
            "
          />
        </div>
      </SettingsUISubGroup>
    </SettingsUIGroup>
  </div>
</template>

<style scoped>
.geist {
  font-family: 'Geist', sans-serif;
}

.roboto-mono {
  font-family: 'Roboto Mono', monospace;
}
</style>
