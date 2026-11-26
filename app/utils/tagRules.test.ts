import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTagRulesPayload,
  describeTagRules,
  rulesToModes,
  sameTagRules,
  setTagMode,
} from './tagRules';

test('rules from the API become a mode map, and block wins over allow', () => {
  const modes = rulesToModes({
    userId: 'u1',
    allowTags: [
      { id: 't-kids', name: 'kids' },
      { id: 't-both', name: 'both' },
    ],
    blockTags: [
      { id: 't-adult', name: 'adult' },
      { id: 't-both', name: 'both' },
    ],
  });
  assert.deepEqual(modes, {
    't-kids': 'allow',
    't-adult': 'block',
    't-both': 'block',
  });
});

test('setting a mode moves a tag between lists, and none removes it', () => {
  let modes = setTagMode({}, 't1', 'allow');
  modes = setTagMode(modes, 't1', 'block');
  assert.deepEqual(buildTagRulesPayload(modes), {
    allowTagIds: [],
    blockTagIds: ['t1'],
  });
  modes = setTagMode(modes, 't1', 'none');
  assert.deepEqual(buildTagRulesPayload(modes), {
    allowTagIds: [],
    blockTagIds: [],
  });
});

test('the payload is sorted so unchanged rules compare equal', () => {
  const a = { b: 'allow', a: 'allow', c: 'block' } as const;
  const b = { c: 'block', a: 'allow', b: 'allow' } as const;
  assert.deepEqual(buildTagRulesPayload(a), {
    allowTagIds: ['a', 'b'],
    blockTagIds: ['c'],
  });
  assert.equal(sameTagRules(a, b), true);
  assert.equal(sameTagRules(a, { a: 'allow' }), false);
});

test('descriptions explain what the account can see', () => {
  assert.equal(describeTagRules({}), 'Sees the whole library.');
  assert.equal(
    describeTagRules({ x: 'block' }),
    'Sees the whole library, except books with the hidden tag.',
  );
  assert.equal(
    describeTagRules({ x: 'allow', y: 'allow' }),
    'Sees only books with at least one allowed tag.',
  );
  assert.equal(
    describeTagRules({ x: 'allow', y: 'block', z: 'block' }),
    'Sees only books with the allowed tag, except books with any hidden tag.',
  );
});
