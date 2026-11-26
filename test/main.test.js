'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BOT, SOURCE, SOURCE_SHA, httpError, mockCore, mockGithub, sourceCheckout, context, env } = require('./helpers');
const main = require('../src/main');

const W = '.github/workflows';
// The calls that change something; getPull only reads.
const writes = (github) => github.calls.map((call) => call.name).filter((name) => name !== 'getPull');

async function run(t, { source, github, ...overrides }) {
  const core = mockCore();
  const waits = [];
  const wait = async (ms) => { waits.push(ms); };
  const result = await main({ github, context, core, env: env(sourceCheckout(t, source), overrides), wait });
  return { result, core, github, waits };
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

test('an open pull request that holds the changes but conflicts is rebuilt from the default branch', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n', [`${W}/actions.lock`]: 'lock: 1\n' } });
  await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  // The fix job updates the lockfile on the pull request, and another pull request on main.
  github.push('sync/workflows', { [`${W}/actions.lock`]: 'lock: sync\n' });
  github.push('main', { [`${W}/actions.lock`]: 'lock: 2\n', 'README.md': 'hello\n' });
  github.mergeable = false;
  github.calls.length = 0;
  const { result, core } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  assert.equal(result, 'updated');
  assert.deepEqual(core.failed, []);
  assert.match(core.notices[0], /#1 already holds these changes, but conflicts with main\. Rebuilding it from main\./);
  assert.deepEqual(writes(github), ['createTree', 'createCommit', 'updateRef', 'updatePull']);
  assert.deepEqual(github.commit(github.refs.get('sync/workflows')).parents, [github.refs.get('main')]);
  assert.deepEqual(github.filesAt('sync/workflows'), {
    [`${W}/codeql.yml`]: 'v2\n',
    [`${W}/actions.lock`]: 'lock: 2\n',
    'README.md': 'hello\n',
  });
  assert.equal(github.pulls.length, 1);
});

test('mergeability GitHub has not worked out yet is asked again, and then left to a later run', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  const head = github.refs.get('sync/workflows');
  github.mergeable = null;
  github.calls.length = 0;
  const { result, core, waits } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  assert.equal(result, 'unchanged');
  assert.equal(github.calls.filter((call) => call.name === 'getPull').length, 4);
  assert.deepEqual(waits, [3000, 3000, 3000]);
  assert.deepEqual(writes(github), []);
  assert.equal(github.refs.get('sync/workflows'), head);
  assert.ok(core.logs.some((line) => /hasn't worked out yet whether #1 conflicts with main/.test(line)));

  // Once GitHub knows, a conflict is found on the next request.
  const answers = [null, false];
  github.mergeable = () => answers.shift();
  github.calls.length = 0;
  const next = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  assert.equal(next.result, 'updated');
  assert.deepEqual(next.waits, [3000]);
});

test('a mergeable pull request is asked about once and left alone', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  github.calls.length = 0;
  const { result, waits } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  assert.equal(result, 'unchanged');
  assert.deepEqual(github.calls.map((call) => call.name), ['getPull']);
  assert.deepEqual(waits, []);
});

test('with force, an open pull request that holds the changes is rebuilt anyway', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  github.push('sync/workflows', { [`${W}/actions.lock`]: 'fixed\n' });
  github.push('main', { 'README.md': 'hello\n' });
  github.calls.length = 0;
  const { result, core } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' }, SYNC_FORCE: 'true' });
  assert.equal(result, 'updated');
  assert.match(core.notices[0], /Rebuilding #1 from main, because force is set\./);
  // Mergeability isn't asked for: the pull request is rebuilt whatever it is.
  assert.deepEqual(github.calls.map((call) => call.name), ['createTree', 'createCommit', 'updateRef', 'updatePull']);
  assert.deepEqual(github.commit(github.refs.get('sync/workflows')).parents, [github.refs.get('main')]);
  assert.deepEqual(github.filesAt('sync/workflows'), { [`${W}/codeql.yml`]: 'v2\n', 'README.md': 'hello\n' });
});

test('force changes nothing without differences, and a dry run with force writes nothing', async (t) => {
  const current = mockGithub({ files: { [`${W}/codeql.yml`]: 'v2\n' } });
  assert.equal((await run(t, { github: current, source: { [`${W}/codeql.yml`]: 'v2\n' }, SYNC_FORCE: 'true' })).result, 'up-to-date');
  assert.deepEqual(writes(current), []);

  const open = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  await run(t, { github: open, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  open.calls.length = 0;
  const { result } = await run(t, { github: open, source: { [`${W}/codeql.yml`]: 'v2\n' }, SYNC_FORCE: 'true', SYNC_DRY_RUN: 'true' });
  assert.equal(result, 'dry-run');
  assert.deepEqual(open.calls, []);
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
  const force = await run(t, { github, source: { [`${W}/a.yml`]: 'a\n' }, SYNC_FORCE: 'yes' });
  assert.match(force.core.failed[0], /SYNC_FORCE must be true or false, not "yes"/);
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
  const before = writes(github).length;
  const second = await run(t, { github, source, SYNC_REMOVE: 'retired.yml' });
  assert.equal(second.result, 'unchanged');
  assert.equal(writes(github).length, before);
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

test('a pull request due for other changes brings the version-only copies too', async (t) => {
  const github = mockGithub({ files: { [`${W}/zizmor.yml`]: caller('v1.2.0'), [`${W}/codeql.yml`]: caller('v1.2.0') } });
  const source = { [`${W}/zizmor.yml`]: caller('v2.0.0', '    with:\n      persona: pedantic\n'), [`${W}/codeql.yml`]: caller('v2.0.0') };
  const { result, core } = await run(t, { github, source, SYNC_IGNORE_VERSIONS: 'true' });
  assert.equal(result, 'created');
  assert.equal(core.outputs.changed, '["zizmor.yml","codeql.yml"]');
  assert.deepEqual(github.filesAt('sync/workflows'), {
    [`${W}/zizmor.yml`]: caller('v2.0.0', '    with:\n      persona: pedantic\n'),
    [`${W}/codeql.yml`]: caller('v2.0.0'),
  });
  assert.doesNotMatch(github.pulls[0].body, /Not updated/);
  assert.match(core.logs.join('\n'), /codeql\.yml differ from the source only in the versions they reference, and are updated with the other changes/);
  // The next run leaves the pull request alone: it holds every copy.
  const before = writes(github).length;
  const again = await run(t, { github, source, SYNC_IGNORE_VERSIONS: 'true' });
  assert.equal(again.result, 'unchanged');
  assert.equal(writes(github).length, before);
});

test('a retired workflow brings the version-only copies too', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: caller('v1.2.0'), [`${W}/old.yml`]: 'old\n' } });
  const source = { [`${W}/codeql.yml`]: caller('v2.0.0') };
  const { result, core } = await run(t, { github, source, SYNC_IGNORE_VERSIONS: 'true', SYNC_REMOVE: 'old.yml' });
  assert.equal(result, 'created');
  assert.equal(core.outputs.changed, '["codeql.yml"]');
  assert.equal(core.outputs.removed, '["old.yml"]');
  assert.equal(github.filesAt('sync/workflows')[`${W}/codeql.yml`], caller('v2.0.0'));
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

test('an open pull request is left alone once Renovate brings a version-only copy to the source', async (t) => {
  const github = mockGithub({ files: { [`${W}/zizmor.yml`]: caller('v1.2.0'), [`${W}/codeql.yml`]: caller('v1.2.0') } });
  const source = { [`${W}/zizmor.yml`]: caller('v2.0.0', '    with:\n      a: b\n'), [`${W}/codeql.yml`]: caller('v2.0.0') };
  await run(t, { github, source, SYNC_IGNORE_VERSIONS: 'true' });
  // Renovate's update of codeql.yml to the source's version is merged.
  github.push('main', { [`${W}/codeql.yml`]: caller('v2.0.0') });
  const before = writes(github).length;
  const { result } = await run(t, { github, source, SYNC_IGNORE_VERSIONS: 'true' });
  assert.equal(result, 'unchanged');
  assert.equal(writes(github).length, before);
});

test('an open pull request keeps a version-only copy at the source version when Renovate stops short', async (t) => {
  const github = mockGithub({ files: { [`${W}/zizmor.yml`]: caller('v1.2.0'), [`${W}/codeql.yml`]: caller('v1.2.0') } });
  const source = { [`${W}/zizmor.yml`]: caller('v2.0.0', '    with:\n      a: b\n'), [`${W}/codeql.yml`]: caller('v2.0.0') };
  await run(t, { github, source, SYNC_IGNORE_VERSIONS: 'true' });
  // Renovate's update of codeql.yml stops short of the source's version.
  github.push('main', { [`${W}/codeql.yml`]: caller('v1.3.0') });
  const { result } = await run(t, { github, source, SYNC_IGNORE_VERSIONS: 'true' });
  assert.equal(result, 'unchanged');
  // The branch already brings codeql.yml to the source's version, which is what it should hold.
  assert.equal(github.filesAt('sync/workflows')[`${W}/codeql.yml`], caller('v2.0.0'));
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
  const before = writes(github).length;
  const again = await run(t, { github, source, SYNC_FILES: POLICY });
  assert.equal(again.result, 'unchanged');
  assert.equal(writes(github).length, before);
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

test('with auto-merge, a new pull request gets auto-merge with that method', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  const { result, core } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' }, SYNC_AUTO_MERGE: 'squash' });
  assert.equal(result, 'created');
  assert.deepEqual(core.failed, []);
  assert.deepEqual(writes(github), ['createTree', 'createCommit', 'createRef', 'createPull', 'enableAutoMerge']);
  assert.equal(github.calls.at(-1).pullRequestId, 'PR_1');
  assert.equal(github.calls.at(-1).mergeMethod, 'SQUASH');
  assert.equal(core.outputs['auto-merge'], 'enabled');
});

test('auto-merge is turned on once, and again on a pull request it was turned off on', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' }, SYNC_AUTO_MERGE: 'squash' });
  github.calls.length = 0;
  const updated = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v3\n' }, SYNC_AUTO_MERGE: 'squash' });
  assert.equal(updated.result, 'updated');
  assert.deepEqual(writes(github), ['createTree', 'createCommit', 'updateRef', 'updatePull']);
  assert.equal(updated.core.outputs['auto-merge'], 'enabled');

  github.pulls[0].auto_merge = null;
  github.calls.length = 0;
  const unchanged = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v3\n' }, SYNC_AUTO_MERGE: 'squash' });
  assert.equal(unchanged.result, 'unchanged');
  assert.deepEqual(writes(github), ['enableAutoMerge']);
});

test('auto-merge GitHub refuses is a warning, and the pull request stays open', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  github.autoMergeError = new Error('Pull request Auto merge is not allowed for this repository.');
  const { result, core } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' }, SYNC_AUTO_MERGE: 'rebase' });
  assert.equal(result, 'created');
  assert.deepEqual(core.failed, []);
  assert.equal(core.outputs['auto-merge'], 'unavailable');
  assert.match(core.warnings.at(-1), /Couldn't turn on auto-merge for #1, so it stays open.*not allowed for this repository/);
  assert.equal(github.pulls[0].state, 'open');
});

test('without auto-merge, or with nothing to sync, auto-merge is left alone', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  const off = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' } });
  assert.equal(off.core.outputs['auto-merge'], '');
  assert.ok(!writes(github).includes('enableAutoMerge'));
  const current = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  const upToDate = await run(t, { github: current, source: { [`${W}/codeql.yml`]: 'v1\n' }, SYNC_AUTO_MERGE: 'squash' });
  assert.equal(upToDate.result, 'up-to-date');
  assert.deepEqual(writes(current), []);
  const dry = await run(t, { github: mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } }), source: { [`${W}/codeql.yml`]: 'v2\n' }, SYNC_AUTO_MERGE: 'squash', SYNC_DRY_RUN: 'true' });
  assert.equal(dry.result, 'dry-run');
  assert.equal(dry.core.outputs['auto-merge'], '');
});

