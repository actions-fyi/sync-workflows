'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SOURCE, SOURCE_SHA, httpError, mockCore, mockGithub, sourceCheckout, context, env } = require('./helpers');
const main = require('../src/main');

const W = '.github/workflows';
const writes = (github) => github.calls.map((call) => call.name);

async function run(t, { source, github, ...overrides }) {
  const core = mockCore();
  const result = await main({ github, context, core, env: env(sourceCheckout(t, source), overrides) });
  return { result, core, github };
}

test('a copy that differs is updated in one pull request, and nothing else is touched', async (t) => {
  const github = mockGithub({
    files: {
      [`${W}/codeql.yml`]: 'name: CodeQL\non: push\n',
      [`${W}/zizmor.yml`]: 'name: Audit\n',
      [`${W}/own.yml`]: 'name: Own\n',
      [`${W}/actions.lock`]: 'version: target\n',
      'README.md': 'hello\n',
    },
  });
  const { result, core } = await run(t, {
    github,
    source: {
      [`${W}/codeql.yml`]: 'name: CodeQL\non: pull_request\n',
      [`${W}/zizmor.yml`]: 'name: Audit\n',
      [`${W}/new.yml`]: 'name: New\n',
      [`${W}/actions.lock`]: 'version: source\n',
    },
  });
  assert.equal(result, 'created');
  assert.deepEqual(core.failed, []);
  assert.equal(core.outputs.changed, '["codeql.yml"]');
  assert.equal(core.outputs['pull-request-number'], '1');
  assert.deepEqual(writes(github), ['createTree', 'createCommit', 'createRef', 'createPull']);
  assert.deepEqual(github.calls[0].paths, [`${W}/codeql.yml`]);
  assert.deepEqual(github.filesAt('sync/workflows'), {
    [`${W}/codeql.yml`]: 'name: CodeQL\non: pull_request\n',
    [`${W}/zizmor.yml`]: 'name: Audit\n',
    [`${W}/own.yml`]: 'name: Own\n',
    [`${W}/actions.lock`]: 'version: target\n',
    'README.md': 'hello\n',
  });
  assert.deepEqual(github.calls[1].parents, [github.refs.get('main')]);
});

test('the commit and the pull request say what was synced, and from where', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'a\nb\nc\n' } });
  await run(t, { github, source: { [`${W}/codeql.yml`]: 'a\nB\nc\nd\n' } });
  const [pull] = github.pulls;
  assert.equal(pull.title, `ci: sync workflows from ${SOURCE}`);
  assert.equal(pull.base.ref, 'main');
  assert.match(pull.body, /Updates 1 workflow of this repository to match \[acme\/\.github\]\(https:\/\/github\.com\/acme\/\.github\) at \[`aaaaaaa`\]/);
  assert.match(pull.body, new RegExp(`\\| \`${W}/codeql\\.yml\` \\| \\[\`${W}/codeql\\.yml\`\\]\\(https://github\\.com/acme/\\.github/blob/${SOURCE_SHA}/${W}/codeql\\.yml\\) \\| \\+2 −1 \\|`));
  assert.match(pull.body, /```diff\n@@ -1,3 \+1,4 @@\n a\n-b\n\+B\n c\n\+d\n```/);
  assert.match(pull.body, /actions\/runs\/42/);
  const message = github.commit(github.refs.get('sync/workflows')).message;
  assert.equal(message, `ci: sync workflows from ${SOURCE}\n\nSource: ${SOURCE}@${SOURCE_SHA}\n\n- ${W}/codeql.yml from ${W}/codeql.yml\n`);
});

