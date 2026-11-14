import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { ref, toRaw } from 'vue';
import { parseBookshelf } from '../shared/bookshelf.ts';

async function shelfEditor() {
  const raw = await readFile('app/components/Books/BookshelfView.vue', 'utf8');
  const source = raw.slice(raw.indexOf('>') + 1, raw.indexOf('</script>'));
  const ast = ts.createSourceFile(
    'shelf.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const wanted = ['save', 'changed', 'removeShelf', 'removeBookcase'];
  const functions = ast.statements
    .filter(
      (item) =>
        ts.isFunctionDeclaration(item) &&
        wanted.includes(item.name?.text ?? ''),
    )
    .map((item) => item.getText(ast))
    .join('\n');
  const bookcase = (id) => ({
    id,
    width: 340,
    shelves: [
      { id: `${id}-first`, height: 245, items: [] },
      { id: `${id}-second`, height: 245, items: [] },
    ],
  });
  const arrangement = ref({
    bookcases: [bookcase('first'), bookcase('second')],
  });
  const payloads = [];
  const state = {
    arrangement,
    toRaw,
    saving: ref(false),
    dirty: ref(false),
    conflict: ref(false),
    saveError: ref(''),
    notice: ref(''),
    revision: ref(1),
    selectedShelf: ref(null),
    getBookcase: (id) =>
      arrangement.value.bookcases.find((item) =>
        item.shelves.some((shelf) => shelf.id === id),
      ),
    $fetch: async (_url, options) => {
      const parsed = parseBookshelf(options.body.arrangement);
      assert.ok(parsed, 'the saved arrangement must be valid');
      payloads.push(parsed);
      return { revision: 2 };
    },
  };
  const js = ts.transpileModule(functions, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const actions = new Function(
    ...Object.keys(state),
    `let dirtyVersion = 0; ${js}; return {removeShelf, removeBookcase};`,
  )(...Object.values(state));
  return { actions, state, payloads };
}

for (const action of ['removeShelf', 'removeBookcase']) {
  test(`${action} saves the remaining arrangement`, async () => {
    const { actions, state, payloads } = await shelfEditor();
    actions[action](state.arrangement.value.bookcases[0].shelves[0]);
    await new Promise(setImmediate);
    assert.equal(state.saveError.value, '');
    assert.equal(state.dirty.value, false);
    assert.equal(payloads.length, 1);
    assert.equal(
      payloads[0].bookcases.length,
      action === 'removeBookcase' ? 1 : 2,
    );
    if (action === 'removeShelf')
      assert.equal(payloads[0].bookcases[0].shelves.length, 1);
  });
}
