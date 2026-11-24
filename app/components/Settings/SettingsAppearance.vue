<script setup lang="ts">
import { useIsMobileDevice } from '~/composables/useIsMobileDevice';
import { useThemeAppearance } from '~/composables/useThemeAppearance';
import { useUserSettingsStore } from '~/stores/userSettings';
import { computed } from 'vue';
import BooksViewFieldsSettings from '~/components/Books/BooksViewFieldsSettings.vue';
import SettingsAppearanceCustomTheme from '~/components/Settings/SettingsAppearanceCustomTheme.vue';
import SettingsAppearanceFonts from '~/components/Settings/SettingsAppearanceFonts.vue';
import SettingsUIGroup from '~/components/Settings/UI/SettingsUIGroup.vue';
import SettingsUIInput from '~/components/Settings/UI/SettingsUIInput.vue';
import SettingsUISlider from '~/components/Settings/UI/SettingsUISlider.vue';
import SettingsUISubGroup from '~/components/Settings/UI/SettingsUISubGroup.vue';
import SettingsUITheme from '~/components/Settings/UI/SettingsUITheme.vue';
import SettingsUIToggle from '~/components/Settings/UI/SettingsUIToggle.vue';
import themesList from '~/assets/json/themes.json';
import { normalizeCustomTheme } from '~/utils/customTheme';
import {
  DEFAULT_BOOKSHELF_COLOR,
  type BookshelfTexture,
} from '~/stores/userSettings';
import {
  CARD_ART_LABELS,
  CARD_ART_STYLES,
  type CardArtDefault,
  type LibraryArtStyle,
  type WallMotion,
} from '~/utils/dashboardArt';
import type { BaseUserSettings } from '~/stores/userSettings';
import {
  DEFAULT_APPEARANCE_CONTRAST,
  MIN_APPEARANCE_CONTRAST,
  MAX_APPEARANCE_CONTRAST,
} from '~/utils/appearanceContrast';

interface Theme {
  name: string;
  bgColor: string;
  mainColor: string;
  subColor: string;
  textColor: string;
}

const userSettingsStore = useUserSettingsStore();
const appearance = useThemeAppearance();
const isMobileDevice = useIsMobileDevice();
const contrast = userSettingsStore.settingRef<number>('appearanceContrast');
const bookshelfColor = userSettingsStore.settingRef<string>(
  'bookshelfStyle.color',
);
const bookshelfTexture = userSettingsStore.settingRef<BookshelfTexture>(
  'bookshelfStyle.texture',
);

// ------------------------------
// Dashboard
// ------------------------------
const dashboardStatusBar = userSettingsStore.settingRef<boolean>(
  'dashboard.showStatusBar',
);
const dashboardLibraryArt = userSettingsStore.settingRef<LibraryArtStyle>(
  'dashboard.libraryArt',
);
const dashboardWallMotion = userSettingsStore.settingRef<WallMotion>(
  'dashboard.wallMotion',
);
const dashboardCardArt = userSettingsStore.settingRef<CardArtDefault>(
  'dashboard.cardArt.default',
);
const cardArtOptions: { value: CardArtDefault; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  ...CARD_ART_STYLES.map((style) => ({
    value: style,
    label: CARD_ART_LABELS[style],
  })),
];
const cardArtOverrideCount = computed(
  () =>
    Object.keys(userSettingsStore.activeSettings.dashboard.cardArt.overrides)
      .length,
);
function resetCardArtOverrides() {
  const overrides = Object.fromEntries(
    Object.keys(
      userSettingsStore.activeSettings.dashboard.cardArt.overrides,
    ).map((key) => [key, null]),
  );
  void userSettingsStore.updateSettings({
    dashboard: { cardArt: { overrides } },
  } as unknown as Partial<BaseUserSettings>);
}

// ------------------------------
// Mobile settings
// ------------------------------
const separateMobileSettings =
  userSettingsStore.mobileSettingRef<boolean>('enabled');

const mobileSearchButton = userSettingsStore.mobileSettingRef<boolean>(
  'mobileSpecific.searchButton',
);

