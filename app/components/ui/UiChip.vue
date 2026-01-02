<script setup lang="ts">
type Props = {
    label: string;
};

const props = defineProps<Props>();

const emit = defineEmits(["remove"]);
</script>

<template>
    <div
        class="inline-flex items-center gap-2 px-2 py-1 rounded-md border border-(--sub-color) text-sm"
    >
        <span class="truncate max-w-60">
            {{ props.label }}
        </span>
        <button
            type="button"
            class="opacity-70 hover:opacity-100 hover:bg-(--bg-color)!"
            aria-label="Remove tag"
            @click.stop="emit('remove')"
        >
            <icon name="lucide:x" class="scale-110" />
        </button>
    </div>
</template>
