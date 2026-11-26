<script setup lang="ts">
import {
  CARD_ART_LABELS,
  CARD_ART_STYLES,
  type CardArtStyle,
} from '~/utils/dashboardArt';

const artStyle = defineModel<CardArtStyle>({ required: true });
</script>

<template>
  <label class="flex items-center gap-2 text-sm">
    <span class="whitespace-nowrap text-(--contrast-sub-color)"
      >Card style</span
    >
    <select
      v-model="artStyle"
      class="rounded-md border border-(--contrast-border-color) bg-(--bg-color) px-2 py-1.5 text-(--contrast-main-color)"
    >
      <option v-for="style in CARD_ART_STYLES" :key="style" :value="style">
        {{ CARD_ART_LABELS[style] }}
      </option>
    </select>
  </label>
</template>
