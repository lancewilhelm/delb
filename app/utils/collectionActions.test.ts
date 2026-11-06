import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseBookTarget } from './collectionActions';

test('Add book prefers the active editable collection then the authorized default, and never substitutes an arbitrary private collection', () => {
  const collections = [
    { id: 'default', isDefault: true, role: 'editor' },
    { id: 'private', role: 'owner' },
    { id: 'view', role: 'viewer' },
  ];
  assert.equal(chooseBookTarget(collections, 'private'), 'private');
  assert.equal(chooseBookTarget(collections, 'view'), 'default');
  assert.equal(chooseBookTarget(collections, null), 'default');
  assert.equal(
    chooseBookTarget(
      [
        { id: 'default', isDefault: true, role: 'viewer' },
        { id: 'private', role: 'owner' },
      ],
      null,
    ),
    null,
  );
  assert.equal(chooseBookTarget([], null), null);
});