test('a pull request that adds a workflow or a file gets no auto-merge', async (t) => {
  for (const [source, overrides, name] of [
    [{ [`${W}/codeql.yml`]: 'v2\n', [`${W}/new.yml`]: 'name: New\n' }, {}, 'new.yml'],
    [{ [`${W}/codeql.yml`]: 'v2\n', '.github/egress-firewall.yaml': 'mode: log\n' }, { SYNC_FILES: '.github/egress-firewall.yaml' }, '.github/egress-firewall.yaml'],
  ]) {
    const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
    const { result, core } = await run(t, { github, source, SYNC_ADD: 'true', SYNC_AUTO_MERGE: 'squash', ...overrides });
    assert.equal(result, 'created', name);
    assert.deepEqual(core.failed, []);
    assert.deepEqual(writes(github), ['createTree', 'createCommit', 'createRef', 'createPull'], name);
    assert.equal(core.outputs['auto-merge'], 'withheld');
    assert.equal(github.pulls[0].auto_merge, null);
    assert.ok(core.notices.some((notice) => notice.includes(`#1 adds ${name}, which this repository doesn't have yet, so it gets no auto-merge`)), name);
    assert.match(github.pulls[0].body, /Not merged automatically: what it adds would run in this repository for the first time/);
  }
});