test('a workflow template is rendered with the default branch before it is compared', async (t) => {
  const template = 'on:\n  push:\n    branches: [$default-branch]\n';
  const rendered = 'on:\n  push:\n    branches: [trunk]\n';
  const current = mockGithub({ defaultBranch: 'trunk', files: { [`${W}/typescript.yml`]: rendered } });
  assert.equal((await run(t, { github: current, source: { 'workflow-templates/typescript.yml': template } })).result, 'up-to-date');
  assert.deepEqual(writes(current), []);

  const stale = mockGithub({ defaultBranch: 'trunk', files: { [`${W}/typescript.yml`]: 'on: push\n' } });
  assert.equal((await run(t, { github: stale, source: { 'workflow-templates/typescript.yml': template, 'workflow-templates/typescript.properties.json': '{}' } })).result, 'created');
  assert.equal(stale.filesAt('sync/workflows')[`${W}/typescript.yml`], rendered);
  assert.match(stale.pulls[0].body, /`workflow-templates\/typescript\.yml`\]\([^)]+\), a workflow template rendered with `\$default-branch` = `trunk`/);
});

test('a name in both source directories is taken from .github/workflows, and reported', async (t) => {
  const github = mockGithub({ files: { [`${W}/test.yml`]: 'old\n' } });
  const { core } = await run(t, { github, source: { [`${W}/test.yml`]: 'workflow\n', 'workflow-templates/test.yml': 'template\n' } });
  assert.equal(github.filesAt('sync/workflows')[`${W}/test.yml`], 'workflow\n');
  assert.match(core.warnings[0], /test\.yml in both/);
  assert.match(github.pulls[0].body, /`test\.yml` in both/);
});

test('a template with a placeholder that has no single right value is skipped', async (t) => {
  const github = mockGithub({ files: { [`${W}/scan.yml`]: 'old\n' } });
  const { result, core } = await run(t, { github, source: { 'workflow-templates/scan.yml': "on:\n  schedule:\n    - cron: '$cron-weekly'\n" } });
  assert.equal(result, 'up-to-date');
  assert.match(core.warnings[0], /\$cron-weekly/);
  assert.deepEqual(writes(github), []);
});

test('an open pull request is updated by overwriting its branch, not by creating another', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  github.push('sync/workflows', { [`${W}/actions.lock`]: 'fixed\n' });
  github.calls.length = 0;
  const { result, core } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v3\n' } });
  assert.equal(result, 'updated');
  assert.deepEqual(core.failed, []);
  assert.deepEqual(writes(github), ['createTree', 'createCommit', 'updateRef', 'updatePull']);
  assert.equal(github.calls[2].force, true);
  assert.equal(github.pulls.length, 1);
  assert.equal(github.filesAt('sync/workflows')[`${W}/codeql.yml`], 'v3\n');
  assert.deepEqual(github.commit(github.refs.get('sync/workflows')).parents, [github.refs.get('main')]);
  assert.match(github.pulls[0].body, /-v1\n\+v3/);
});

test('an open pull request that already holds the changes is left alone, with commits added to it', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  github.push('sync/workflows', { [`${W}/actions.lock`]: 'fixed\n' });
  const head = github.refs.get('sync/workflows');
  github.calls.length = 0;
  const { result, core } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  assert.equal(result, 'unchanged');
  assert.equal(core.outputs['pull-request-number'], '1');
  assert.deepEqual(writes(github), []);
  assert.equal(github.refs.get('sync/workflows'), head);
});

test('a branch left behind by a closed pull request is overwritten for a new one', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  github.pulls[0].state = 'closed';
  github.calls.length = 0;
  const { result } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  assert.equal(result, 'created');
  assert.deepEqual(writes(github), ['createTree', 'createCommit', 'updateRef', 'createPull']);
  assert.equal(github.pulls.filter((pull) => pull.state === 'open').length, 1);
});

test('a branch created since it was looked up is overwritten too', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  github.rest.git.createRef = async () => { throw httpError(422, 'Reference already exists'); };
  const { result } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  assert.equal(result, 'created');
  assert.equal(github.filesAt('sync/workflows')[`${W}/codeql.yml`], 'v2\n');
});

