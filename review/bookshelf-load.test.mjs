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
    props: { endpoint: '/api/books', personalShelfId: undefined },
    catalog: ref([{ id: 'a' }, { id: 'b' }]),
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

test('a personal shelf reuses its catalog when only its own filter applies', async () => {
  const { state, load, calls } = await matcher();
  state.props.personalShelfId = 'shelf 1';
  state.props.endpoint = '/api/books?shelfId=shelf%201';
  await load();
  assert.deepEqual([...state.matches.value], ['a', 'b']);
  assert.deepEqual(calls, []);
});

test('applied filters use the authorized endpoint', async () => {
  const { state, load, calls } = await matcher();
  state.props.endpoint = '/api/books?status=reading';
  await load();
  assert.deepEqual([...state.matches.value], ['b']);
  assert.deepEqual(calls, [['/api/books?status=reading']]);
});

test('a late filtered response cannot override cleared filters', async () => {
  const { state, load, setRequest } = await matcher();
  const pending = Promise.withResolvers();
  setRequest(() => pending.promise);
  state.props.endpoint = '/api/books?title=old';
  const old = load();
  state.props.endpoint = '/api/books';
  await load();
  pending.resolve([{ id: 'b' }]);
  await old;
  assert.deepEqual([...state.matches.value], ['a', 'b']);
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
