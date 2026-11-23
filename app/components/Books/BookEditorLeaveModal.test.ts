import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { ref } from 'vue';
import {
  getBookEditorLeavePrompt,
  type BookEditorLeavePrompt,
} from '~/utils/bookEditorDirty';

async function loadLeaveModalHandlers(options: {
  hasUnsavedChanges?: boolean;
  spineGenerating?: boolean;
  saving?: boolean;
  saveDisabled?: boolean;
  isCreateMode?: boolean;
  saveResult?: boolean;
  saveError?: Error;
}) {
  const raw = await readFile('app/components/Books/BookEditor.vue', 'utf8');
  const scriptSource = raw.slice(
    raw.indexOf('>') + 1,
    raw.indexOf('</script>'),
  );

  // Guard against regressions back to browser-native confirm().
  assert.equal(
    /\bconfirm\s*\(/.test(scriptSource),
    false,
    'BookEditor.vue should use the in-app modal instead of window.confirm()',
  );
  assert.ok(
    raw.includes('role="alertdialog"'),
    'BookEditor.vue should render an accessible in-app alertdialog modal',
  );

  const ast = ts.createSourceFile(
    'editor-leave.ts',
    scriptSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const wanted = [
    'resolvePendingLeave',
    'cancelLeaveConfirm',
    'discardAndLeave',
    'saveAndLeave',
    'canLeave',
    'confirmLeaveIfNeeded',
  ];
  const funcs = ast.statements
    .filter(
      (s) => ts.isFunctionDeclaration(s) && wanted.includes(s.name?.text ?? ''),
    )
    .map((s) => s.getText(ast))
    .join('\n');

  assert.ok(funcs.includes('function canLeave'));
  assert.ok(funcs.includes('async function saveAndLeave'));

  const saveCalls: Array<{ navigateAfter?: boolean } | undefined> = [];
  let stayFocused = false;

  const leaveConfirmOpen = ref(false);
  const leaveConfirmSaving = ref(false);
  const leavePrompt = ref<BookEditorLeavePrompt | null>(null);
  const leaveStayButton = ref<{ focus: () => void } | null>({
    focus: () => {
      stayFocused = true;
    },
  });

  const hasUnsavedChanges = ref(options.hasUnsavedChanges ?? true);
  const spineEditor = ref(
    options.spineGenerating ? { generating: true } : { generating: false },
  );
  const saving = ref(options.saving ?? false);
  const saveDisabled = ref(options.saveDisabled ?? false);
  const isCreateMode = ref(options.isCreateMode ?? false);

  const save = async (saveOpts?: { navigateAfter?: boolean }) => {
    saveCalls.push(saveOpts);
    if (options.saveError) throw options.saveError;
    return options.saveResult ?? true;
  };

  const js = ts.transpileModule(funcs, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const scope = {
    getBookEditorLeavePrompt,
    hasUnsavedChanges,
    spineEditor,
    saving,
    saveDisabled,
    isCreateMode,
    leaveConfirmOpen,
    leaveConfirmSaving,
    leavePrompt,
    leaveStayButton,
    nextTick: async (cb?: () => void) => {
      await Promise.resolve();
      cb?.();
    },
    save,
  };

  const api = new Function(
    ...Object.keys(scope),
    `
      let allowNextRouteLeave = false;
      let pendingLeaveResolve = null;
      let previousFocusBeforeLeaveModal = null;
      ${js}
      return {
        canLeave,
        confirmLeaveIfNeeded,
        cancelLeaveConfirm,
        discardAndLeave,
        saveAndLeave,
        setAllowNextRouteLeave: (v) => { allowNextRouteLeave = v; },
      };
    `,
  )(...Object.values(scope)) as {
    canLeave: () => Promise<boolean>;
    confirmLeaveIfNeeded: () => Promise<boolean>;
    cancelLeaveConfirm: () => void;
    discardAndLeave: () => void;
    saveAndLeave: () => Promise<void>;
    setAllowNextRouteLeave: (v: boolean) => void;
  };

  return {
    api,
    leaveConfirmOpen,
    leaveConfirmSaving,
    leavePrompt,
    saveCalls,
    getStayFocused: () => stayFocused,
  };
}

test('clean editor leaves immediately without opening modal', async () => {
  const ctx = await loadLeaveModalHandlers({ hasUnsavedChanges: false });
  const allowed = await ctx.api.canLeave();
  assert.equal(allowed, true);
  assert.equal(ctx.leaveConfirmOpen.value, false);
});

test('dirty editor opens in-app modal and Keep editing cancels navigation', async () => {
  const ctx = await loadLeaveModalHandlers({ hasUnsavedChanges: true });
  const pending = ctx.api.canLeave();
  await Promise.resolve();

  assert.equal(ctx.leaveConfirmOpen.value, true);
  assert.equal(ctx.leavePrompt.value?.title, 'Unsaved changes');
  assert.equal(ctx.getStayFocused(), true);

  ctx.api.cancelLeaveConfirm();
  assert.equal(await pending, false);
  assert.equal(ctx.leaveConfirmOpen.value, false);
  assert.equal(ctx.leavePrompt.value, null);
});

test('Discard & leave resolves true and closes modal', async () => {
  const ctx = await loadLeaveModalHandlers({ hasUnsavedChanges: true });
  const pending = ctx.api.canLeave();
  assert.equal(ctx.leaveConfirmOpen.value, true);

  ctx.api.discardAndLeave();
  assert.equal(await pending, true);
  assert.equal(ctx.leaveConfirmOpen.value, false);
});

test('Save & leave saves without extra navigation and resolves true on success', async () => {
  const ctx = await loadLeaveModalHandlers({
    hasUnsavedChanges: true,
    saveResult: true,
  });
  const pending = ctx.api.canLeave();
  assert.equal(ctx.leaveConfirmOpen.value, true);

  await ctx.api.saveAndLeave();
  assert.equal(await pending, true);
  assert.deepEqual(ctx.saveCalls, [{ navigateAfter: false }]);
  assert.equal(ctx.leaveConfirmOpen.value, false);
  assert.equal(ctx.leaveConfirmSaving.value, false);
});

test('Save & leave keeps user on page when save fails', async () => {
  const ctx = await loadLeaveModalHandlers({
    hasUnsavedChanges: true,
    saveResult: false,
  });
  const pending = ctx.api.canLeave();
  assert.equal(ctx.leaveConfirmOpen.value, true);

  await ctx.api.saveAndLeave();
  assert.equal(await pending, false);
  assert.deepEqual(ctx.saveCalls, [{ navigateAfter: false }]);
  assert.equal(ctx.leaveConfirmOpen.value, false);
});

test('skip-unsaved-warning flag bypasses modal once for post-save navigation', async () => {
  const ctx = await loadLeaveModalHandlers({ hasUnsavedChanges: true });
  ctx.api.setAllowNextRouteLeave(true);
  assert.equal(await ctx.api.confirmLeaveIfNeeded(), true);
  assert.equal(ctx.leaveConfirmOpen.value, false);

  // Subsequent leave attempt prompts normally again.
  const second = ctx.api.confirmLeaveIfNeeded();
  assert.equal(ctx.leaveConfirmOpen.value, true);
  ctx.api.cancelLeaveConfirm();
  assert.equal(await second, false);
});