test('the open pull request is closed once the default branch matches the source', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  github.push('main', { [`${W}/codeql.yml`]: 'v2\n' });
  github.calls.length = 0;
  const { result } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  assert.equal(result, 'closed');
  assert.deepEqual(writes(github), ['createComment', 'updatePull', 'deleteRef']);
  assert.equal(github.pulls[0].state, 'closed');
  assert.equal(github.refs.has('sync/workflows'), false);
});

test('a dry run reports the copies that differ and writes nothing', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  const { result, core } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' }, SYNC_DRY_RUN: 'true' });
  assert.equal(result, 'dry-run');
  assert.equal(core.outputs.changed, '["codeql.yml"]');
  assert.deepEqual(writes(github), []);
});

test('excluded names, and a repository without workflows, are not synced', async (t) => {
  const excluded = mockGithub({ files: { [`${W}/workflow-sync.yml`]: 'local\n' } });
  assert.equal((await run(t, { github: excluded, source: { [`${W}/workflow-sync.yml`]: 'remote\n' }, SYNC_EXCLUDE: 'workflow-sync.yml' })).result, 'up-to-date');
  const empty = mockGithub({ files: { 'README.md': 'hello\n' } });
  assert.equal((await run(t, { github: empty, source: { [`${W}/codeql.yml`]: 'v2\n' } })).result, 'up-to-date');
});

test('the source itself is skipped', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  const { result } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' }, SYNC_SOURCE_REPOSITORY: 'Acme/App' });
  assert.equal(result, 'skipped');
});

test('a bad input or an empty source checkout fails the step', async (t) => {
  const github = mockGithub();
  const bad = await run(t, { github, source: { [`${W}/a.yml`]: 'a\n' }, SYNC_BRANCH: 'sync/.hidden' });
  assert.match(bad.core.failed[0], /not a valid branch name/);
  const empty = await run(t, { github, source: { 'README.md': 'x\n' } });
  assert.match(empty.core.failed[0], /No workflow was found/);
  assert.equal(empty.result, 'error');
});

test('a retired workflow the repository still has is removed in the same pull request', async (t) => {
  const github = mockGithub({
    files: {
      [`${W}/codeql.yml`]: 'name: CodeQL\non: push\n',
      [`${W}/retired.yml`]: 'name: Retired\n',
      [`${W}/own.yml`]: 'name: Own\n',
    },
  });
  const { result, core } = await run(t, {
    github,
    source: { [`${W}/codeql.yml`]: 'name: CodeQL\non: pull_request\n' },
    SYNC_REMOVE: 'retired.yml, never-had.yml',
  });
  assert.equal(result, 'created');
  assert.deepEqual(core.failed, []);
  assert.equal(core.outputs.changed, '["codeql.yml"]');
  assert.equal(core.outputs.removed, '["retired.yml"]');
  assert.deepEqual(github.calls[0].paths, [`${W}/codeql.yml`, `${W}/retired.yml`]);
  assert.deepEqual(github.filesAt('sync/workflows'), {
    [`${W}/codeql.yml`]: 'name: CodeQL\non: pull_request\n',
    [`${W}/own.yml`]: 'name: Own\n',
  });
  assert.match(github.commit(github.refs.get('sync/workflows')).message, /- \.github\/workflows\/retired\.yml removed: the source retired it/);
  const [pull] = github.pulls;
  assert.match(pull.body, /^Updates 1 workflow of this repository/);
  assert.match(pull.body, /Removes 1 workflow that \[acme\/\.github\]\(https:\/\/github\.com\/acme\/\.github\) at \[`aaaaaaa`\]\([^)]+\) retired: `\.github\/workflows\/retired\.yml`\./);
});

