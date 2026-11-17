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
