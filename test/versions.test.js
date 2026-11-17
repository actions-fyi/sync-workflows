'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { differOnlyInVersions } = require('../src/versions');

const caller = (ref) => `jobs:\n  zizmor:\n    uses: acme/shared/.github/workflows/_zizmor.yml@${ref}\n`;

test('a different ref of a reusable workflow or an action is only a version', () => {
  assert.equal(differOnlyInVersions(caller('v1.2.0'), caller('v2.0.0')), true);
  assert.equal(differOnlyInVersions('      - uses: actions/checkout@v7.0.0\n', '      - uses: actions/checkout@v7.0.1\n'), true);
  assert.equal(differOnlyInVersions('    uses: "actions/checkout@v7.0.0"\n', '    uses: "actions/checkout@v7.0.1"\n'), true);
});

test('a pinned commit with its version comment is only a version', () => {
  const pinned = (sha, version) => `      - uses: actions/checkout@${sha} # ${version}\n`;
  assert.equal(differOnlyInVersions(pinned('a'.repeat(40), 'v7.0.0'), pinned('b'.repeat(40), 'v7.0.1')), true);
  assert.equal(differOnlyInVersions(pinned('a'.repeat(40), 'v7.0.0'), '      - uses: actions/checkout@v7.0.1\n'), true);
});

test('the value after a renovate annotation is only a version', () => {
  const pin = (version) => `env:\n  # renovate: datasource=pypi depName=zizmor\n  ZIZMOR_VERSION: ${version}\n  OTHER: 1\n`;
  assert.equal(differOnlyInVersions(pin('1.31.1'), pin('1.32.0')), true);
  assert.equal(differOnlyInVersions(pin('1.31.1'), pin('1.31.1').replace('OTHER: 1', 'OTHER: 2')), false);
});

test('anything else that differs is not only a version', () => {
  assert.equal(differOnlyInVersions(caller('v1.2.0'), caller('v1.2.0')), false);
  assert.equal(differOnlyInVersions(caller('v1.2.0'), caller('v2.0.0').replace('_zizmor', '_audit')), false);
  assert.equal(differOnlyInVersions(caller('v1.2.0'), `${caller('v2.0.0')}    with:\n      a: b\n`), false);
  assert.equal(differOnlyInVersions('  - uses: actions/checkout@v7 # keep the token\n', '  - uses: actions/checkout@v8 # drop the token\n'), false);
  assert.equal(differOnlyInVersions('  - run: npx tool@1.0.0\n', '  - run: npx tool@2.0.0\n'), false);
  assert.equal(differOnlyInVersions('    uses: $/.github/workflows/_a.yml\n', '    uses: $/.github/workflows/_b.yml\n'), false);
});
