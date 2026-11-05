// Export the actual throwaway Vue layouts as a portable, offline sample.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const nuxtRequire = createRequire(import.meta.resolve('nuxt'));
const { parse, compileScript } = nuxtRequire('vue/compiler-sfc');
const icons = JSON.parse(
  await readFile(
    new URL('../node_modules/@iconify-json/lucide/icons.json', import.meta.url),
    'utf8',
  ),
);
const iconNames = [
  'library',
  'book-open',
  'bookmark',
  'check',
  'ban',
  'circle-dashed',
  'search',
  'command',
  'settings',
  'book-plus',
  'folder',
  'chevron-down',
];
const iconBodies = Object.fromEntries(
  iconNames.map((name) => [name, icons.icons[name].body]),
);
const styles = [];

const result = await build({
  stdin: {
    resolveDir: root,
    loader: 'js',
    contents: `
import { createApp, computed, defineComponent, h, ref } from 'vue';
import Layouts from './app/components/DashboardPrototype/Layouts.vue';
import Switcher from './app/components/DashboardPrototype/Switcher.vue';

const iconBodies = ${JSON.stringify(iconBodies)};
const Icon = defineComponent({
  props: ['name'],
  setup: (props) => () => h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', innerHTML: iconBodies[props.name?.replace('lucide:', '')] ?? '', 'aria-hidden': 'true' }),
});

const books = [
  { id: '1', title: 'The Left Hand of Darkness', progress: 64.2, author: 'Ursula K. Le Guin', color: '#69858a', ink: '#f0eee4' },
  { id: '2', title: 'Meditations', progress: 27.5, author: 'Marcus Aurelius', color: '#bbab8c', ink: '#33342d' },
  { id: '3', title: 'A Walk in the Woods', progress: 81.0, author: 'Bill Bryson', color: '#657665', ink: '#f0eee4' },
];
const counts = { total: 248, reading: 3, to_be_read: 42, finished: 156, dnf: 7, none: 40 };

const BookThumbnail = defineComponent({
  props: ['book'],
  setup: (props) => () => h('div', { class: 'sample-thumbnail' }, [
    h('div', { class: 'sample-cover', style: { background: props.book.color, color: props.book.ink } }, [
      h('span', { class: 'sample-cover-author' }, props.book.author),
      h('span', { class: 'sample-cover-title' }, props.book.title),
      h('span', { class: 'sample-cover-mark', 'aria-hidden': 'true' }, '◯'),
    ]),
    h('span', { class: 'sample-book-title', title: props.book.title }, props.book.title),
  ]),
});

const App = defineComponent({
  setup() {
    const params = new URLSearchParams(location.search);
    const initial = params.get('variant') ?? document.documentElement.dataset.variant;
    const variant = ref(['A', 'B', 'C', 'D', 'E', 'F'].includes(initial) ? initial : 'A');
    const scenario = ref(document.documentElement.dataset.scenario ?? 'normal');
    const light = ref(document.documentElement.dataset.appearance === 'light');
    const notice = ref('');
    function select(next) {
      variant.value = next;
      const url = new URL(location.href);
      url.searchParams.set('variant', next);
      try { history.replaceState(null, '', url); } catch { /* Sandboxed inline previews keep state in memory. */ }
    }
    const sampleBooks = computed(() => scenario.value === 'empty' ? [] : scenario.value === 'many'
      ? Array.from({ length: 9 }, (_, index) => ({ ...books[index % books.length], id: String(index) })) : books);
    const sampleCounts = computed(() => scenario.value === 'empty'
      ? { total: 0, reading: 0, to_be_read: 0, finished: 0, dnf: 0, none: 0 }
      : { ...counts, reading: sampleBooks.value.length, total: counts.total + sampleBooks.value.length - books.length });
    return () => h('div', { class: ['sample-root', { 'sample-light': light.value }], onClick(event) {
      if (event.target.closest('a')) { event.preventDefault(); notice.value = 'Sample preview. In Delb, this opens the matching books.'; }
    } }, [
      h('header', { class: 'sample-header' }, [
        h('div', { class: 'sample-brand' }, [h('strong', 'Delb'), h(Icon, { name: 'lucide:folder' }), h('span', 'Personal'), h(Icon, { name: 'lucide:chevron-down' }), h(Icon, { name: 'lucide:book-plus' })]),
        h('div', { class: 'sample-header-actions', 'aria-hidden': 'true' }, ['search', 'command', 'settings'].map((name) => h(Icon, { name: 'lucide:' + name }))),
      ]),
      h('nav', { class: 'sample-nav', 'aria-label': 'Current app navigation' }, ['Dashboard', 'Books', 'Authors', 'Series', 'Publishers', 'Tags'].map((name) => h('span', { class: name === 'Dashboard' ? 'active' : '' }, name))),
      h('div', { class: 'sample-tools' }, [
        h('label', ['Sample data ', h('select', { value: scenario.value, onChange: (event) => { scenario.value = event.target.value; notice.value = ''; } }, ['normal', 'empty', 'many'].map((value) => h('option', { value }, { normal: '3 reading', empty: 'Empty library', many: '9 reading' }[value])))]),
        h('button', { type: 'button', onClick: () => { light.value = !light.value; }, 'aria-pressed': light.value }, light.value ? 'Dark preview' : 'Light preview'),
      ]),
      notice.value ? h('p', { class: 'sample-notice', role: 'status' }, notice.value) : null,
      h(Layouts, { variant: variant.value, displayName: 'Lance', collectionName: 'Personal', counts: sampleCounts.value, books: sampleBooks.value, initialShelf: document.documentElement.dataset.shelf ?? 'reading' }),
      h(Switcher, { current: variant.value, includeCurrent: false, onSelect: select }),
    ]);
  },
});
const app = createApp(App);
app.component('Icon', Icon);
app.component('NuxtLink', defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }));
app.component('BookThumbnail', BookThumbnail);
app.mount('#app');
`,
  },
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
  define: {
    'process.env.NODE_ENV': '"production"',
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  alias: { vue: nuxtRequire.resolve('vue/dist/vue.runtime.esm-bundler.js') },
  plugins: [
    {
      name: 'throwaway-vue-layouts',
      setup(builder) {
        builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
          const { descriptor } = parse(await readFile(filename, 'utf8'), {
            filename,
          });
          styles.push(...descriptor.styles.map((style) => style.content));
          const compiled = compileScript(descriptor, {
            id: filename,
            inlineTemplate: true,
          });
          return {
            contents: compiled.content,
            loader: 'ts',
            resolveDir: path.dirname(filename),
          };
        });
      },
    },
  ],
});

