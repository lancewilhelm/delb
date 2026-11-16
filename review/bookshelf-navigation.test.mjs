import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { reactive, ref } from 'vue';

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
    'shelfFrame',
    'onWheel',
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
    'onBookClick',
    'centerBookshelf',
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
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, width: 300 }),
  };
  let frameScheduled = false;
  let destination = '';
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
    editing: ref(false),
    selected: ref(null),
    selectedShelf: ref(null),
    navigateTo: (path) => {
      destination = path;
    },
    spaceHeld: ref(false),
    pointerOverWall: ref(false),
    zoom: ref(1),
    width: ref(300),
    viewportHeight: ref(300),
    arrangement: ref({
      bookcases: [
        { width: 200, shelves: [{ height: 150 }] },
        { width: 100, shelves: [{ height: 200 }, { height: 120 }] },
      ],
    }),
    camera: reactive({ x: 0, y: 0 }),
    SHELF_WIDTH: 340,
    WALL_SIDE_PADDING: 28,
    WALL_TOP_PADDING: 36,
    FLOOR_LINE_HEIGHT: 2,
    MIN_ZOOM: 0.5,
    MAX_ZOOM: 4,
    nextTick: (fn) => Promise.resolve().then(fn),
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
    `let suppressPanClick = false; let pinch = null; let touchPan = null; let scrollFrame = null; ${js}; return {startPan, onWheel, onKeyDown, onKeyUp, preventPanClick, onMove, onUp, updateBookcaseTarget, scrollBookcaseDrag, stopBookcaseScroll, onTouchStart, onTouchMove, onTouchEnd, onBookClick, centerBookshelf};`,
  )(...Object.values(state));
  return {
    actions,
    state,
    viewport,
    body,
    TestElement,
    get destination() {
      return destination;
    },
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

test('centering resets pan and zoom together', async () => {
  const nav = await navigation();
  nav.state.camera.x = -900;
  nav.state.camera.y = 75;
  nav.state.zoom.value = 2;
  nav.actions.centerBookshelf();
  assert.equal(nav.state.camera.x, 0);
  assert.equal(nav.state.camera.y, 0);
  assert.equal(nav.state.zoom.value, 1);
});

test('keyboard activation opens book options in edit mode', async () => {
  const nav = await navigation();
  nav.state.editing.value = true;
  nav.state.selectedShelf.value = 'shelf';
  nav.actions.onBookClick({ detail: 0 }, 'book');
  assert.equal(nav.state.selected.value, 'book');
  assert.equal(nav.state.selectedShelf.value, null);
  nav.actions.onBookClick({ detail: 1 }, 'other');
  assert.equal(nav.state.selected.value, 'book');
  nav.state.editing.value = false;
  nav.actions.onBookClick({ detail: 0 }, 'book');
  assert.equal(nav.destination, '/books/book');
});

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
    nav.state.camera.x = 100;
    nav.state.camera.y = 80;
    const down = pointer(button);
    nav.actions.startPan(down);
    assert.equal(down.prevented, true);
    assert.equal(down.stopped, true);
    assert.equal(nav.attached, true);
    nav.actions.onMove({ pointerId: 8, clientX: 500, clientY: 500 });
    assert.equal(nav.state.camera.x, 100);
    nav.actions.onMove({ pointerId: 7, clientX: 120, clientY: 100 });
    assert.equal(nav.state.camera.x, 70);
    assert.equal(nav.state.camera.y, 60);
    nav.actions.onMove({ pointerId: 7, clientX: -10000, clientY: 10000 });
    assert.equal(nav.state.camera.x, -10050);
    assert.equal(nav.state.camera.y, 9960);
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

test('touch swipe pans beyond the bookcases without activating a book', async () => {
  const nav = await navigation();
  nav.actions.onTouchStart({
    touches: touches([{ clientX: 100, clientY: 100 }]),
  });
  const move = {
    touches: touches([{ clientX: -2000, clientY: 1500 }]),
    cancelable: true,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  nav.actions.onTouchMove(move);
  assert.equal(move.prevented, true);
  assert.equal(nav.state.camera.x, -2100);
  assert.equal(nav.state.camera.y, 1400);
  nav.actions.onTouchEnd({ touches: touches([]) });
  const click = pointer(0);
  nav.actions.preventPanClick(click);
  assert.equal(click.prevented, true);
});

test('wheel and pinch zoom reach 400 percent and clamp there', async () => {
  const nav = await navigation();
  const wheel = {
    deltaX: 0,
    deltaY: -10000,
    shiftKey: false,
    clientX: 150,
    clientY: 100,
    preventDefault() {},
  };
  nav.actions.onWheel(wheel);
  assert.equal(nav.state.zoom.value, 4);
  nav.state.zoom.value = 1;
  nav.actions.onTouchStart({
    touches: touches([
      { clientX: 0, clientY: 0 },
      { clientX: 100, clientY: 0 },
    ]),
  });
  nav.actions.onTouchMove({
    touches: touches([
      { clientX: 0, clientY: 0 },
      { clientX: 700, clientY: 0 },
    ]),
    cancelable: true,
    preventDefault() {},
  });
  assert.equal(nav.state.zoom.value, 4);
  nav.state.camera.x = 0;
  nav.state.camera.y = 0;
  nav.actions.onWheel({
    deltaX: 25,
    deltaY: 0,
    shiftKey: false,
    preventDefault() {},
  });
  nav.actions.onWheel({
    deltaX: 0,
    deltaY: 40,
    shiftKey: true,
    preventDefault() {},
  });
  assert.deepEqual({ ...nav.state.camera }, { x: -25, y: -40 });
});

test('wheel zoom keeps the point under the cursor fixed across layout and zoom limits', async () => {
  const nav = await navigation();
  nav.state.width.value = 800;
  nav.state.viewportHeight.value = 600;
  nav.viewport.getBoundingClientRect = () => ({
    left: 30,
    top: 20,
    right: 830,
    width: 800,
  });
  nav.state.camera.x = 65;
  nav.state.camera.y = -65;
  const origin = (zoom) => {
    const scale = zoom;
    const contentWidth = 300 * scale;
    const wallWidth = Math.max(800, contentWidth + 56);
    const wallHeight = 320 * scale + 38;
    return {
      scale,
      x: 28 + (wallWidth - 56 - contentWidth) / 2,
      floor: Math.max(0, (600 - wallHeight) / 2) + wallHeight - 2,
    };
  };
  const initial = origin(1);
  const point = {
    x: 30 + initial.x + nav.state.camera.x + 280 * initial.scale,
    y: 20 + initial.floor + nav.state.camera.y - 180 * initial.scale,
  };
  for (const deltaY of [-1000, 1400, -450, -10000, -100]) {
    nav.actions.onWheel({
      deltaX: 0,
      deltaY,
      shiftKey: false,
      clientX: point.x,
      clientY: point.y,
      preventDefault() {},
    });
    const frame = origin(nav.state.zoom.value);
    assert.ok(
      Math.abs(
        30 + frame.x + nav.state.camera.x + 280 * frame.scale - point.x,
      ) < 1e-8,
    );
    assert.ok(
      Math.abs(
        20 + frame.floor + nav.state.camera.y - 180 * frame.scale - point.y,
      ) < 1e-8,
    );
  }
  assert.equal(nav.state.zoom.value, 4);
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
    cameraX: 0,
  };
  nav.actions.scrollBookcaseDrag();
  assert.ok(nav.state.camera.x < 0);
  assert.equal(nav.state.bookcaseDrag.value.cameraX, nav.state.camera.x);
  assert.equal(nav.frameScheduled, true);
  nav.actions.stopBookcaseScroll();
  assert.equal(nav.frameScheduled, false);
});