test('without auto-merge, the description of a pull request that adds says nothing about merging', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  const { core } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v1\n', [`${W}/new.yml`]: 'n\n' }, SYNC_ADD: 'true' });
  assert.equal(core.outputs['auto-merge'], '');
  assert.doesNotMatch(github.pulls[0].body, /merged automatically/);
});

test('a pull request that only updates and removes still gets auto-merge', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n', [`${W}/retired.yml`]: 'r\n' } });
  const { result, core } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' }, SYNC_ADD: 'true', SYNC_REMOVE: 'retired.yml', SYNC_AUTO_MERGE: 'squash' });
  assert.equal(result, 'created');
  assert.deepEqual(writes(github), ['createTree', 'createCommit', 'createRef', 'createPull', 'enableAutoMerge']);
  assert.equal(core.outputs['auto-merge'], 'enabled');
  assert.doesNotMatch(github.pulls[0].body, /merged automatically/);
});

test('auto-merge is turned off before a pull request that has it is rebuilt to add something', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' }, SYNC_ADD: 'true', SYNC_AUTO_MERGE: 'squash' });
  assert.ok(github.pulls[0].auto_merge);
  github.calls.length = 0;
  const { result, core } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n', [`${W}/new.yml`]: 'n\n' }, SYNC_ADD: 'true', SYNC_AUTO_MERGE: 'squash' });
  assert.equal(result, 'updated');
  assert.deepEqual(core.failed, []);
  assert.deepEqual(writes(github), ['disableAutoMerge', 'createTree', 'createCommit', 'updateRef', 'updatePull']);
  assert.equal(github.pulls[0].auto_merge, null);
  assert.equal(core.outputs['auto-merge'], 'withheld');
  assert.ok(core.notices.includes("Turned off auto-merge for #1, because it adds new.yml, which this repository doesn't have yet."));

  // Once the addition is gone from the source, the update merges itself again.
  github.calls.length = 0;
  const again = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v3\n' }, SYNC_ADD: 'true', SYNC_AUTO_MERGE: 'squash' });
  assert.equal(again.result, 'updated');
  assert.deepEqual(writes(github), ['createTree', 'createCommit', 'updateRef', 'updatePull', 'enableAutoMerge']);
  assert.equal(again.core.outputs['auto-merge'], 'enabled');
});

