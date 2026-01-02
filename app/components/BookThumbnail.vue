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
            <BookCover
                :src="coverSrc"
                :alt="`Cover for ${props.book.title}`"
                class="cursor-pointer"
                @click="navigateTo(`/books/${props.book.id}`)"
            />

            <div class="flex flex-col">
                <HoverScrollText
                    ><span
                        class="cursor-pointer hover:underline"
                        @click="navigateTo(`/books/${props.book.id}`)"
                        >{{ props.book.title }}
                    </span>
                </HoverScrollText>

                <HoverScrollText
                    v-if="props.showAuthor && authorLabel"
                    class="opacity-70 cursor-pointer"
                    ><span v-for="(a, index) in book.authors" :key="a.id">
                        <span
                            class="cursor-pointer hover:underline"
                            @click="navigateTo(`/authors/${a.id}`)"
                        >
                            {{ a.name }}
                        </span>
                        <span
                            v-if="
                                book.authors && index < book.authors.length - 1
                            "
                            >,
                        </span>
                    </span>
                </HoverScrollText>
            </div>
        </div>
    </div>
</template>
