'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { unifiedDiff } = require('../src/diff');

const lines = (count) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

test('a change in the middle gets three lines of context and the right hunk header', () => {
  const before = lines(20);
  const after = [...before];
  after[9] = 'changed';
  const diff = unifiedDiff(`${before.join('\n')}\n`, `${after.join('\n')}\n`);
  assert.deepEqual([diff.added, diff.removed], [1, 1]);
  assert.equal(diff.text, ['@@ -7,7 +7,7 @@', ' line 7', ' line 8', ' line 9', '-line 10', '+changed', ' line 11', ' line 12', ' line 13'].join('\n'));
});

test('changes far apart get a hunk each', () => {
  const before = lines(30);
  const after = [...before];
  after[1] = 'first';
  after.splice(25, 1);
  const diff = unifiedDiff(before.join('\n'), after.join('\n'));
  assert.deepEqual([diff.added, diff.removed], [1, 2]);
  assert.deepEqual(diff.text.split('\n').filter((line) => line.startsWith('@@')), ['@@ -1,5 +1,5 @@', '@@ -23,7 +23,6 @@']);
});

test('added and emptied files count every line', () => {
  assert.deepEqual(unifiedDiff('', 'a\nb\n'), { added: 2, removed: 0, text: '@@ -0,0 +1,2 @@\n+a\n+b' });
  assert.deepEqual(unifiedDiff('a\nb\n', ''), { added: 0, removed: 2, text: '@@ -1,2 +0,0 @@\n-a\n-b' });
  assert.deepEqual(unifiedDiff('a\n', 'a\n'), { added: 0, removed: 0, text: '' });
});
