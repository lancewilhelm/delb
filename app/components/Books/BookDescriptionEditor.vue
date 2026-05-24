<script setup lang="ts">
import Link from '@tiptap/extension-link';
import StarterKit from '@tiptap/starter-kit';
import { EditorContent, useEditor } from '@tiptap/vue-3';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
  }>(),
  {
    modelValue: '',
    placeholder: 'Description',
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

type EditorMode = 'rich' | 'html';
type HtmlEditor = {
  getHTML: () => string;
  isEmpty: boolean;
};

const mode = ref<EditorMode>('rich');

function normalizeModelValue(value: string | null | undefined) {
  return (value ?? '').toString();
}

function getEditorHtml(editor: HtmlEditor | null | undefined) {
  if (!editor || editor.isEmpty) return '';
  return editor.getHTML();
}

function syncFromEditor(editor: HtmlEditor) {
  const html = getEditorHtml(editor);
  if (html === props.modelValue) return;
  emit('update:modelValue', html);
}

function normalizeLinkInput(input: string) {
  const value = input.trim();
  if (!value) return '';

  const lower = value.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:')) return '';

  if (
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    value.startsWith('/') ||
    value.startsWith('#')
  ) {
    return value;
  }

  return `https://${value}`;
}

const editor = useEditor({
  content: normalizeModelValue(props.modelValue),
  extensions: [
    StarterKit.configure({
      heading: {
        levels: [2, 3],
      },
    }),
    Link.configure({
      autolink: true,
      linkOnPaste: true,
      openOnClick: false,
    }),
  ],
  editorProps: {
    attributes: {
      class:
        'tiptap prose prose-sm max-w-none min-h-36 px-3 py-2 text-(--text-color) focus:outline-none',
    },
  },
  onUpdate: ({ editor }) => {
    syncFromEditor(editor);
  },
});

watch(
  () => props.modelValue,
  (value) => {
    const instance = editor.value;
    if (!instance) return;

    const next = normalizeModelValue(value);
    if (getEditorHtml(instance) === next) return;

    instance.commands.setContent(next, { emitUpdate: false });
  },
);

watch(mode, (nextMode) => {
  if (nextMode !== 'rich') return;
  const instance = editor.value;
  if (!instance) return;

  const next = normalizeModelValue(props.modelValue);
  if (getEditorHtml(instance) === next) return;

  instance.commands.setContent(next, { emitUpdate: false });
});

function setMode(nextMode: EditorMode) {
  mode.value = nextMode;
}

function isActive(name: string, attrs?: Record<string, unknown>) {
  return editor.value?.isActive(name, attrs) ?? false;
}

function focusEditor() {
  editor.value?.chain().focus().run();
}

function toggleParagraph() {
  editor.value?.chain().focus().setParagraph().run();
}

function toggleHeading(level: 2 | 3) {
  editor.value?.chain().focus().toggleHeading({ level }).run();
}

function toggleBold() {
  editor.value?.chain().focus().toggleBold().run();
}

function toggleItalic() {
  editor.value?.chain().focus().toggleItalic().run();
}

function toggleBulletList() {
  editor.value?.chain().focus().toggleBulletList().run();
}

function toggleOrderedList() {
  editor.value?.chain().focus().toggleOrderedList().run();
}

function toggleBlockquote() {
  editor.value?.chain().focus().toggleBlockquote().run();
}

function editLink() {
  const instance = editor.value;
  if (!instance || typeof window === 'undefined') return;

  const previousUrl = instance.getAttributes('link').href ?? '';
  const input = window.prompt('Enter link URL', previousUrl || 'https://');
  if (input === null) return;

  const href = normalizeLinkInput(input);
  if (!href) {
    if (!input.trim()) {
      instance.chain().focus().extendMarkRange('link').unsetLink().run();
    }
    return;
  }

  instance.chain().focus().extendMarkRange('link').setLink({ href }).run();
}

function removeLink() {
  editor.value?.chain().focus().extendMarkRange('link').unsetLink().run();
}

function clearFormatting() {
  editor.value?.chain().focus().unsetAllMarks().clearNodes().run();
}
</script>

<template>
  <div class="grid gap-2">
    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        class="flex-1 sm:flex-none border border-(--sub-color) px-3 py-2 rounded-md transition text-sm"
        :class="
          mode === 'rich'
            ? 'bg-(--main-color)/20'
            : 'hover:bg-(--main-color)/10'
        "
        :aria-pressed="mode === 'rich' ? 'true' : 'false'"
        @click="setMode('rich')"
      >
        Rich text
      </button>
      <button
        type="button"
        class="flex-1 sm:flex-none border border-(--sub-color) px-3 py-2 rounded-md transition text-sm"
        :class="
          mode === 'html'
            ? 'bg-(--main-color)/20'
            : 'hover:bg-(--main-color)/10'
        "
        :aria-pressed="mode === 'html' ? 'true' : 'false'"
        @click="setMode('html')"
      >
        HTML
      </button>
    </div>

    <div v-if="mode === 'rich'" class="grid gap-2">
      <ClientOnly>
        <div class="grid gap-2">
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="description-toolbar-btn"
              :class="isActive('paragraph') ? 'description-toolbar-btn-active' : ''"
              title="Paragraph"
              @mousedown.prevent="toggleParagraph"
            >
              P
            </button>
            <button
              type="button"
              class="description-toolbar-btn"
              :class="
                isActive('heading', { level: 2 })
                  ? 'description-toolbar-btn-active'
                  : ''
              "
              title="Heading 2"
              @mousedown.prevent="toggleHeading(2)"
            >
              H2
            </button>
            <button
              type="button"
              class="description-toolbar-btn"
              :class="
                isActive('heading', { level: 3 })
                  ? 'description-toolbar-btn-active'
                  : ''
              "
              title="Heading 3"
              @mousedown.prevent="toggleHeading(3)"
            >
              H3
            </button>
            <button
              type="button"
              class="description-toolbar-btn"
              :class="isActive('bold') ? 'description-toolbar-btn-active' : ''"
              title="Bold"
              @mousedown.prevent="toggleBold"
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              class="description-toolbar-btn"
              :class="
                isActive('italic') ? 'description-toolbar-btn-active' : ''
              "
              title="Italic"
              @mousedown.prevent="toggleItalic"
            >
              <em>I</em>
            </button>
            <button
              type="button"
              class="description-toolbar-btn"
              :class="
                isActive('bulletList') ? 'description-toolbar-btn-active' : ''
              "
              title="Bullet list"
              @mousedown.prevent="toggleBulletList"
            >
              UL
            </button>
            <button
              type="button"
              class="description-toolbar-btn"
              :class="
                isActive('orderedList') ? 'description-toolbar-btn-active' : ''
              "
              title="Numbered list"
              @mousedown.prevent="toggleOrderedList"
            >
              OL
            </button>
            <button
              type="button"
              class="description-toolbar-btn"
              :class="
                isActive('blockquote') ? 'description-toolbar-btn-active' : ''
              "
              title="Blockquote"
              @mousedown.prevent="toggleBlockquote"
            >
              Quote
            </button>
            <button
              type="button"
              class="description-toolbar-btn"
              :class="isActive('link') ? 'description-toolbar-btn-active' : ''"
              title="Add or edit link"
              @mousedown.prevent="editLink"
            >
              Link
            </button>
            <button
              type="button"
              class="description-toolbar-btn"
              title="Remove link"
              @mousedown.prevent="removeLink"
            >
              Unlink
            </button>
            <button
              type="button"
              class="description-toolbar-btn"
              title="Clear formatting"
              @mousedown.prevent="clearFormatting"
            >
              Clear
            </button>
          </div>

          <div
            class="description-editor-shell rounded-md border border-(--sub-color) bg-(--bg-color) overflow-y-auto"
            @click="focusEditor"
          >
            <EditorContent :editor="editor" />
          </div>
        </div>

        <template #fallback>
          <textarea
            :value="modelValue"
            class="w-full h-52 max-h-52 overflow-y-auto px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) resize-y"
            :placeholder="placeholder"
            @input="
              emit(
                'update:modelValue',
                (($event.target as HTMLTextAreaElement | null)?.value ?? ''),
              )
            "
          />
        </template>
      </ClientOnly>
    </div>

    <div v-else class="grid gap-2">
      <div class="text-xs opacity-70">
        Source edit mode for legacy or unusual markup.
      </div>
      <textarea
        :value="modelValue"
        class="w-full h-52 max-h-52 overflow-y-auto px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) font-mono text-sm resize-y"
        :placeholder="placeholder"
        @input="
          emit(
            'update:modelValue',
            (($event.target as HTMLTextAreaElement | null)?.value ?? ''),
          )
        "
      />
    </div>
  </div>
</template>

<style scoped>
.description-toolbar-btn {
  align-items: center;
  background: color-mix(in srgb, var(--bg-color) 100%, transparent);
  border: 1px solid var(--sub-color);
  border-radius: 0.375rem;
  cursor: pointer;
  display: inline-flex;
  font-size: 0.875rem;
  gap: 0.375rem;
  justify-content: center;
  min-height: 2.25rem;
  min-width: 2.25rem;
  padding: 0.5rem 0.75rem;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}

.description-toolbar-btn:hover {
  background: color-mix(in srgb, var(--main-color) 10%, var(--bg-color));
}

.description-toolbar-btn-active {
  background: color-mix(in srgb, var(--main-color) 20%, var(--bg-color));
  border-color: color-mix(in srgb, var(--main-color) 50%, var(--sub-color));
}

.description-editor-shell {
  max-height: 13rem;
}

:deep(.tiptap) {
  min-height: 9rem;
  white-space: pre-wrap;
}

:deep(.tiptap),
:deep(.tiptap p),
:deep(.tiptap li),
:deep(.tiptap blockquote) {
  font-weight: 400;
  line-height: 1.55;
}

:deep(.tiptap p),
:deep(.tiptap ul),
:deep(.tiptap ol),
:deep(.tiptap blockquote) {
  margin: 0.75rem 0;
}

:deep(.tiptap > :first-child) {
  margin-top: 0;
}

:deep(.tiptap > :last-child) {
  margin-bottom: 0;
}

:deep(.tiptap h2) {
  font-size: 1.35rem;
  font-weight: 700;
  line-height: 1.3;
  margin: 1rem 0 0.5rem;
}

:deep(.tiptap h3) {
  font-size: 1.12rem;
  font-weight: 700;
  line-height: 1.35;
  margin: 0.9rem 0 0.5rem;
}

:deep(.tiptap ul),
:deep(.tiptap ol) {
  padding-left: 1.5rem;
}

:deep(.tiptap ul) {
  list-style: disc;
}

:deep(.tiptap ol) {
  list-style: decimal;
}

:deep(.tiptap blockquote) {
  border-left: 3px solid color-mix(in srgb, var(--main-color) 40%, var(--sub-color));
  opacity: 0.85;
  padding-left: 0.9rem;
}

:deep(.tiptap strong) {
  color: color-mix(in srgb, var(--text-color) 92%, black);
  font-weight: 800;
}

:deep(.tiptap em) {
  font-style: italic;
}

:deep(.tiptap a) {
  color: var(--main-color);
  text-decoration: underline;
}

:deep(.tiptap:focus) {
  outline: none;
}
</style>
