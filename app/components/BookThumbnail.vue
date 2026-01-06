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
        /** Lock the aspect ratio to 3:2 */
        lockAspectRatio?: boolean;
    }>(),
    {
        to: undefined,
        showAuthor: true,
        class: "",
        lockAspectRatio: false,
    },
);

const coverSrc = computed(() => {
    const p = props.book.coverImagePath;
    if (!p) return null;

    // Cover storage model:
    // - DB normally points to `.../thumb.webp` for list/grid usage
    // - Older data (or some imports) may point to a source cover like `.../cover.jpg` or `.../cover.source.jpg`
    // In those cases, prefer serving a sibling `thumb.webp` to keep list/grid views lightweight.
    const normalized = p.replace(/\\/g, "/");

    const base = normalized.replace(/^library\//, "");
    const lastSlash = base.lastIndexOf("/");
    const dir = lastSlash >= 0 ? base.slice(0, lastSlash) : "";
    const thumbRel = (dir ? `${dir}/` : "") + "thumb.webp";

    const looksLikeSourceCover =
        /\/cover\.(jpe?g|png|webp|gif|svg)$/i.test(normalized) ||
        /\/cover\.source\.[^/]+$/i.test(normalized) ||
        /\/source\.[^/]+$/i.test(normalized);

    if (looksLikeSourceCover) {
        return `/api/media/covers/${thumbRel}`;
    }

    // API expects: /api/media/covers/<path under library>
    return `/api/media/covers/${base}`;
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
                :title="props.book.title"
                class="cursor-pointer"
                :class="lockAspectRatio ? 'aspect-2/3' : ''"
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