// ------------------------------
// Cover Style controls
// ------------------------------
const coverStyleGlossy = userSettingsStore.settingRef<boolean>(
  'coverStyle.glossySpine',
);
const detailSpineGloss = userSettingsStore.settingRef<boolean>(
  'coverStyle.detailSpineGloss',
);
const showDetailSpine = userSettingsStore.settingRef<boolean>(
  'coverStyle.showDetailSpine',
);

const coverStyleRoundedRight = userSettingsStore.settingRef<boolean>(
  'coverStyle.roundedRight',
);

const coverCopyIndicators = userSettingsStore.settingRef<boolean>(
  'coverStyle.showCopyIndicators',
);
const coverStyleGrayscale = userSettingsStore.settingRef<boolean>(
  'coverStyle.grayscale',
);

const coverReadingStatus = userSettingsStore.settingRef<boolean>(
  'coverStyle.showReadingStatus',
);

const authorsMaxCovers = userSettingsStore.settingRef<number>(
  'coverStyle.authorsMaxCovers',
);

const seriesMaxCovers = userSettingsStore.settingRef<number>(
  'coverStyle.seriesMaxCovers',
);

const publishersMaxCovers = userSettingsStore.settingRef<number>(
  'coverStyle.publishersMaxCovers',
);

const tagsMaxCovers = userSettingsStore.settingRef<number>(
  'coverStyle.tagsMaxCovers',
);

// ------------------------------
// Book grid appearance controls
// ------------------------------
const gridCoverDynamicSizing = userSettingsStore.settingRef<boolean>(
  'bookGrid.dynamicCoverSizing',
);

const gridCoverSizeValue = userSettingsStore.settingRef<number>(
  'bookGrid.coverWidthPresetPx',
);

const gridCoverGapValue = userSettingsStore.settingRef<number>('bookGrid.gap');

// ------------------------------
// Book list appearance controls
// ------------------------------
const listRowHeightValue = userSettingsStore.settingRef<number>(
  'bookList.rowHeightPx',
);

