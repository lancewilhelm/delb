<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import DashboardArtMenu from '~/components/Dashboard/DashboardArtMenu.vue';
import DashboardTileArt from '~/components/Dashboard/DashboardTileArt.vue';
import {
  CARD_ART_LABELS,
  CARD_ART_STYLES,
  displayedCardArt,
  type CardArtStyle,
} from '~/utils/dashboardArt';

const props = defineProps<{
  /** Settings key for this tile's art override (`reading`, `shelf:<id>`, …). */
  listKey: string;
  title: string;
  count: number;
  line: string;
  books: {
    id: string;
    title: string;
    coverImagePath?: string | null;
    updatedAt?: string;
    finishedDate?: string | null;
  }[];
  to: RouteLocationRaw;
  /** The tile's chosen art style (override, default, or Auto). */
  artStyle: CardArtStyle;
  /** Whether the tile has its own override (enables "Use default"). */
  overridden: boolean;
  /** CSS color for the tag dot and the window tint. */
  tone: string;
  tag: string;
  dimmed?: boolean;
}>();

const emit = defineEmits<{
  (e: 'set-art', style: CardArtStyle | null): void;
}>();

const artOptions = CARD_ART_STYLES.map((style) => ({
  value: style,
  label: CARD_ART_LABELS[style],
}));
const shownStyle = computed(() =>
  displayedCardArt(props.artStyle, props.books.length),
);
const hasArt = computed(() => props.count > 0 && props.books.length > 0);
</script>

<template>
  <div
    class="dash-tile"
    :class="{ 'is-empty': !hasArt, 'is-dimmed': dimmed }"
    :style="{ '--tone': tone }"
  >
    <RouterLink :to="to" class="dash-tile-link">
      <span class="dash-tile-window" :class="`shows-${shownStyle}`">
        <span v-if="hasArt" class="dash-tile-art" aria-hidden="true">
          <DashboardTileArt
            :art-style="shownStyle"
            :books="books"
            :seed="listKey"
          />
        </span>
        <svg
          v-else
          class="dash-tile-empty"
          viewBox="0 0 48 48"
          aria-hidden="true"
        >
          <rect x="12" y="7" width="24" height="34" rx="2" />
          <path d="M16 7v34M21 16h10M21 21h7" />
        </svg>
        <span v-if="hasArt" class="dash-tile-tag" aria-hidden="true"
          ><i></i>{{ tag }}</span
        >
      </span>
      <span class="dash-tile-name">
        <span class="dash-tile-title">{{ title }}</span>
        <span class="dash-tile-count">{{ count.toLocaleString() }}</span>
      </span>
      <span class="dash-tile-line">{{ line }}</span>
    </RouterLink>

    <DashboardArtMenu
      v-if="hasArt"
      :label="`Card art for ${title}`"
      :options="artOptions"
      :value="artStyle"
      resettable
      :can-reset="overridden"
      @choose="emit('set-art', $event)"
    />
  </div>
</template>

<style scoped>
.dash-tile {
  position: relative;
  min-width: 0;
}
.dash-tile-link {
  display: block;
  color: inherit;
  text-decoration: none;
  border-radius: 14px;
}
.dash-tile-link:focus-visible {
  outline: 2px solid var(--main-color);
  outline-offset: 4px;
}
.dash-tile-window {
  position: relative;
  display: block;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--sub-color) 32%, transparent);
  background: radial-gradient(
    120% 90% at 50% 0%,
    color-mix(in srgb, var(--tone) 20%, var(--dash-tile-bg)),
    var(--dash-tile-bg)
  );
  transition:
    transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1),
    box-shadow 0.25s;
}
.dash-tile-art {
  position: absolute;
  inset: 0;
  /* Its own stacking layer: cover z-indexes (fan, stack, pile) stay below
     the tag and the ⋯ menu whether or not the tile is hovered. */
  isolation: isolate;
}
.is-dimmed .dash-tile-art {
  filter: grayscale(0.85) brightness(0.88);
}
.is-empty .dash-tile-window {
  display: grid;
  place-items: center;
  background: transparent;
  border: 1.5px dashed color-mix(in srgb, var(--sub-color) 60%, transparent);
}
.dash-tile-empty {
  width: 44%;
  fill: none;
  stroke: var(--contrast-sub-color);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.8;
}
.dash-tile-tag {
  position: absolute;
  left: 8px;
  top: 8px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px;
  border-radius: 99px;
  font-size: 10.5px;
  font-weight: 600;
  background: color-mix(in srgb, var(--bg-color) 78%, transparent);
  backdrop-filter: blur(6px);
}
.dash-tile-tag i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--tone);
}
.dash-tile-name {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  margin-top: 10px;
  font-size: 14px;
  font-weight: 600;
}
.dash-tile-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dash-tile-count {
  font-weight: 400;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--contrast-sub-color);
}
.dash-tile-line {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--contrast-sub-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.is-empty .dash-tile-name,
.is-empty .dash-tile-line {
  opacity: 0.65;
}

/* The ⋯ menu shows on hover/focus; touch screens always show it. */
@media (hover: hover) {
  .dash-tile :deep(.art-menu-trigger) {
    opacity: 0;
  }
  .dash-tile:hover :deep(.art-menu-trigger),
  .dash-tile:focus-within :deep(.art-menu-trigger),
  .dash-tile :deep(.art-menu.is-open .art-menu-trigger) {
    opacity: 1;
  }
}

@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  .dash-tile-link:hover .dash-tile-window {
    transform: translateY(-3px);
    box-shadow: 0 14px 30px rgb(0 0 0 / 0.25);
  }
  .dash-tile-link:hover :deep(.fan-item) {
    transform: rotate(calc(var(--r) * 1.35));
  }
  .dash-tile-link:hover :deep(.stack-item) {
    transform: translateX(calc(var(--dx) * 0.7)) rotate(calc(var(--r) * 1.8));
  }
  .dash-tile-link:hover :deep(.shelf-spine:not(.lean)) {
    transform: translateY(-3cqh);
  }
  .dash-tile-link:hover :deep(.wall) {
    transform: translate(-50%, -50%) rotate(-12deg) scale(1.05);
  }
}
</style>