test('a retired workflow alone opens a pull request, and the next run leaves it alone', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'same\n', [`${W}/retired.yml`]: 'name: Retired\n' } });
  const source = { [`${W}/codeql.yml`]: 'same\n' };
  const first = await run(t, { github, source, SYNC_REMOVE: 'retired.yml' });
  assert.equal(first.result, 'created');
  assert.equal(first.core.outputs.changed, '[]');
  assert.equal(first.core.outputs.removed, '["retired.yml"]');
  assert.doesNotMatch(github.pulls[0].body, /\| Workflow \| Source \| Lines \|/);
  assert.match(github.pulls[0].body, /^Removes 1 workflow that/);
  const before = github.calls.length;
  const second = await run(t, { github, source, SYNC_REMOVE: 'retired.yml' });
  assert.equal(second.result, 'unchanged');
  assert.equal(github.calls.length, before);
});

test('a name the source still has, or an excluded one, is never removed', async (t) => {
  const files = { [`${W}/kept.yml`]: 'same\n', [`${W}/excluded.yml`]: 'name: Excluded\n' };
  const github = mockGithub({ files });
  const { result, core } = await run(t, {
    github,
    source: { [`${W}/kept.yml`]: 'same\n' },
    SYNC_REMOVE: 'kept.yml\nexcluded.yml',
    SYNC_EXCLUDE: 'excluded.yml',
  });
  assert.equal(result, 'up-to-date');
  assert.equal(core.outputs.removed, '[]');
  assert.deepEqual(writes(github), []);
  assert.match(core.warnings.join('\n'), /remove lists kept\.yml, but the source still has it\. Keeping kept\.yml\./);
});

test('the pull request is closed once the retired workflow is gone from the default branch', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'same\n', [`${W}/retired.yml`]: 'name: Retired\n' } });
  const source = { [`${W}/codeql.yml`]: 'same\n' };
  await run(t, { github, source, SYNC_REMOVE: 'retired.yml' });
  // The pull request is merged: the default branch now is what its branch was.
  github.refs.set('main', github.refs.get('sync/workflows'));
  const { result } = await run(t, { github, source, SYNC_REMOVE: 'retired.yml' });
  assert.equal(result, 'closed');
  assert.equal(github.pulls[0].state, 'closed');
});

test('a dry run reports a retired workflow and writes nothing', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'same\n', [`${W}/retired.yml`]: 'name: Retired\n' } });
  const { result, core } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'same\n' }, SYNC_REMOVE: 'retired.yml', SYNC_DRY_RUN: 'true' });
  assert.equal(result, 'dry-run');
  assert.deepEqual(writes(github), []);
  assert.match(core.notices.join('\n'), /Dry run: retired\.yml would be removed\./);
});

test('remove only takes workflow file names', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'same\n' } });
  for (const name of ['../README.md', 'actions.lock', 'dir/file.yml']) {
    const { result, core } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'same\n' }, SYNC_REMOVE: name });
    assert.equal(result, 'error');
    assert.match(core.failed[0], /remove lists ".*", which is not a \.yml or \.yaml file name\./);
  }
  assert.deepEqual(writes(github), []);
});

const caller = (ref, extra = '') => `jobs:\n  zizmor:\n    uses: acme/shared/.github/workflows/_zizmor.yml@${ref}\n${extra}`;

test('a copy that differs only in versions opens no pull request with ignore-versions', async (t) => {
  const github = mockGithub({ files: { [`${W}/zizmor.yml`]: caller('v1.2.0') } });
  const source = { [`${W}/zizmor.yml`]: caller('v2.0.0') };
  const ignored = await run(t, { github, source, SYNC_IGNORE_VERSIONS: 'true' });
  assert.equal(ignored.result, 'up-to-date');
  assert.equal(ignored.core.outputs.changed, '[]');
  assert.deepEqual(writes(github), []);
  assert.match(ignored.core.logs.join('\n'), /zizmor\.yml differ from the source only in the versions they reference/);
  // Without the input, a version is a difference like any other.
  const synced = await run(t, { github, source });
  assert.equal(synced.result, 'created');
  assert.equal(synced.core.outputs.changed, '["zizmor.yml"]');
});

