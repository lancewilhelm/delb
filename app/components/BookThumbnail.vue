<script setup lang="ts">
defineOptions({ name: "BookThumbnail" });

type BookThumb = {
    id: string;
    title: string;

    coverImagePath?: string | null;

    // Optional: used for subtitle display
    authors?: { id: string; name: string }[];
    authorNames?: string[];
    author?: string;

    // Optional: used by other views (not displayed by default)
    publisher?: { id: string; name: string } | null;
    series?: { id: string; name: string } | null;
};

const props = withDefaults(
    defineProps<{
        book: BookThumb;
        /** Override the link destination. Defaults to `/books/<id>` */
        to?: string;
        /** Show the author line (if present in `book`). Default: true */
        showAuthor?: boolean;
        /** Additional classes for the outer wrapper */
        class?: string;
    }>(),
    {
        to: undefined,
        showAuthor: true,
        class: "",
    },
);

const resolvedTo = computed(() => props.to ?? `/books/${props.book.id}`);

const coverSrc = computed(() => {
    const p = props.book.coverImagePath;
    if (!p) return null;

    // Stored as: library/<...>/cover.webp (or similar)
    // API expects: /api/media/covers/<path under library>
    return `/api/media/covers/${p.replace(/^library\//, "")}`;
});

const authorLabel = computed(() => {
    const b = props.book;

    if (Array.isArray(b.authors) && b.authors.length > 0) {
        return b.authors
            .map((a) => a.name)
            .filter(Boolean)
            .join(", ");
    }

    if (Array.isArray(b.authorNames) && b.authorNames.length > 0) {
        return b.authorNames.filter(Boolean).join(", ");
    }

    return b.author ?? "";
});
</script>

<template>
    <div :class="['w-43', props.class]">
        <div class="flex flex-col gap-1">
            <NuxtLink :to="resolvedTo">
                <BookCover
                    :src="coverSrc"
                    :alt="`Cover for ${props.book.title}`"
                    class="cursor-pointer"
                />
            </NuxtLink>

            <div class="flex flex-col">
                <NuxtLink :to="resolvedTo" class="flex">
                    <HoverScrollText>{{ props.book.title }}</HoverScrollText>
                </NuxtLink>

                <HoverScrollText
                    v-if="props.showAuthor && authorLabel"
                    class="opacity-70"
                >
                    {{ authorLabel }}
                </HoverScrollText>
            </div>
        </div>
    </div>
</template>
