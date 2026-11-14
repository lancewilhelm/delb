import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { ref } from 'vue';

async function navigation() {
  const raw = await readFile('app/components/Books/BookshelfView.vue', 'utf8');
  const source = raw.slice(raw.indexOf('>') + 1, raw.indexOf('</script>'));
  const ast = ts.createSourceFile(
    'shelf.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const wanted = [
    'startPan',
    'onKeyDown',
    'onKeyUp',
    'preventPanClick',
    'onMove',
    'onUp',
    'updateBookcaseTarget',
    'scrollBookcaseDrag',
    'stopBookcaseScroll',
    'touchDistance',
    'onTouchStart',
    'onTouchMove',
    'onTouchEnd',
  ];
  const declarations = ast.statements
    .filter(
      (item) =>
        ts.isFunctionDeclaration(item) &&
        wanted.includes(item.name?.text ?? ''),
    )
    .map((item) => item.getText(ast))
    .join('\n');
  let attached = false;
  let cancelled = false;
  const cases = ['first', 'second', 'third'].map((id, i) => ({
    dataset: { bookcaseId: id },
    getBoundingClientRect: () => ({ left: i * 100, width: 100 }),
  }));
  const viewport = {
    scrollLeft: 100,
    scrollTop: 80,
    querySelectorAll: () => cases,
    getBoundingClientRect: () => ({ left: 0, right: 300, width: 300 }),
  };
  let frameScheduled = false;
  class TestNode {}
  class TestElement extends TestNode {
    constructor(kind) {
      super();
      this.kind = kind;
    }
    closest(selector) {
      if (this.kind === 'input' && selector.includes('input')) return this;
      if (this.kind === 'button' && selector.includes('button')) return this;
      return null;
    }
  }
  const body = new TestElement('body');
  viewport.contains = (target) => target.kind === 'inside';
  const state = {
    wall: ref(viewport),
    pan: ref(null),
    drag: ref(null),
    resizing: ref(null),
    bookcaseDrag: ref(null),
    spaceHeld: ref(false),
    pointerOverWall: ref(false),
    zoom: ref(1),
    HTMLElement: TestElement,
    Node: TestNode,
    document: { body },
    attachPointerListeners: () => {
      attached = true;
    },
    detachPointerListeners: () => {
      attached = false;
    },
    onCancel: () => {
      cancelled = true;
    },
    requestAnimationFrame: () => {
      frameScheduled = true;
      return 42;
    },
    cancelAnimationFrame: () => {
      frameScheduled = false;
    },
  };
  const js = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const actions = new Function(
    ...Object.keys(state),
    `let suppressPanClick = false; let pinch = null; let scrollFrame = null; ${js}; return {startPan, onKeyDown, onKeyUp, preventPanClick, onMove, onUp, updateBookcaseTarget, scrollBookcaseDrag, stopBookcaseScroll, onTouchStart, onTouchMove, onTouchEnd};`,
  )(...Object.values(state));
  return {
    actions,
    state,
    viewport,
    body,
    TestElement,
    get attached() {
      return attached;
    },
    get cancelled() {
      return cancelled;
    },
    get frameScheduled() {
      return frameScheduled;
    },
  };
}

