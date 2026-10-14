import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function loadToggle(values: Record<string, unknown>) {
  const raw = await readFile('app/pages/books/[id]/read.vue', 'utf8');
  const source = raw.slice(raw.indexOf('>') + 1, raw.indexOf('</script>'));
  const ast = ts.createSourceFile(
    'reader.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let toggle: string | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'toggleFullscreen'
    )
      toggle = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(toggle);
  const code = ts.transpileModule(toggle, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(
    ...Object.keys(values),
    `${code}\nreturn toggleFullscreen;`,
  )(...Object.values(values)) as () => Promise<void>;
}

test('fullscreen entry and exit resize the existing rendition without starting it again', async () => {
  let refreshes = 0;
  const values = {
    isSettingsOpen: { value: true },
    isTocOpen: { value: false },
    isFullscreen: { value: false },
    renditionRef: {
      value: {
        start() {
          throw new Error('already-started rendition must not restart');
        },
      },
    },
    refreshRenditionLayout: async () => {
      refreshes++;
    },
  };
  const toggle = await loadToggle(values);
  await toggle();
  assert.equal(values.isFullscreen.value, true);
  assert.equal(values.isSettingsOpen.value, false);
  await toggle();
  assert.equal(values.isFullscreen.value, false);
  assert.equal(refreshes, 2);
});

test('fullscreen toggle waits for the deliberate layout refresh to finish', async () => {
  let finish: (() => void) | undefined;
  const refresh = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const toggle = await loadToggle({
    isSettingsOpen: { value: false },
    isTocOpen: { value: false },
    isFullscreen: { value: false },
    renditionRef: {
      value: {
        start() {
          throw new Error('must not restart');
        },
      },
    },
    refreshRenditionLayout: () => refresh,
  });
  let completed = false;
  const pending = toggle().then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  finish?.();
  await pending;
  assert.equal(completed, true);
});