const html = `<!doctype html>
<html lang="en" data-variant="A"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Delb dashboard layout study</title><style>
:root { color-scheme: dark; }
html, body { margin: 0; font: 14px/1.5 var(--font-sans, 'Geist', system-ui, sans-serif); }
body > #app { background: transparent; }
button, select { font: inherit; }
button { cursor: pointer; }
.sample-root { --bg-color: var(--background, #1b1b1b); --text-color: var(--foreground, #dddddd); --main-color: var(--foreground, #dddddd); --sub-color: var(--border, #555555); --sub-alt-color: var(--secondary, #252525); color: var(--text-color); }
.sample-light { color-scheme: light; --text-color: #1b1b1b; --main-color: #1b1b1b; --sub-color: #999; --sub-alt-color: #e7e7e7; --bg-color: #f2f2f2; }
.sample-light .dashboard-study, .sample-light .sample-nav, .sample-light .sample-tools, .sample-light .sample-notice { background: #f2f2f2; }
.sample-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; gap: 20px; background: var(--sub-alt-color); border-radius: var(--radius, 8px); }
.sample-brand { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.sample-brand strong { font: 500 22px/1.2 system-ui, sans-serif; margin-right: 8px; }
.sample-brand svg { width: 15px; }
.sample-header-actions { display: flex; gap: 16px; }
.sample-nav { display: flex; flex-wrap: wrap; justify-content: center; border-bottom: 1px solid var(--sub-color); gap: 4px; padding: 4px 0; font-size: 12px; }
.sample-nav span { padding: 3px 8px; opacity: .7; }
.sample-nav .active { background: color-mix(in srgb, var(--sub-color) 20%, transparent); opacity: 1; }
.sample-tools { display: flex; justify-content: flex-end; align-items: center; gap: 12px; padding: 12px 8px 0; font-size: 10px; color: var(--text-color); }
.sample-tools select, .sample-tools button { border: 1px solid var(--sub-color); padding: 4px 6px; border-radius: 4px; color: var(--text-color); background: var(--bg-color); }
.sample-tools label { display: flex; align-items: center; gap: 6px; }
.sample-thumbnail { width: 100%; }
.sample-cover { aspect-ratio: 2/3; border-radius: 5px; padding: 20px 12px 12px; box-shadow: inset 3px 0 5px #0002; display: flex; flex-direction: column; overflow: hidden; position: relative; }
.sample-cover-author { font: 8px/1.5 system-ui, sans-serif; text-transform: uppercase; letter-spacing: 1.3px; }
.sample-cover-title { font: 23px/1.1 Georgia, serif; margin-top: 18px; }
.sample-cover-mark { font: 90px/1 Georgia, serif; margin-top: auto; align-self: center; opacity: .4; }
.sample-book-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 7px; font-size: 12px; }
.sample-notice { font-size: 11px; text-align: center; color: var(--text-color); }
@media (max-width: 420px) { .sample-header-actions { gap: 10px; } .sample-nav { font-size: 11px; gap: 0; } .sample-nav span { padding: 4px 6px; } }
${styles.join('\n')}
</style></head><body><div id="app"></div><script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;

await mkdir(new URL('../.prototype/', import.meta.url), { recursive: true });
await writeFile(new URL('../.prototype/dashboard.html', import.meta.url), html);
await writeFile(
  new URL('../.prototype/dashboard-round-2.html', import.meta.url),
  html
    .replace('data-variant="A"', 'data-variant="D"')
    .replace(
      '<title>Delb dashboard layout study</title>',
      '<title>Delb dashboard layout study · round 2</title>',
    ),
);
console.log(
  'Standalone samples: .prototype/dashboard.html and .prototype/dashboard-round-2.html',
);
console.log(
  'Real reading books: pnpm dev, then http://localhost:3000/?variant=D',
);
