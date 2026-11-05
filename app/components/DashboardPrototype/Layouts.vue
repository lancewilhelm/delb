<script setup lang="ts">
// Throwaway study: three close alternatives on /?variant=A, B, or C.
import Stats from './Stats.vue';
import Reading from './Reading.vue';

defineProps<{
  variant: string;
  displayName: string;
  collectionName: string;
  counts: {
    total: number;
    reading: number;
    to_be_read: number;
    finished: number;
    dnf: number;
    none: number;
  } | null;
  books: {
    id: string;
    title: string;
    coverImagePath?: string | null;
    progress?: number | null;
  }[];
}>();
</script>

<template>
  <main class="dashboard-study" :class="`dashboard-study-${variant}`">
    <template v-if="variant === 'A'">
      <header class="study-greeting centered">
        <h1>Hello, {{ displayName }}.</h1>
        <p>
          Collection: <span>{{ collectionName }}</span>
        </p>
      </header>
      <Stats :counts="counts" mode="cards" />
      <Reading :books="books" />
    </template>

    <template v-else-if="variant === 'B'">
      <header class="study-greeting">
        <h1>Hello, {{ displayName }}.</h1>
        <p>
          Collection: <span>{{ collectionName }}</span>
        </p>
      </header>
      <div class="study-columns">
        <section class="study-overview" aria-label="Library overview">
          <h2>Your library</h2>
          <Stats :counts="counts" mode="list" />
        </section>
        <Reading :books="books" />
      </div>
    </template>

    <template v-else>
      <header class="study-greeting compact">
        <h1>Hello, {{ displayName }}.</h1>
        <p>
          Collection: <span>{{ collectionName }}</span>
        </p>
      </header>
      <Reading :books="books" />
      <Stats :counts="counts" mode="rail" />
    </template>
  </main>
</template>

<style>
.dashboard-study {
  box-sizing: border-box;
  width: min(100%, 900px);
  margin: auto;
  padding: 48px 28px 110px;
  color: var(--text-color);
  display: flex;
  flex-direction: column;
  gap: 32px;
}

.dashboard-study * {
  box-sizing: border-box;
}

.study-greeting h1 {
  margin: 0;
  font:
    300 42px/1.2 Georgia,
    'Times New Roman',
    serif;
  letter-spacing: -1px;
}

.study-greeting p {
  margin: 12px 0 0;
  font-size: 14px;
  opacity: 0.7;
}

.study-greeting p span {
  font-weight: 500;
}

.study-greeting.centered {
  text-align: center;
}

.dashboard-study h2 {
  margin: 0;
  font:
    600 16px/1.5 'Geist',
    system-ui,
    sans-serif;
}

.dashboard-study-B {
  width: min(100%, 1040px);
  gap: 40px;
}

.study-columns {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 40px;
  align-items: start;
}

.study-overview > h2 {
  margin-bottom: 18px;
}

.dashboard-study-C {
  width: min(100%, 1000px);
  gap: 36px;
}

.study-greeting.compact {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.study-greeting.compact h1 {
  font-size: 32px;
}

.study-greeting.compact p {
  margin: 0;
}

@media (max-width: 700px) {
  .dashboard-study {
    padding: 32px 20px 120px;
    gap: 28px;
  }

  .study-greeting h1 {
    font-size: 36px;
  }

  .study-columns {
    grid-template-columns: minmax(0, 1fr);
    gap: 28px;
  }

  .study-greeting.compact {
    display: block;
  }

  .study-greeting.compact p {
    margin-top: 10px;
  }
}
</style>
