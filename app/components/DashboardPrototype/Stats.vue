<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  counts: {
    total: number;
    reading: number;
    to_be_read: number;
    finished: number;
    dnf: number;
    none: number;
  } | null;
  mode: 'cards' | 'list' | 'rail';
}>();

const stats = computed(() => [
  {
    label: 'All books',
    value: props.counts?.total ?? 0,
    icon: 'library',
    to: '/books',
  },
  {
    label: 'Reading',
    value: props.counts?.reading ?? 0,
    icon: 'book-open',
    to: '/books?status=reading',
  },
  {
    label: 'To be read',
    value: props.counts?.to_be_read ?? 0,
    icon: 'bookmark',
    to: '/books?status=to_be_read',
  },
  {
    label: 'Finished',
    value: props.counts?.finished ?? 0,
    icon: 'check',
    to: '/books?status=finished',
  },
  {
    label: 'DNF',
    value: props.counts?.dnf ?? 0,
    icon: 'ban',
    to: '/books?status=dnf',
  },
  {
    label: 'No status',
    value: props.counts?.none ?? 0,
    icon: 'circle-dashed',
    to: '/books?status=none',
  },
]);
</script>

<template>
  <nav
    class="study-stats"
    :class="`study-stats-${mode}`"
    aria-label="Book counts"
  >
    <NuxtLink
      v-for="stat in stats"
      :key="stat.label"
      :to="stat.to"
      class="study-stat"
    >
      <Icon :name="`lucide:${stat.icon}`" class="study-stat-icon" />
      <span class="study-stat-label">{{ stat.label }}</span>
      <span class="study-stat-value">{{ stat.value.toLocaleString() }}</span>
    </NuxtLink>
  </nav>
</template>

<style>
.study-stats {
  display: grid;
  gap: 12px;
}

.study-stat {
  color: inherit;
  text-decoration: none;
  border: 1px solid var(--sub-color);
  border-radius: 8px;
  padding: 17px 18px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 18px;
  gap: 6px 10px;
  transition: background 120ms;
}

.study-stat:hover {
  background: color-mix(in srgb, var(--sub-color) 12%, transparent);
}

.study-stat:focus-visible,
.study-reading a:focus-visible {
  outline: 2px solid var(--main-color);
  outline-offset: 4px;
}

.study-stat-icon {
  grid-column: 2;
  grid-row: 1;
  width: 16px;
  height: 16px;
  opacity: 0.5;
}

.study-stat-label {
  grid-column: 1;
  grid-row: 1;
  font-size: 12px;
  line-height: 18px;
  opacity: 0.7;
}

.study-stat-value {
  grid-column: 1 / -1;
  font-size: 28px;
  line-height: 32px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.study-stats-cards {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.study-stats-list {
  gap: 0;
}

.study-stats-list .study-stat {
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--sub-color) 55%, transparent);
  border-radius: 0;
  padding: 14px 0;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
}

.study-stats-list .study-stat-icon {
  grid-column: 1;
}

.study-stats-list .study-stat-label {
  grid-column: 2;
  font-size: 13px;
}

.study-stats-list .study-stat-value {
  grid-column: 3;
  grid-row: 1;
  font-size: 18px;
  line-height: 24px;
}

.study-stats-rail {
  grid-template-columns: repeat(6, minmax(0, 1fr));
  border-top: 1px solid var(--sub-color);
  padding-top: 24px;
  gap: 0;
}

.study-stats-rail .study-stat {
  border: 0;
  border-right: 1px solid color-mix(in srgb, var(--sub-color) 55%, transparent);
  border-radius: 0;
  padding: 4px 16px;
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-start;
  gap: 6px;
}

.study-stats-rail .study-stat:first-child {
  padding-left: 0;
}

.study-stats-rail .study-stat:last-child {
  border-right: 0;
}

.study-stats-rail .study-stat-icon {
  display: none;
}

@media (max-width: 700px) {
  .study-stats-rail {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    row-gap: 24px;
  }

  .study-stats-rail .study-stat:nth-child(4) {
    padding-left: 0;
  }

  .study-stats-rail .study-stat:nth-child(3) {
    border-right: 0;
  }
}

@media (max-width: 480px) {
  .study-stats-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