test('a copy that differs in more than versions is replaced, versions included; a version-only one is left', async (t) => {
  const github = mockGithub({ files: { [`${W}/zizmor.yml`]: caller('v1.2.0'), [`${W}/codeql.yml`]: caller('v1.2.0') } });
  const source = { [`${W}/zizmor.yml`]: caller('v2.0.0', '    with:\n      persona: pedantic\n'), [`${W}/codeql.yml`]: caller('v2.0.0') };
  const { result, core } = await run(t, { github, source, SYNC_IGNORE_VERSIONS: 'true' });
  assert.equal(result, 'created');
  assert.equal(core.outputs.changed, '["zizmor.yml"]');
  assert.deepEqual(github.calls[0].paths, [`${W}/zizmor.yml`]);
  assert.deepEqual(github.filesAt('sync/workflows'), {
    [`${W}/zizmor.yml`]: caller('v2.0.0', '    with:\n      persona: pedantic\n'),
    [`${W}/codeql.yml`]: caller('v1.2.0'),
  });
  assert.match(github.pulls[0].body, /Not updated: `codeql\.yml` differs from the source only in the versions it references, which Renovate updates\./);
  // The next run leaves the pull request alone, although codeql.yml still differs.
  const before = github.calls.length;
  const again = await run(t, { github, source, SYNC_IGNORE_VERSIONS: 'true' });
  assert.equal(again.result, 'unchanged');
  assert.equal(github.calls.length, before);
});

test('the open pull request is closed once only versions differ', async (t) => {
  const github = mockGithub({ files: { [`${W}/zizmor.yml`]: caller('v1.2.0') } });
  const source = { [`${W}/zizmor.yml`]: caller('v2.0.0', '    with:\n      persona: pedantic\n') };
  await run(t, { github, source, SYNC_IGNORE_VERSIONS: 'true' });
  assert.equal(github.pulls[0].state, 'open');
  // The same change reaches the default branch another way, at an older version.
  github.push('main', { [`${W}/zizmor.yml`]: caller('v1.9.0', '    with:\n      persona: pedantic\n') });
  const { result } = await run(t, { github, source, SYNC_IGNORE_VERSIONS: 'true' });
  assert.equal(result, 'closed');
  assert.equal(github.pulls[0].state, 'closed');
  assert.equal(github.refs.has('sync/workflows'), false);
  assert.match(github.comments[0].body, /differ from acme\/\.github only in the versions they reference, which Renovate updates/);
});

test('an open pull request is rebuilt when a copy it leaves alone changed on the default branch', async (t) => {
  const github = mockGithub({ files: { [`${W}/zizmor.yml`]: caller('v1.2.0'), [`${W}/codeql.yml`]: caller('v1.2.0') } });
  const source = { [`${W}/zizmor.yml`]: caller('v2.0.0', '    with:\n      a: b\n'), [`${W}/codeql.yml`]: caller('v2.0.0') };
  await run(t, { github, source, SYNC_IGNORE_VERSIONS: 'true' });
  // Renovate's update of codeql.yml is merged.
  github.push('main', { [`${W}/codeql.yml`]: caller('v1.3.0') });
  const { result } = await run(t, { github, source, SYNC_IGNORE_VERSIONS: 'true' });
  assert.equal(result, 'updated');
  assert.equal(github.filesAt('sync/workflows')[`${W}/codeql.yml`], caller('v1.3.0'));
});

const POLICY = '.github/egress-firewall.yaml';

// The source aligns its comments; the repository's formatter doesn't.
const ALIGNED = 'mode: log\nallow:\n  - api.github.com       # the API\n  - ghcr.io              # images\n';
const FORMATTED = 'mode: log\nallow:\n  - api.github.com # the API\n  - ghcr.io # images\n';

