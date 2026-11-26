<script setup lang="ts">
import DashboardListTile from '~/components/Dashboard/DashboardListTile.vue';
import type { BrowseCardPage, BrowseCardRow } from '~/utils/browseCards';
import type { CardArtStyle } from '~/utils/dashboardArt';

defineProps<{
  page: BrowseCardPage;
  rows: BrowseCardRow[];
  artStyle: CardArtStyle;
}>();

const emit = defineEmits<{
  (e: 'card-contextmenu', event: MouseEvent, row: BrowseCardRow): void;
  (e: 'card-keydown', event: KeyboardEvent, row: BrowseCardRow): void;
}>();
</script>

<template>
  <div
    class="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))]"
  >
    <DashboardListTile
      v-for="row in rows"
      :key="row.id"
      :list-key="`${page}:${row.id}`"
      :title="row.name"
      :count="row.bookCount"
      :books="row.books ?? []"
      :to="`/${page}/${encodeURIComponent(row.id)}`"
      :link-label="`View ${row.name}`"
      :art-style="artStyle"
      @contextmenu="emit('card-contextmenu', $event, row)"
      @keydown="emit('card-keydown', $event, row)"
    />
  </div>
</template>
