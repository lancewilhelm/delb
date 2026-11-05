<script setup lang="ts">
defineProps<{
  books: {
    id: string;
    title: string;
    coverImagePath?: string | null;
    progress?: number | null;
  }[];
}>();
</script>

<template>
  <section class="study-reading">
    <div class="study-reading-heading">
      <h2>Continue reading</h2>
      <NuxtLink to="/books?status=reading">View all</NuxtLink>
    </div>
    <p v-if="!books.length" class="study-reading-empty">
      No books marked as Reading.
    </p>
    <div v-else class="study-reading-shelf">
      <div v-for="book in books" :key="book.id" class="study-reading-book">
        <BookThumbnail :book="book" :lock-aspect-ratio="true" />
        <div class="study-reading-progress">
          {{
            typeof book.progress === 'number'
              ? `${book.progress.toFixed(1)}%`
              : '—'
          }}
        </div>
      </div>
    </div>
  </section>
</template>

<style>
.study-reading {
  min-width: 0;
}

.study-reading-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.study-reading-heading a {
  color: inherit;
  font-size: 12px;
  text-decoration: none;
  opacity: 0.7;
}

.study-reading-heading a:hover {
  opacity: 1;
  text-decoration: underline;
}

.study-reading-shelf {
  display: flex;
  gap: 20px;
  overflow-x: auto;
  padding-bottom: 10px;
}

.study-reading-book {
  width: 140px;
  min-width: 0;
  flex-shrink: 0;
}

.study-reading-progress,
.study-reading-empty {
  margin-top: 8px;
  font-size: 12px;
  line-height: 18px;
  opacity: 0.65;
}

@media (max-width: 700px) {
  .study-reading-book {
    width: 128px;
  }

  .study-reading-shelf {
    gap: 16px;
  }
}
</style>