test('Space enables panning without stealing typing or focused shelf controls', async () => {
  const nav = await navigation();
  const key = (target) => ({
    code: 'Space',
    target,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  });
  const bodyKey = key(nav.body);
  nav.actions.onKeyDown(bodyKey);
  assert.equal(bodyKey.prevented, true);
  assert.equal(nav.state.spaceHeld.value, true);
  nav.actions.onKeyUp(bodyKey);
  assert.equal(nav.state.spaceHeld.value, false);
  nav.state.pointerOverWall.value = true;
  const inputKey = key(new nav.TestElement('input'));
  nav.actions.onKeyDown(inputKey);
  assert.equal(inputKey.prevented, false);
  const toolbarKey = key(new nav.TestElement('button'));
  nav.actions.onKeyDown(toolbarKey);
  assert.equal(toolbarKey.prevented, true);
  nav.actions.onKeyUp(toolbarKey);
  nav.viewport.contains = () => true;
  const shelfButtonKey = key(new nav.TestElement('button'));
  nav.actions.onKeyDown(shelfButtonKey);
  assert.equal(shelfButtonKey.prevented, false);
});
function pointer(button, pointerType = 'mouse') {
  return {
    button,
    pointerType,
    pointerId: 7,
    clientX: 150,
    clientY: 120,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
}
function touches(points) {
  return { length: points.length, item: (index) => points[index] ?? null };
}

test('right-drag and Space-drag pan without starting a book interaction', async () => {
  const nav = await navigation();
  for (const button of [2, 0]) {
    nav.state.spaceHeld.value = button === 0;
    nav.viewport.scrollLeft = 100;
    nav.viewport.scrollTop = 80;
    const down = pointer(button);
    nav.actions.startPan(down);
    assert.equal(down.prevented, true);
    assert.equal(down.stopped, true);
    assert.equal(nav.attached, true);
    nav.actions.onMove({ pointerId: 8, clientX: 500, clientY: 500 });
    assert.equal(nav.viewport.scrollLeft, 100);
    nav.actions.onMove({ pointerId: 7, clientX: 120, clientY: 100 });
    assert.equal(nav.viewport.scrollLeft, 130);
    assert.equal(nav.viewport.scrollTop, 100);
    nav.actions.onUp({ pointerId: 7 });
    assert.equal(nav.attached, false);
    if (button === 0) {
      const click = pointer(0);
      nav.actions.preventPanClick(click);
      assert.equal(click.prevented, true);
    }
  }
  nav.state.spaceHeld.value = false;
  for (const down of [pointer(0), pointer(0, 'touch')]) {
    nav.actions.startPan(down);
    assert.equal(down.prevented, false);
    assert.equal(nav.state.pan.value, null);
  }
});

test('pinching cancels an in-progress drag and changes zoom', async () => {
  const nav = await navigation();
  nav.state.drag.value = { bookId: 'sample' };
  nav.actions.onTouchStart({
    touches: touches([
      { clientX: 0, clientY: 0 },
      { clientX: 100, clientY: 0 },
    ]),
  });
  assert.equal(nav.cancelled, true);
  const event = {
    touches: touches([
      { clientX: 0, clientY: 0 },
      { clientX: 150, clientY: 0 },
    ]),
    cancelable: true,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  nav.actions.onTouchMove(event);
  assert.equal(event.prevented, true);
  assert.equal(nav.state.zoom.value, 1.5);
  nav.actions.onTouchEnd({ touches: touches([]) });
  nav.actions.onTouchMove(event);
  assert.equal(nav.state.zoom.value, 1.5);
});

test('bookcase insertion follows the pointer and ignores the dragged case', async () => {
  const nav = await navigation();
  nav.state.bookcaseDrag.value = {
    id: 'second',
    moved: true,
    x: 10,
    beforeId: null,
  };
  nav.actions.updateBookcaseTarget();
  assert.equal(nav.state.bookcaseDrag.value.beforeId, 'first');
  nav.state.bookcaseDrag.value.x = 200;
  nav.actions.updateBookcaseTarget();
  assert.equal(nav.state.bookcaseDrag.value.beforeId, 'third');
  nav.state.bookcaseDrag.value.x = 400;
  nav.actions.updateBookcaseTarget();
  assert.equal(nav.state.bookcaseDrag.value.beforeId, null);
});

test('dragging near the edge scrolls the floor and stops cleanly', async () => {
  const nav = await navigation();
  nav.state.bookcaseDrag.value = {
    id: 'second',
    moved: true,
    x: 299,
    beforeId: null,
    scrollLeft: 100,
  };
  nav.actions.scrollBookcaseDrag();
  assert.ok(nav.viewport.scrollLeft > 100);
  assert.equal(
    nav.state.bookcaseDrag.value.scrollLeft,
    nav.viewport.scrollLeft,
  );
  assert.equal(nav.frameScheduled, true);
  nav.actions.stopBookcaseScroll();
  assert.equal(nav.frameScheduled, false);
});