test('when GitHub refuses to turn auto-merge off, the run fails and nothing is pushed', async (t) => {
  const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
  await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n' }, SYNC_AUTO_MERGE: 'squash' });
  const head = github.refs.get('sync/workflows');
  github.disableAutoMergeError = new Error('Resource not accessible by integration');
  github.calls.length = 0;
  const { result, core } = await run(t, { github, source: { [`${W}/codeql.yml`]: 'v2\n', [`${W}/new.yml`]: 'n\n' }, SYNC_ADD: 'true', SYNC_AUTO_MERGE: 'squash' });
  assert.equal(result, 'error');
  assert.match(core.failed[0], /Couldn't turn off auto-merge for #1, which adds new.yml, which this repository doesn't have yet: Resource not accessible by integration/);
  assert.deepEqual(writes(github), ['disableAutoMerge']);
  assert.equal(github.refs.get('sync/workflows'), head);
});

test('a pull request left alone that adds something loses only the auto-merge the sync turned on', async (t) => {
  const source = { [`${W}/codeql.yml`]: 'v2\n', [`${W}/new.yml`]: 'n\n' };
  const inputs = { SYNC_ADD: 'true', SYNC_AUTO_MERGE: 'squash' };
  for (const [enabledBy, expected] of [
    [BOT, ['disableAutoMerge']],
    ['octocat', []],
  ]) {
    const github = mockGithub({ files: { [`${W}/codeql.yml`]: 'v1\n' } });
    await run(t, { github, source, ...inputs });
    // The pull request of an earlier version of the action, or one a person turned auto-merge on for.
    github.pulls[0].auto_merge = { merge_method: 'squash', enabled_by: { login: enabledBy } };
    github.calls.length = 0;
    const { result, core } = await run(t, { github, source, ...inputs });
    assert.equal(result, 'unchanged', enabledBy);
    assert.deepEqual(core.failed, []);
    assert.deepEqual(writes(github), expected, enabledBy);
    assert.equal(core.outputs['auto-merge'], 'withheld');
    assert.equal(Boolean(github.pulls[0].auto_merge), enabledBy !== BOT, enabledBy);
  }
});

test('auto-merge only takes a merge method', async (t) => {
  const { core } = await run(t, { github: mockGithub(), source: { [`${W}/a.yml`]: 'a\n' }, SYNC_AUTO_MERGE: 'fast-forward' });
  assert.match(core.failed[0], /auto-merge must be empty or one of merge, squash, rebase, not "fast-forward"/);
});
