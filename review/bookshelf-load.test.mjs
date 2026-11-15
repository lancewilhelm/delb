import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { ref } from 'vue';

async function matcher() {
  const raw = await readFile('app/components/Books/BookshelfView.vue', 'utf8');
  const source = raw.slice(raw.indexOf('>') + 1, raw.indexOf('</script>'));
  const ast = ts.createSourceFile(
    'shelf.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = ast.statements.find(
    (item) =>
      ts.isFunctionDeclaration(item) && item.name?.text === 'loadMatches',
  );
  assert.ok(declaration);
  const calls = [];
  let request = async () => [{ id: 'b' }];
  const state = {
    props: { endpoint: '/api/books', collectionId: undefined },
    catalog: ref([
      { id: 'a', collectionId: 'one' },
      { id: 'b', collectionId: 'two' },
    ]),
    matches: ref(new Set()),
    notice: ref(''),
    errorText: (error) => error.message,
    fetchAll: (...args) => {
      calls.push(args);
      return request();
    },
  };
  const js = ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const load = new Function(
    ...Object.keys(state),
    `let generation=0; ${js}; return loadMatches;`,
  )(...Object.values(state));
  return {
    state,
    load,
    calls,
    setRequest: (next) => {
      request = next;
    },
  };
}

test('the unfiltered shelf reuses its loaded catalog without another network pass', async () => {
  const { state, load, calls } = await matcher();
  await load();
  assert.deepEqual([...state.matches.value], ['a', 'b']);
  assert.deepEqual(calls, []);
});

test('collection dimming uses the sole collection returned with each catalog entry', async () => {
  const { state, load, calls } = await matcher();
  state.props.collectionId = 'two';
  await load();
  assert.deepEqual([...state.matches.value], ['b']);
  state.props.collectionId = 'missing';
  await load();
  assert.deepEqual([...state.matches.value], []);
  assert.deepEqual(calls, []);
});

test('applied filters still use the authorized endpoint and collection scope', async () => {
  const { state, load, calls } = await matcher();
  state.props.endpoint = '/api/books?status=reading';
  state.props.collectionId = 'two';
  await load();
  assert.deepEqual([...state.matches.value], ['b']);
  assert.deepEqual(calls, [['/api/books?status=reading', 'two']]);
});

test('a late filtered response cannot override cleared filters or a new collection', async () => {
  const { state, load, setRequest } = await matcher();
  const pending = Promise.withResolvers();
  setRequest(() => pending.promise);
  state.props.endpoint = '/api/books?title=old';
  const old = load();
  state.props.endpoint = '/api/books';
  state.props.collectionId = 'one';
  await load();
  pending.resolve([{ id: 'b' }]);
  await old;
  assert.deepEqual([...state.matches.value], ['a']);
});

test('a failed filter read retains the previous matches and reports the error', async () => {
  const { state, load, setRequest } = await matcher();
  await load();
  state.props.endpoint = '/api/books?title=example';
  setRequest(async () => {
    throw Error('Offline');
  });
  await load();
  assert.deepEqual([...state.matches.value], ['a', 'b']);
  assert.match(
    state.notice.value,
    /Could not apply the current filters: Offline/,
  );
});
