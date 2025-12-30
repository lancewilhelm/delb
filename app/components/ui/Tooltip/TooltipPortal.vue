<script setup lang="ts">
type Props = {
    open: boolean;
    text: string;
    /**
     * Tooltip position in viewport coordinates (pixels).
     * This should be the top-left anchor used by the tooltip element, and is
     * applied via CSS variables consumed by `.tooltip` styles.
     */
    x: number;
    y: number;
    /**
     * Optional id used for aria-describedby.
     */
    id?: string;
};

withDefaults(defineProps<Props>(), {
    id: undefined,
});
</script>

<template>
    <Teleport to="body">
        <div
            v-show="open"
            :id="id"
            class="tooltip"
            role="tooltip"
            :data-state="open ? 'open' : 'closed'"
            :style="{
                '--tooltip-x': `${x}px`,
                '--tooltip-y': `${y}px`,
            }"
        >
            <div class="tooltip-content">
                {{ text }}
            </div>
        </div>
    </Teleport>
</template>
