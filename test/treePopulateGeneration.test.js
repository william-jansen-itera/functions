const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNode, validateRoots } = require('../src/lib/treePopulateGeneration');

test('accepts a four-level branch and preserves a leaf note', () => {
  const root = validateNode({
    title: 'Root',
    children: [{ title: 'Area', children: [{ title: 'Topic', children: [{ title: 'Leaf', notes: 'Specific guidance.' }] }] }],
  }, 0);

  assert.equal(root.children[0].children[0].children[0].notes, 'Specific guidance.');
});

test('rejects malformed or oversized branches before SQL insertion', () => {
  assert.throws(() => validateNode({ title: 'Root', children: [] }, 0));
  assert.throws(() => validateNode({ title: 'Leaf', notes: 'Note', children: [] }, 3));
  assert.throws(() => validateNode({ title: 'Root', children: Array(9).fill({ title: 'Area' }) }, 0));
});

test('root titles honor declared count and uniqueness', () => {
  assert.deepEqual(validateRoots({ rootTitles: ['A', 'B'], declaredRootCount: 2 }), ['A', 'B']);
  assert.throws(() => validateRoots({ rootTitles: ['A', 'A'], declaredRootCount: 2 }));
  assert.throws(() => validateRoots({ rootTitles: ['A'], declaredRootCount: 2 }));
});