test('a copy or a file that differs only in whitespace opens no pull request', async (t) => {
  const github = mockGithub({ files: { [POLICY]: FORMATTED, [`${W}/codeql.yml`]: 'on:  push\n' } });
  const source = { [POLICY]: ALIGNED, [`${W}/codeql.yml`]: 'on: push\n\n' };
  const ignored = await run(t, { github, source, SYNC_FILES: POLICY });
  assert.equal(ignored.result, 'up-to-date');
  assert.equal(ignored.core.outputs.changed, '[]');
  assert.deepEqual(writes(github), []);
  assert.match(ignored.core.logs.join('\n'), /codeql\.yml, \.github\/egress-firewall\.yaml differ from the source only in whitespace/);
  // With ignore-whitespace false, whitespace is a difference like any other.
  const synced = await run(t, { github, source, SYNC_FILES: POLICY, SYNC_IGNORE_WHITESPACE: 'false' });
  assert.equal(synced.result, 'created');
  assert.equal(synced.core.outputs.changed, '["codeql.yml",".github/egress-firewall.yaml"]');
});

test('a copy that differs in more than whitespace is replaced, spacing included; a whitespace-only one is left', async (t) => {
  const github = mockGithub({ files: { [POLICY]: FORMATTED, [`${W}/codeql.yml`]: 'on:  push\n' } });
  const source = { [POLICY]: ALIGNED.replace('mode: log', 'mode: block'), [`${W}/codeql.yml`]: 'on: push\n' };
  const { result, core } = await run(t, { github, source, SYNC_FILES: POLICY });
  assert.equal(result, 'created');
  assert.equal(core.outputs.changed, '[".github/egress-firewall.yaml"]');
  assert.equal(github.filesAt('sync/workflows')[POLICY], ALIGNED.replace('mode: log', 'mode: block'));
  assert.equal(github.filesAt('sync/workflows')[`${W}/codeql.yml`], 'on:  push\n');
  assert.match(github.pulls[0].body, /Not updated: `codeql\.yml` differs from the source only in whitespace, which this repository's formatter sets\./);
});

test('an open pull request whose branch a formatter respaced is left alone', async (t) => {
  const github = mockGithub({ files: { [POLICY]: FORMATTED, [`${W}/codeql.yml`]: 'v1\n' } });
  const source = { [POLICY]: ALIGNED.replace('mode: log', 'mode: block'), [`${W}/codeql.yml`]: 'v1\n' };
  assert.equal((await run(t, { github, source, SYNC_FILES: POLICY })).result, 'created');
  // autofix.ci formats the pull request's branch.
  github.push('sync/workflows', { [POLICY]: FORMATTED.replace('mode: log', 'mode: block') });
  const before = github.calls.length;
  const again = await run(t, { github, source, SYNC_FILES: POLICY });
  assert.equal(again.result, 'unchanged');
  assert.equal(github.calls.length, before);
  assert.equal(github.filesAt('sync/workflows')[POLICY], FORMATTED.replace('mode: log', 'mode: block'));
  // A change of more than whitespace on the branch is still overwritten.
  github.push('sync/workflows', { [POLICY]: FORMATTED.replace('mode: log', 'mode: audit') });
  const rebuilt = await run(t, { github, source, SYNC_FILES: POLICY });
  assert.equal(rebuilt.result, 'updated');
});

test('the open pull request is closed once only whitespace and versions differ', async (t) => {
  const github = mockGithub({ files: { [POLICY]: FORMATTED, [`${W}/zizmor.yml`]: caller('v1.2.0') } });
  const source = { [POLICY]: ALIGNED.replace('mode: log', 'mode: block'), [`${W}/zizmor.yml`]: caller('v2.0.0') };
  await run(t, { github, source, SYNC_FILES: POLICY, SYNC_IGNORE_VERSIONS: 'true' });
  assert.equal(github.pulls[0].state, 'open');
  // The pull request is merged after the formatter respaced it.
  github.push('main', { [POLICY]: FORMATTED.replace('mode: log', 'mode: block') });
  const { result } = await run(t, { github, source, SYNC_FILES: POLICY, SYNC_IGNORE_VERSIONS: 'true' });
  assert.equal(result, 'closed');
  assert.match(github.comments[0].body, /only in the versions they reference, which Renovate updates, and in whitespace, which the repository's formatter sets/);
});

test('a copy that differs in whitespace and versions is left with ignore-versions', async (t) => {
  const github = mockGithub({ files: { [`${W}/zizmor.yml`]: `${caller('v1.2.0')}\n` } });
  const { result } = await run(t, { github, source: { [`${W}/zizmor.yml`]: caller('v2.0.0').replace('uses:', 'uses:  ') }, SYNC_IGNORE_VERSIONS: 'true' });
  assert.equal(result, 'up-to-date');
});

test('without add, a workflow or a file the repository lacks is not added', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  const { result } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v1\n', [`${W}/new.yml`]: 'new\n', [POLICY]: 'mode: log\n' }, SYNC_FILES: POLICY });
  assert.equal(result, 'up-to-date');
  assert.deepEqual(writes(github), []);
});

test('with add, the workflows of the source the repository lacks are added, but no template', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n', [`${W}/own.yml`]: 'own\n' } });
  const { result, core } = await run(t, {
    github,
    source: {
      [`${W}/codeql.yml`]: 'v2\n',
      [`${W}/new.yml`]: 'a\nb\n',
      [`${W}/unwanted.yml`]: 'no\n',
      [`${W}/actions.lock`]: 'lock\n',
      'workflow-templates/typescript.yml': 'on: push\n',
    },
    SYNC_ADD: 'true',
    SYNC_EXCLUDE: 'unwanted.yml',
  });
  assert.equal(result, 'created');
  assert.equal(core.outputs.changed, '["codeql.yml","new.yml"]');
  assert.equal(core.outputs.added, '["new.yml"]');
  assert.deepEqual(github.filesAt('sync/workflows'), { [`${W}/codeql.yml`]: 'v2\n', [`${W}/own.yml`]: 'own\n', [`${W}/new.yml`]: 'a\nb\n' });
  const [pull] = github.pulls;
  assert.match(pull.body, /Updates 1 workflow of this repository to match /);
  assert.match(pull.body, /Adds 1 workflow of \[acme\/\.github\]\([^)]+\) at \[`aaaaaaa`\]\([^)]+\) that this repository doesn't have yet\./);
  assert.match(pull.body, /\| `\.github\/workflows\/new\.yml` \(new\) \| .* \| \+2 −0 \|/);
  assert.match(pull.body, /```diff\n@@ -0,0 \+1,2 @@\n\+a\n\+b\n```/);
  assert.match(github.commit(github.refs.get('sync/workflows')).message, /- \.github\/workflows\/new\.yml added from \.github\/workflows\/new\.yml/);

  // The next run finds the pull request holding the addition, and leaves it alone.
  const again = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n', [`${W}/new.yml`]: 'a\nb\n' }, SYNC_ADD: 'true' });
  assert.equal(again.result, 'unchanged');
});

