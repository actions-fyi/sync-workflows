'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { differOnlyInWhitespace } = require('../src/whitespace');

test('the spacing that aligns comments is only whitespace', () => {
  const aligned = 'allow:\n  - api.github.com       # the API\n  - ghcr.io              # images\n';
  const formatted = 'allow:\n  - api.github.com # the API\n  - ghcr.io # images\n';
  assert.equal(differOnlyInWhitespace(aligned, formatted), true);
});

test('trailing whitespace, carriage returns, blank lines and the last newline are only whitespace', () => {
  const text = 'on: push\n\njobs:\n  a: b\n';
  assert.equal(differOnlyInWhitespace(text, 'on: push  \njobs:\n  a: b'), true);
  assert.equal(differOnlyInWhitespace(text, 'on: push\r\n\r\n\r\njobs:\r\n  a: b\r\n'), true);
});

test('indentation, a space added or taken away, and anything else are not only whitespace', () => {
  assert.equal(differOnlyInWhitespace('a:\n  b: c\n', 'a:\n    b: c\n'), false);
  assert.equal(differOnlyInWhitespace('a: b # c\n', 'a: b# c\n'), false);
  assert.equal(differOnlyInWhitespace('a: b\n', 'a: c\n'), false);
  assert.equal(differOnlyInWhitespace('a: b\n', 'a: b\n'), false);
});