// ------------------------------
// Reader settings
// ------------------------------
const readerMinSpreadWidth = userSettingsStore.settingRef<number>(
  'reader.minSpreadWidth',
);

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
  [
    ...themesList,
    {
      name: 'custom',
      ...normalizeCustomTheme(userSettingsStore.activeSettings.customTheme),
    },
  ]
    .filter((theme: Theme) => {
      if (!userSettingsStore.activeSettings.favoriteThemes) return false;
      return userSettingsStore.activeSettings.favoriteThemes.includes(
        theme.name,
      );
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
  () => userSettingsStore.activeSettings.themeSorting.sortedByName,
);
const reverseSort = computed(
  () => userSettingsStore.activeSettings.themeSorting.reverseSort,
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
      title="Device Settings"
      icon="lucide:smartphone"
      description="choose whether mobile devices can override your default settings"
    >
      <SettingsUIToggle
        v-model="separateMobileSettings"
        title="Separate mobile settings"
        description="When enabled, mobile devices can override the defaults with a full mobile-specific copy."
      />
      <div
        v-if="separateMobileSettings && isMobileDevice"
        class="text-sm italic text-(--contrast-sub-color)"
      >
        You are currently editing mobile-specific settings.
      </div>
    </SettingsUIGroup>
    <SettingsUIGroup
      title="Bookshelf"
      icon="lucide:library"
      description="Personalize your bookshelf"
    >
      <div class="bookshelf-appearance">
        <label class="bookshelf-color-choice">
          <span
            ><strong>Wood color</strong
            ><small>Choose a color for the frame and shelves.</small></span
          >
          <input
            v-model="bookshelfColor"
            type="color"
            aria-label="Bookshelf color"
          />
        </label>
        <div class="bookshelf-texture-choice">
          <span
            ><strong>Texture</strong
            ><small>Choose the finish for your shelves.</small></span
          >
          <div
            class="bookshelf-texture-options"
            role="group"
            aria-label="Bookshelf texture"
          >
            <button
              type="button"
              :aria-pressed="bookshelfTexture === 'wood'"
              @click="bookshelfTexture = 'wood'"
            >
              Wood grain
            </button>
            <button
              type="button"
              :aria-pressed="bookshelfTexture === 'smooth'"
              @click="bookshelfTexture = 'smooth'"
            >
              Smooth
            </button>
          </div>
        </div>
        <button
          v-if="
            bookshelfColor !== DEFAULT_BOOKSHELF_COLOR ||
            bookshelfTexture !== 'wood'
          "
          type="button"
          class="bookshelf-reset"
          @click="
            bookshelfColor = DEFAULT_BOOKSHELF_COLOR;
            bookshelfTexture = 'wood';
          "
        >
          Reset bookshelf appearance
        </button>
      </div>
    </SettingsUIGroup>
    <SettingsUIGroup
      title="Dashboard"
      icon="lucide:layout-dashboard"
      description="choose how the dashboard summarizes your library"
    >
      <SettingsUIToggle
        v-model="dashboardStatusBar"
        title="Status bar"
        description="Show a color-coded bar of reading statuses on the All books card."
      />
      <div class="bookshelf-appearance">
        <div class="bookshelf-texture-choice">
          <span
            ><strong>All books art</strong
            ><small
              >A tilted wall of recent covers, or a pile you can pick up and
              toss.</small
            ></span
          >
          <div
            class="bookshelf-texture-options"
            role="group"
            aria-label="All books art"
          >
            <button
              type="button"
              :aria-pressed="dashboardLibraryArt === 'wall'"
              @click="dashboardLibraryArt = 'wall'"
            >
              Wall
            </button>
            <button
              type="button"
              :aria-pressed="dashboardLibraryArt === 'pile'"
              @click="dashboardLibraryArt = 'pile'"
            >
              Pile
            </button>
          </div>
        </div>
        <div class="bookshelf-texture-choice">
          <span
            ><strong>Wall motion</strong
            ><small
              >Let the All books wall drift slowly upward, bringing in more of
              your covers as it goes. Off when your system reduces
              motion.</small
            ></span
          >
          <div
            class="bookshelf-texture-options"
            role="group"
            aria-label="Wall motion"
          >
            <button
              type="button"
              :aria-pressed="dashboardWallMotion === 'off'"
              @click="dashboardWallMotion = 'off'"
            >
              Off
            </button>
            <button
              type="button"
              :aria-pressed="dashboardWallMotion === 'up'"
              @click="dashboardWallMotion = 'up'"
            >
              Drift up
            </button>
          </div>
        </div>
        <div class="bookshelf-texture-choice">
          <span
            ><strong>Card art</strong
            ><small
              >The default art for status and shelf cards. Auto gives each list
              its own style. Change a single card from its ⋯ menu.</small
            ></span
          >
          <div
            class="bookshelf-texture-options flex-wrap"
            role="group"
            aria-label="Default card art"
          >
            <button
              v-for="option in cardArtOptions"
              :key="option.value"
              type="button"
              :aria-pressed="dashboardCardArt === option.value"
              @click="dashboardCardArt = option.value"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <button
          v-if="cardArtOverrideCount"
          type="button"
          class="bookshelf-reset"
          @click="resetCardArtOverrides"
        >
          Reset {{ cardArtOverrideCount }}
          {{ cardArtOverrideCount === 1 ? 'card' : 'cards' }} to the default
        </button>
      </div>
    </SettingsUIGroup>
    <SettingsUIGroup
      title="Cover Style"
      icon="lucide:book-image"
      description="customize the cover style"
    >
      <SettingsUIToggle
        v-model="coverStyleGlossy"
        title="Cover gloss"
        description="Creates an Apple Books style glossy cover effect"
      />
      <SettingsUIToggle
        v-model="detailSpineGloss"
        title="Spine gloss"
        description="Adds a glossy effect to spines on bookshelves and the book detail page."
      />
      <SettingsUIToggle
        v-model="showDetailSpine"
        title="Show spine on book details"
        description="Display custom spine artwork next to the cover on book detail pages."
      />
      <SettingsUIToggle
        v-model="coverStyleRoundedRight"
        title="Rounded Right"
        description="Rounds the right edge of the cover like some covers in Goodreads"
      />
      <SettingsUIToggle
        v-model="coverStyleGrayscale"
        title="Grayscale"
        description="Applies a grayscale filter to covers and spines"
      />
      <SettingsUIToggle
        v-model="coverReadingStatus"
        title="Reading status badges"
        description="Show a small reading-status icon in the top-right corner of book covers."
      />
      <SettingsUIToggle
        v-model="coverCopyIndicators"
        title="Copy indicators"
        description="Show physical and audiobook icons in the bottom-right corner of book covers."
      />
      <SettingsUIInput
        v-model="authorsMaxCovers"
        title="Authors Max Cover Count"
        description="Maximum number of covers to display on author cards. (-1 for no limit)"
      />
      <SettingsUIInput
        v-model="seriesMaxCovers"
        title="Series Max Cover Count"
        description="Maximum number of covers to display on series cards. (-1 for no limit)"
      />
      <SettingsUIInput
        v-model="publishersMaxCovers"
        title="Publisher Max Cover Count"
        description="Maximum number of covers to display on publisher cards. (-1 for no limit)"
      />
      <SettingsUIInput
        v-model="tagsMaxCovers"
        title="Publisher Max Cover Count"
        description="Maximum number of covers to display on tag cards. (-1 for no limit)"
      />
    </SettingsUIGroup>

    <SettingsUIGroup
      title="Book Grid"
      icon="lucide:layout-grid"
      description="customize grid cover sizing"
    >
      <SettingsUIToggle
        v-model="gridCoverDynamicSizing"
        title="Dynamic Cover Sizing"
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
      <BooksViewFieldsSettings mode="grid" />
    </SettingsUIGroup>

    <SettingsUIGroup
      title="Book List"
      icon="lucide:list"
      description="customize list row sizing"
    >
      <SettingsUISlider
        v-model="listRowHeightValue"
        title="Row height"
        description="Sets the minimum height for each row in list view (default: 84px)"
        :min="56"
        :max="160"
        :value-input="true"
        :suffix="'px'"
      />
      <BooksViewFieldsSettings mode="list" />
    </SettingsUIGroup>

    <SettingsUIGroup
      title="Mobile"
      icon="lucide:smartphone"
      description="Mobile device specific settings"
    >
      <SettingsUIToggle
        v-model="mobileSearchButton"
        title="Mobile search button"
        description="On mobile devices, show a search button in the bottom right instead of in the header"
      />
    </SettingsUIGroup>

    <SettingsUIGroup
      title="Reader"
      icon="lucide:book-open"
      description="Reader settings"
    >
      <SettingsUISlider
        v-model="readerMinSpreadWidth"
        title="Reader Min Spread Width"
        description="Min width where the reader displays as two columns (default: 1100px)"
        :min="400"
        :max="5000"
        :value-input="true"
        :suffix="'px'"
      />
    </SettingsUIGroup>

    <SettingsUIGroup
      title="Font"
      icon="ri:font-family"
      description="customize the font style"
    >
      <SettingsAppearanceFonts />
    </SettingsUIGroup>
    <SettingsUIGroup title="Themes" icon="lucide:palette">
      <div class="flex w-full flex-col items-start gap-2 mb-4">
        <SettingsUISlider
          v-model="contrast"
          title="Contrast"
          description="Below 100% softens text and borders. Above 100% strengthens text and gradually emphasizes borders."
          :min="MIN_APPEARANCE_CONTRAST"
          :max="MAX_APPEARANCE_CONTRAST"
          :step="5"
          :display-value="true"
          suffix="%"
        />
        <button
          v-if="contrast !== DEFAULT_APPEARANCE_CONTRAST"
          type="button"
          class="self-start rounded-lg px-3 py-1 bg-(--sub-alt-color)!"
          @click="contrast = DEFAULT_APPEARANCE_CONTRAST"
        >
          Reset contrast to {{ DEFAULT_APPEARANCE_CONTRAST }}%
        </button>
      </div>
      <div class="flex flex-wrap items-center gap-3 mb-4 text-sm">
        <span>{{
          userSettingsStore.activeSettings.themePreference.mode === 'system'
            ? 'Following system appearance'
            : 'Fixed theme'
        }}</span>
        <button
          v-if="
            userSettingsStore.activeSettings.themePreference.mode === 'fixed'
          "
          type="button"
          class="rounded-lg px-3 py-1 bg-(--sub-alt-color)!"
          @click="appearance.useSystem()"
        >
          Follow system appearance
        </button>
        <span class="text-(--contrast-sub-color)"
          >Right-click or press and hold a theme to set its system slot. On a
          keyboard, use Shift+F10.</span
        >
      </div>
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
              sortedByName
                ? 'text-(--contrast-inverse-color)!'
                : 'text-(--contrast-text-color)!',
            ]"
          />
          <Icon
            v-if="reverseSort"
            name="lucide:arrow-down-z-a"
            :class="[
              'scale-150',
              sortedByName
                ? 'text-(--contrast-inverse-color)!'
                : 'text-(--contrast-text-color)!',
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
              !sortedByName
                ? 'text-(--contrast-inverse-color)'
                : 'text-(--contrast-text-color)',
            ]"
          />
          <Icon
            v-if="reverseSort"
            name="lucide:arrow-down-wide-narrow"
            :class="[
              'scale-150',
              !sortedByName
                ? 'text-(--contrast-inverse-color)'
                : 'text-(--contrast-text-color)',
            ]"
          />
        </button>
      </div>
      <SettingsUISubGroup
        v-if="favoriteThemes.length"
        title="Favorite Themes"
        icon="lucide:star"
      >
        <div class="grid grid-cols-2 md:grid-cols-3 gap-2 w-full">
          <SettingsUITheme
            v-for="theme in favoriteThemes"
            :key="theme.name"
            :theme="theme"
            :is-favorite="true"
          />
        </div>
      </SettingsUISubGroup>
      <SettingsUISubGroup title="Themes" icon="lucide:palette">
        <div class="grid grid-cols-2 md:grid-cols-3 gap-2 w-full">
          <SettingsUITheme
            v-for="theme in allThemes"
            :key="theme.name"
            :theme="theme"
            :is-favorite="
              userSettingsStore.activeSettings.favoriteThemes?.includes(
                theme.name,
              )
            "
          />
        </div>
      </SettingsUISubGroup>
      <SettingsUISubGroup title="Custom Theme" icon="lucide:paintbrush">
        <SettingsAppearanceCustomTheme />
      </SettingsUISubGroup>
    </SettingsUIGroup>
  </div>