test('add works in a repository without workflows, and a dry run only reports', async (t) => {
  const github = mockGithub({ files: { 'README.md': 'hello\n' } });
  const dry = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' }, SYNC_ADD: 'true', SYNC_DRY_RUN: 'true' });
  assert.equal(dry.result, 'dry-run');
  assert.equal(dry.core.outputs.added, '["codeql.yml"]');
  assert.match(dry.core.notices[0], /codeql\.yml would be added from/);
  assert.deepEqual(writes(github), []);
  assert.equal((await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' }, SYNC_ADD: 'true' })).result, 'created');
  assert.equal(github.filesAt('sync/workflows')[`${W}/codeql.yml`], 'v2\n');
});

test('a file named in files is updated to match the source, versions included', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n', [POLICY]: 'mode: log\nallow:\n  - a.example\n' } });
  const source = { [`${W}/codeql.yml`]: 'v1\n', [POLICY]: 'mode: log\nallow:\n  - a.example\n  - b.example\n', '.github/labels.yml': 'x\n' };
  const { result, core } = await run(t, { github, source, SYNC_FILES: POLICY, SYNC_IGNORE_VERSIONS: 'true' });
  assert.equal(result, 'created');
  assert.equal(core.outputs.changed, `["${POLICY}"]`);
  assert.equal(core.outputs.added, '[]');
  assert.deepEqual(github.calls[0].paths, [POLICY]);
  assert.equal(github.filesAt('sync/workflows')[POLICY], source[POLICY]);
  assert.equal(github.filesAt('sync/workflows')['.github/labels.yml'], undefined);
  const [pull] = github.pulls;
  assert.match(pull.body, /Updates 1 file of this repository to match /);
  assert.match(pull.body, new RegExp(`\\| \`\\.github/egress-firewall\\.yaml\` \\| \\[\`\\.github/egress-firewall\\.yaml\`\\]\\(https://github\\.com/acme/\\.github/blob/${SOURCE_SHA}/\\.github/egress-firewall\\.yaml\\) \\| \\+1 −0 \\|`));
  assert.match(pull.body, /Also synced, as it is in the source: `\.github\/egress-firewall\.yaml`\./);

  // Left alone while the pull request holds it; rebuilt when the source moves on.
  assert.equal((await run(t, { github, source, SYNC_FILES: POLICY })).result, 'unchanged');
  assert.equal((await run(t, { github, source: { ...source, [POLICY]: 'mode: enforce\n' }, SYNC_FILES: POLICY })).result, 'updated');
  assert.equal(github.filesAt('sync/workflows')[POLICY], 'mode: enforce\n');

  // Closed once the default branch has the source's policy.
  github.push('main', { [POLICY]: 'mode: enforce\n' });
  assert.equal((await run(t, { github, source: { ...source, [POLICY]: 'mode: enforce\n' }, SYNC_FILES: POLICY })).result, 'closed');
});

test('a file named in files is added with add, and skipped when excluded or not in the source', async (t) => {
  const source = { [`${W}/codeql.yml`]: 'v1\n', [POLICY]: 'mode: log\n' };
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  const { result, core } = await run(t, { github, source, SYNC_FILES: POLICY, SYNC_ADD: 'true' });
  assert.equal(result, 'created');
  assert.equal(core.outputs.added, `["${POLICY}"]`);
  assert.equal(github.filesAt('sync/workflows')[POLICY], 'mode: log\n');
  assert.match(github.pulls[0].body, /Adds 1 file of /);

  const excluded = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n', [POLICY]: 'local\n' } });
  assert.equal((await run(t, { github: excluded, source, SYNC_FILES: POLICY, SYNC_ADD: 'true', SYNC_EXCLUDE: POLICY })).result, 'up-to-date');

  const missing = await run(t, { github: mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n', 'other.yaml': 'x\n' } }), source, SYNC_FILES: `${POLICY}, other.yaml`, SYNC_ADD: 'true' });
  assert.match(missing.core.warnings[0], /files lists other\.yaml, but the source checkout has no such file/);
  assert.equal(missing.core.outputs.changed, `["${POLICY}"]`);
});

test('files only takes paths of files outside the workflow directories', async (t) => {
  for (const [files, message] of [
    ['../secrets.yaml', /not a path of a file in the repository/],
    ['/etc/passwd', /not a path of a file in the repository/],
    ['.git/config', /not a path of a file in the repository/],
    [`${W}/codeql.yml`, /synced by file name/],
    ['docs', /not a file in this repository/],
  ]) {
    const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n', 'docs/a.md': 'x\n' } });
    const { result, core } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n', docs: 'x\n' }, SYNC_FILES: files, SYNC_ADD: 'true' });
    assert.equal(result, 'error', files);
    assert.match(core.failed[0], message);
    assert.deepEqual(writes(github), []);
  }
});
