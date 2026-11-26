<script setup lang="ts">
import { useShareCardStore } from '~/stores/shareCard';

const store = useShareCardStore();
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-x-0 bottom-4 z-140 flex justify-center px-4 pointer-events-none"
      aria-live="polite"
    >
      <Transition
        enter-from-class="opacity-0 translate-y-2"
        enter-active-class="transition duration-200"
        leave-to-class="opacity-0 translate-y-2"
        leave-active-class="transition duration-150"
      >
        <div
          v-if="store.toast"
          :key="store.toast.id"
          role="status"
          class="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-1 max-w-[min(36rem,100%)] px-4 py-2.5 rounded-lg border border-(--contrast-border-color) bg-(--bg-color) text-(--contrast-text-color) shadow-lg"
          @mouseenter="store.holdToast()"
          @mouseleave="store.releaseToast()"
          @focusin="store.holdToast()"
          @focusout="store.releaseToast()"
        >
          <Icon
            name="lucide:party-popper"
            class="w-4 h-4 shrink-0 text-(--contrast-main-color)"
          />
          <span class="min-w-0 truncate">
            Finished <em class="font-semibold">{{ store.toast.title }}</em>
          </span>
          <button
            type="button"
            class="flex items-center gap-1 font-semibold text-(--contrast-main-color) hover:underline"
            @click="store.open(store.toast.bookId)"
          >
            <Icon name="lucide:share-2" class="w-4 h-4" />
            Share card
          </button>
          <button
            type="button"
            class="text-xs opacity-70 underline hover:opacity-100"
            @click="store.stopAsking()"
          >
            Don't ask again
          </button>
          <button
            type="button"
            class="p-0.5 rounded hover:bg-(--sub-alt-color)"
            aria-label="Dismiss"
            @click="store.dismissToast()"
          >
            <Icon name="lucide:x" class="w-4 h-4" />
          </button>
        </div>
      </Transition>
    </div>
  </Teleport>
</template>