</template>

<style scoped>
.bookshelf-appearance {
  display: grid;
  gap: 12px;
  width: 100%;
  padding: 8px 0 12px;
}
.bookshelf-color-choice,
.bookshelf-texture-choice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.bookshelf-color-choice span,
.bookshelf-texture-choice span {
  display: grid;
  gap: 3px;
  color: var(--contrast-main-color);
}
.bookshelf-appearance small {
  color: var(--contrast-text-color);
  font-size: 12px;
}
.bookshelf-color-choice input {
  width: 42px;
  height: 38px;
  padding: 3px;
  border: 1px solid var(--contrast-border-color);
  border-radius: 8px;
  cursor: pointer;
  background: var(--bg-color);
}
.bookshelf-texture-options {
  display: flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--contrast-border-color);
  border-radius: 9px;
}
.bookshelf-texture-options button,
.bookshelf-reset {
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}
.bookshelf-texture-options button[aria-pressed='true'] {
  color: var(--bg-color);
  background: var(--contrast-main-color);
}
.bookshelf-texture-options button:focus-visible,
.bookshelf-color-choice input:focus-visible,
.bookshelf-reset:focus-visible {
  outline: 2px solid var(--contrast-main-color);
  outline-offset: 2px;
}
.bookshelf-reset {
  justify-self: start;
  border: 1px solid var(--contrast-border-color);
  color: var(--contrast-main-color);
}
@media (max-width: 480px) {
  .bookshelf-texture-choice {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
}
.geist {
  font-family: 'Geist', sans-serif;
}

.roboto-mono {
  font-family: 'Roboto Mono', monospace;
}
</style>
