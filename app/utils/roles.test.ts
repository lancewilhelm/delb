import assert from 'node:assert/strict';
import test from 'node:test';
import {
  editableRole,
  normalizeRole,
  roleCanEditCatalog,
  roleIsAdmin,
  roleLabel,
  roleUsesTagRules,
} from './roles';

test('owners and admins are admins; editors and readers are not', () => {
  assert.equal(roleIsAdmin('owner'), true);
  assert.equal(roleIsAdmin('admin'), true);
  assert.equal(roleIsAdmin('editor'), false);
  assert.equal(roleIsAdmin('reader'), false);
  assert.equal(roleIsAdmin(undefined), false);
});

test('only readers and unknown roles are read-only on the catalog', () => {
  assert.equal(roleCanEditCatalog('owner'), true);
  assert.equal(roleCanEditCatalog('admin'), true);
  assert.equal(roleCanEditCatalog('editor'), true);
  assert.equal(roleCanEditCatalog('reader'), false);
  assert.equal(roleCanEditCatalog('user'), false);
  assert.equal(roleCanEditCatalog(null), false);
});

test('unknown roles normalize to reader', () => {
  assert.equal(normalizeRole('user'), 'reader');
  assert.equal(normalizeRole(''), 'reader');
  assert.equal(normalizeRole(undefined), 'reader');
  assert.equal(normalizeRole('editor'), 'editor');
});

test('the user editor never offers owner as a role', () => {
  assert.equal(editableRole('owner'), 'admin');
  assert.equal(editableRole('admin'), 'admin');
  assert.equal(editableRole('editor'), 'editor');
  assert.equal(editableRole(null), 'reader');
});

test('tag visibility rules apply only to editors and readers', () => {
  assert.equal(roleUsesTagRules('owner'), false);
  assert.equal(roleUsesTagRules('admin'), false);
  assert.equal(roleUsesTagRules('editor'), true);
  assert.equal(roleUsesTagRules('reader'), true);
});

test('role labels are capitalized', () => {
  assert.equal(roleLabel('owner'), 'Owner');
  assert.equal(roleLabel('admin'), 'Admin');
  assert.equal(roleLabel('editor'), 'Editor');
  assert.equal(roleLabel('reader'), 'Reader');
  assert.equal(roleLabel('user'), 'Reader');
});
