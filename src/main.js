'use strict';

// The entry point, called by actions/github-script with its github (Octokit), context and core.
//
// It runs in the repository whose workflows it updates, the target, and reads the source from a
// checkout the workflow made. Everything on the target goes through the API: no clone, no git
// identity, and the commit is signed by GitHub for the token's app.
//
// The result is one of:
//   skipped     the target is the source
//   up-to-date  every copy matches the source, nothing is missing, no retired workflow is left,
//               and no sync pull request is open
//   closed      the same, so the open sync pull request was closed
//   created     a pull request was opened
//   updated     the branch of the open pull request was rebuilt and its description rewritten
//   unchanged   the open pull request already holds exactly these changes, and doesn't conflict
//               with the default branch
//   dry-run     copies differ or a retired workflow is left, and dry-run kept this from writing
//               anything
//
// Versions: with ignore-versions, differences only in the versions the copies reference open no
// pull request. Renovate updates those in every repository from the same releases the source
// follows, so a sync of nothing else would only duplicate its pull request: when nothing else
// differs and no retired workflow is left, the run opens nothing and closes the open pull request.
// When anything else differs, the pull request brings every copy up to the source, the copies
// that differ only in versions included.
//
// Whitespace: unless ignore-whitespace is false, a copy that differs from the source only in
// whitespace, but not in indentation, is left as it is too. A repository that runs a formatter
// respaces what the sync brings in, as oxfmt does to aligned comments, so a sync of nothing else
// would only be formatted back, and the next sync would bring the same spacing in again. Such a
// copy counts as matching, whatever it is, files included. For the same reason, an open pull
// request whose branch a formatter respaced is left alone.
//
// Other files: a path in `files` is a file of the source that isn't a workflow, such as the
// egress firewall's policy, which the synced workflows run under. It is copied as it is to the
// same path, and compared as a whole: versions are never ignored in it.
//
// Adding: without `add`, only the copies the target already has are updated. With it, the target
// also gets what it lacks: every workflow in the source's .github/workflows, and every path in
// `files`. A workflow template is never added: it is for the repositories that picked it. An
// excluded name or path is never added, which is how a repository keeps one out.
//
// Retired workflows: a name in `remove` is a workflow the source used to offer and withdrew. A
// target that still has it loses it in the same pull request. A name the source still has isn't
// retired, so it is kept with a warning, whichever of the two is changed first. An excluded name
// is never touched.
//
// Conflicts: an open pull request that already holds the changes is left alone, so its checks
// don't restart and a commit a fix job added, such as the lockfile's, stays. But that commit can
// come to conflict with the default branch, when actions.lock changes there too, and nothing the
// sync compares would ever change, so the pull request would stay unmergeable. So it is left
// alone only while GitHub doesn't report a conflict: one that conflicts is rebuilt from the
// default branch, and the fix job runs again on the new commit. GitHub works mergeability out in
// the background, so it may not know yet; then the pull request is left alone, and a later run
// looks again.
//
// Auto-merge: with auto-merge set to a merge method, the sync pull request that is left open,
// whether it was just created, updated or left alone, gets GitHub's auto-merge with that method,
// unless it has it already or it adds something; see below. GitHub then merges it once the
// default branch's rules are met, its required checks and reviews included, so a sync that passes
// them needs no one to merge it. A
// pull request someone turned auto-merge off on gets it again from the next run that writes or
// looks at it. When GitHub refuses, as in a repository that doesn't allow auto-merge, or for a pull
// request that is mergeable right away because nothing is required of it, that is a warning and
// the pull request stays open: merging it without waiting for anything is left to a person.
//
// A pull request that adds a workflow or a file the target doesn't have yet never gets
// auto-merge: a new workflow runs with the repository's permissions and secrets, so a person
// reviews and merges it. Updates and removals of what the target already runs merge themselves as
// before. Auto-merge is turned off, before anything is pushed, when the sync rebuilds a pull
// request that has it into one that adds something, so the new commit can't merge on the old
// decision. A pull request that is left alone keeps auto-merge a person turned on, after reviewing
// what it adds; one the sync itself turned on, as the account that opened the pull request, is
// turned off. When GitHub refuses to turn it off, the run fails, and nothing is pushed.
//
// Force: with force, the open pull request is rebuilt from the default branch even when it
// already holds the changes, and its description is rewritten. That is the manual way to
// recreate it. Without differences there is nothing to rebuild, and force changes nothing.

const path = require('node:path');
const { ConfigError, parseInputs } = require('./inputs');
const { WORKFLOWS, WORKFLOW_FILE, readSource, readSourceFile, render, blobSha } = require('./source');
const { commitMessage, pullRequestBody } = require('./describe');
const { differOnlyInVersions } = require('./versions');
const { withoutWhitespace, differOnlyInWhitespace } = require('./whitespace');

function isStatus(error, ...statuses) {
  return statuses.includes(error?.status);
}

// The workflow files of the target at a commit: Map<name, blob SHA>. Empty without the directory.
async function listWorkflows(github, repo, ref) {
  let data;
  try {
    ({ data } = await github.rest.repos.getContent({ ...repo, path: WORKFLOWS, ref }));
  } catch (error) {
    if (isStatus(error, 404)) return new Map();
    throw error;
  }
  if (!Array.isArray(data)) return new Map();
  return new Map(data.filter((entry) => entry.type === 'file' && WORKFLOW_FILE.test(entry.name)).map((entry) => [entry.name, entry.sha]));
}

// The blob SHA of a file of the target at a commit, or null when it isn't there.
async function fileSha(github, repo, file, ref) {
  let data;
  try {
    ({ data } = await github.rest.repos.getContent({ ...repo, path: file, ref }));
  } catch (error) {
    if (isStatus(error, 404)) return null;
    throw error;
  }
  if (Array.isArray(data) || data.type !== 'file') throw new ConfigError(`files lists ${file}, which is not a file in this repository.`);
  return data.sha;
}

async function getBranch(github, repo, branch) {
  try {
    const { data } = await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
    return data.object.sha;
  } catch (error) {
    if (isStatus(error, 404)) return null;
    throw error;
  }
}

async function readBlob(github, repo, sha) {
  const { data } = await github.rest.git.getBlob({ ...repo, file_sha: sha });
  return Buffer.from(data.content, data.encoding).toString('utf8');
}

// Points the branch at the commit, whether or not it exists. A sync pull request that is still
// open keeps its branch, and so does a closed one whose branch wasn't deleted: both are
// overwritten, which is what a force push would do.
async function setBranch(github, repo, branch, sha, exists) {
  if (!exists) {
    try {
      await github.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha });
      return;
    } catch (error) {
      // Created since it was looked up. The message isn't compared: Octokit appends a URL to it.
      if (!isStatus(error, 422)) throw error;
    }
  }
  await github.rest.git.updateRef({ ...repo, ref: `heads/${branch}`, sha, force: true });
}

// Whether GitHub reports the pull request as conflicting with its base: true, false, or null when
// it hasn't worked that out yet. A request for the pull request starts the work, so it is asked
// again a few times, a few seconds apart.
const MERGEABLE_ATTEMPTS = 4;
const MERGEABLE_INTERVAL_MS = 3000;

async function conflicts(github, repo, number, wait) {
  for (let attempt = 1; ; attempt++) {
    const { data } = await github.rest.pulls.get({ ...repo, pull_number: number });
    if (data.mergeable === false) return true;
    if (data.mergeable === true) return false;
    if (attempt === MERGEABLE_ATTEMPTS) return null;
    await wait(MERGEABLE_INTERVAL_MS);
  }
}

// Turns GitHub's auto-merge on for the pull request with the merge method, unless it is on. REST
// has no endpoint for it, so it goes through GraphQL. Returns "enabled", or "unavailable" when
// GitHub refused, which is a warning: the pull request is open, and a person can merge it.
const ENABLE_AUTO_MERGE = `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
    pullRequest { number }
  }
}`;

async function enableAutoMerge(github, core, pullRequest, method) {
  if (pullRequest.auto_merge) return 'enabled';
  try {
    await github.graphql(ENABLE_AUTO_MERGE, { pullRequestId: pullRequest.node_id, mergeMethod: method.toUpperCase() });
  } catch (error) {
    core.warning(`Couldn't turn on auto-merge for #${pullRequest.number}, so it stays open for a person to merge: ${error.message} Auto-merge needs "Allow auto-merge" in the repository's settings, the ${method} merge method allowed, and something the default branch requires, such as a check, still to wait for.`);
    return 'unavailable';
  }
  core.notice(`Turned on auto-merge (${method}) for #${pullRequest.number}.`);
  return 'enabled';
}

// Turns GitHub's auto-merge off for the pull request, if it is on. Unlike turning it on, a refusal
// fails the run: the pull request would merge what it adds without a person.
const DISABLE_AUTO_MERGE = `mutation($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
    pullRequest { number }
  }
}`;

async function disableAutoMerge(github, core, pullRequest, reason) {
  if (!pullRequest.auto_merge) return;
  try {
    await github.graphql(DISABLE_AUTO_MERGE, { pullRequestId: pullRequest.node_id });
  } catch (error) {
    throw new Error(`Couldn't turn off auto-merge for #${pullRequest.number}, which ${reason}: ${error.message}`);
  }
  pullRequest.auto_merge = null;
  core.notice(`Turned off auto-merge for #${pullRequest.number}, because it ${reason}.`);
}

// What auto-merge the pull request that is left open gets: enabled or unavailable from
// enableAutoMerge, withheld when it adds something, or empty without the input.
async function autoMergeFor(github, core, inputs, pullRequest, added) {
  if (!inputs.autoMerge) return '';
  if (!added.length) return enableAutoMerge(github, core, pullRequest, inputs.autoMerge);
  core.notice(`#${pullRequest.number} adds ${added.join(', ')}, which this repository doesn't have yet, so it gets no auto-merge: a person reviews and merges it.`);
  return 'withheld';
}

// The words for a pull request that adds these.
const adding = (added) => `adds ${added.join(', ')}, which this repository doesn't have yet`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setOutputs(core, { result, changed = [], added = [], removed = [], pullRequest = null, autoMerge = '' }) {
  core.setOutput('result', result);
  core.setOutput('changed', JSON.stringify(changed));
  core.setOutput('added', JSON.stringify(added));
  core.setOutput('removed', JSON.stringify(removed));
  core.setOutput('pull-request-number', pullRequest ? String(pullRequest.number) : '');
  core.setOutput('pull-request-url', pullRequest?.html_url ?? '');
  core.setOutput('auto-merge', autoMerge);
  return result;
}

async function sync({ github, context, core, inputs, wait }) {
  const repo = context.repo;
  inputs.repository = `${repo.owner}/${repo.repo}`;
  const { sourceRepository, branch, title, dryRun } = inputs;
  if (inputs.repository.toLowerCase() === sourceRepository.toLowerCase()) {
    core.notice(`${inputs.repository} is the source. Nothing to sync.`);
    return setOutputs(core, { result: 'skipped' });
  }

  const root = path.resolve(inputs.workspace, inputs.sourcePath);
  const { files: source, collisions } = readSource(root);
  if (source.size === 0) {
    throw new ConfigError(`No workflow was found in ${WORKFLOWS} or workflow-templates of the source checkout at "${inputs.sourcePath}".`);
  }

  const { data: repository } = await github.rest.repos.get(repo);
  const defaultBranch = repository.default_branch;
  const { data: base } = await github.rest.repos.getBranch({ ...repo, branch: defaultBranch });
  const baseSha = base.commit.sha;
  const existing = await listWorkflows(github, repo, baseSha);

  // Every file the target should have a copy of, with the content it should have: the copies it
  // has and, with `add`, those it lacks. `currentSha` is null for one it lacks. `changes` are
  // those that differ or are missing.
  const copies = [];
  for (const [name, file] of source) {
    if (inputs.exclude.has(name)) continue;
    const currentSha = existing.get(name) ?? null;
    // A template is for the repositories that picked it, so it is never added.
    if (currentSha === null && !(inputs.add && file.origin === 'workflow')) continue;
    const rendered = render(file, defaultBranch);
    if (rendered.unsupported) {
      core.warning(`${file.path} uses ${rendered.unsupported.join(', ')}, which can't be synced. Skipping ${name}.`);
      continue;
    }
    copies.push({ name, path: `${WORKFLOWS}/${name}`, origin: file.origin, sourcePath: file.path, content: rendered.content, sha: blobSha(rendered.content), currentSha });
  }
  for (const file of inputs.files) {
    if (inputs.exclude.has(file)) continue;
    const content = readSourceFile(root, file);
    if (content === null) {
      core.warning(`files lists ${file}, but the source checkout has no such file. Skipping ${file}.`);
      continue;
    }
    const currentSha = await fileSha(github, repo, file, baseSha);
    if (currentSha === null && !inputs.add) continue;
    copies.push({ name: file, path: file, origin: 'file', sourcePath: file, content, sha: blobSha(content), currentSha });
  }
  const used = collisions.filter((name) => copies.some((copy) => copy.origin !== 'file' && copy.name === name));
  for (const name of used) {
    core.warning(`The source has ${name} in both ${WORKFLOWS} and workflow-templates. Using ${WORKFLOWS}/${name}.`);
  }
  const changes = [];
  const versionOnly = [];
  const whitespaceOnly = [];
  const normalize = (text) => (inputs.ignoreWhitespace ? withoutWhitespace(text) : text);
  for (const copy of copies) {
    if (copy.sha === copy.currentSha) continue;
    if (copy.currentSha === null) {
      copy.before = '';
      copy.added = true;
      changes.push(copy);
      continue;
    }
    copy.before = await readBlob(github, repo, copy.currentSha);
    if (inputs.ignoreWhitespace && differOnlyInWhitespace(copy.before, copy.content)) whitespaceOnly.push(copy.name);
    else if (inputs.ignoreVersions && copy.origin !== 'file' && differOnlyInVersions(normalize(copy.before), normalize(copy.content))) versionOnly.push(copy);
    else changes.push(copy);
  }
  if (whitespaceOnly.length) {
    core.info(`${whitespaceOnly.join(', ')} differ from the source only in whitespace, and are left to the repository's formatter.`);
  }
  const removals = [];
  for (const name of inputs.remove) {
    if (!existing.has(name) || inputs.exclude.has(name)) continue;
    if (source.has(name)) {
      core.warning(`remove lists ${name}, but the source still has it. Keeping ${name}.`);
      continue;
    }
    removals.push({ name, currentSha: existing.get(name) });
  }
  // Versions only hold a pull request back: once one is due, it brings them too.
  if (versionOnly.length && (changes.length || removals.length)) {
    core.info(`${versionOnly.map((copy) => copy.name).join(', ')} differ from the source only in the versions they reference, and are updated with the other changes.`);
    changes.push(...versionOnly.splice(0));
  } else if (versionOnly.length) {
    core.info(`${versionOnly.map((copy) => copy.name).join(', ')} differ from the source only in the versions they reference, and are left to Renovate.`);
  }
  const changed = changes.map((change) => change.name);
  const added = changes.filter((change) => change.added).map((change) => change.name);
  const removed = removals.map((removal) => removal.name);
  core.info(`${copies.length} files of ${sourceRepository} are synced to ${inputs.repository}; ${changes.length - added.length} differ and ${added.length} are missing. ${removals.length} retired workflows are left.`);

  const { data: open } = await github.rest.pulls.list({ ...repo, state: 'open', head: `${repo.owner}:${branch}`, base: defaultBranch, per_page: 1 });
  let pullRequest = open[0] ?? null;

  if (changes.length === 0 && removals.length === 0) {
    if (!pullRequest) return setOutputs(core, { result: 'up-to-date' });
    if (dryRun) {
      core.notice(`Dry run: would close #${pullRequest.number}, because ${defaultBranch} now matches the source.`);
      return setOutputs(core, { result: 'dry-run', pullRequest });
    }
    const left = [
      ...(versionOnly.length ? ['in the versions they reference, which Renovate updates'] : []),
      ...(whitespaceOnly.length ? ["in whitespace, which the repository's formatter sets"] : []),
    ];
    await github.rest.issues.createComment({
      ...repo,
      issue_number: pullRequest.number,
      body: left.length
        ? `Closing: the workflows on \`${defaultBranch}\` now differ from ${sourceRepository} only ${left.join(', and ')}, so there is nothing left to sync.`
        : `Closing: the workflows on \`${defaultBranch}\` now match ${sourceRepository}, so there is nothing left to sync.`,
    });
    await github.rest.pulls.update({ ...repo, pull_number: pullRequest.number, state: 'closed' });
    try {
      await github.rest.git.deleteRef({ ...repo, ref: `heads/${branch}` });
    } catch (error) {
      if (!isStatus(error, 404, 422)) throw error;
    }
    core.notice(`Closed #${pullRequest.number}: ${defaultBranch} now matches the source.`);
    return setOutputs(core, { result: 'closed', pullRequest });
  }

  for (const change of changes) core.info(`  ${change.path} ${change.added ? 'is missing; the source has' : 'differs from'} ${change.sourcePath}`);
  for (const removal of removals) core.info(`  ${WORKFLOWS}/${removal.name} is retired`);
  if (dryRun) {
    const plans = [];
    const updated = changed.filter((name) => !added.includes(name));
    if (updated.length) plans.push(`${updated.join(', ')} would be updated from ${sourceRepository}`);
    if (added.length) plans.push(`${added.join(', ')} would be added from ${sourceRepository}`);
    if (removed.length) plans.push(`${removed.join(', ')} would be removed`);
    core.notice(`Dry run: ${plans.join('; ')}.`);
    return setOutputs(core, { result: 'dry-run', changed, added, removed, pullRequest });
  }

  // The open pull request is left alone when its branch already has every copy as it should be
  // and no retired workflow, so a daily run doesn't restart its checks or drop commits that a fix
  // job added to it. A copy that isn't updated should be on the branch as it is on the default
  // branch. A file from `files` isn't in the workflow listing, so it is looked up by its path.
  // Unless ignore-whitespace is false, a copy a formatter respaced on the branch is as it should be.
  // It is rebuilt all the same when it conflicts with the default branch, or with force.
  const branchSha = await getBranch(github, repo, branch);
  if (pullRequest && branchSha && inputs.force) {
    core.notice(`Rebuilding #${pullRequest.number} from ${defaultBranch}, because force is set.`);
  } else if (pullRequest && branchSha) {
    const onBranch = await listWorkflows(github, repo, branchSha);
    for (const copy of copies) {
      if (copy.origin === 'file') onBranch.set(copy.path, await fileSha(github, repo, copy.path, branchSha));
    }
    const updated = (copy) => changes.includes(copy);
    const holds = async (copy) => {
      const wanted = updated(copy) ? copy.sha : copy.currentSha;
      const held = onBranch.get(copy.origin === 'file' ? copy.path : copy.name) ?? null;
      if (held === wanted) return true;
      if (!inputs.ignoreWhitespace || held === null || wanted === null) return false;
      // A copy left alone that differs from the source has its default branch content in before.
      const content = updated(copy) || copy.sha === copy.currentSha ? copy.content : copy.before;
      return withoutWhitespace(await readBlob(github, repo, held)) === withoutWhitespace(content);
    };
    let holdsAll = removals.every((removal) => !onBranch.has(removal.name));
    for (const copy of copies) holdsAll &&= await holds(copy);
    if (holdsAll) {
      const conflicting = await conflicts(github, repo, pullRequest.number, wait);
      if (conflicting) {
        core.notice(`#${pullRequest.number} already holds these changes, but conflicts with ${defaultBranch}. Rebuilding it from ${defaultBranch}.`);
      } else {
        if (conflicting === null) core.info(`GitHub hasn't worked out yet whether #${pullRequest.number} conflicts with ${defaultBranch}. A later run looks again.`);
        core.notice(`#${pullRequest.number} already holds these changes: ${pullRequest.html_url}`);
        // Auto-merge a person turned on stays: they decided on what it adds. One this sync turned
        // on, as the account that opened it, goes.
        const enabledBy = pullRequest.auto_merge?.enabled_by?.login;
        if (inputs.autoMerge && added.length && enabledBy && enabledBy === pullRequest.user?.login) {
          await disableAutoMerge(github, core, pullRequest, adding(added));
        }
        const autoMerge = await autoMergeFor(github, core, inputs, pullRequest, added);
        return setOutputs(core, { result: 'unchanged', changed, added, removed, pullRequest, autoMerge });
      }
    }
  }

  // Before the push, so the commit that adds something never has auto-merge on, whoever turned it
  // on for the commits before.
  if (pullRequest && inputs.autoMerge && added.length) await disableAutoMerge(github, core, pullRequest, adding(added));

  const { data: tree } = await github.rest.git.createTree({
    ...repo,
    base_tree: base.commit.commit.tree.sha,
    // An entry without a blob deletes the path.
    tree: [
      ...changes.map((change) => ({ path: change.path, mode: '100644', type: 'blob', content: change.content })),
      ...removals.map((removal) => ({ path: `${WORKFLOWS}/${removal.name}`, mode: '100644', type: 'blob', sha: null })),
    ],
  });
  // No author or committer: GitHub then attributes the commit to the token's app and signs it.
  const { data: commit } = await github.rest.git.createCommit({ ...repo, message: commitMessage(inputs, changes, removals), tree: tree.sha, parents: [baseSha] });
  await setBranch(github, repo, branch, commit.sha, branchSha !== null);

  const body = pullRequestBody(inputs, { defaultBranch, changes, removals, whitespaceOnly, collisions: used });
  let result;
  if (pullRequest) {
    ({ data: pullRequest } = await github.rest.pulls.update({ ...repo, pull_number: pullRequest.number, title, body }));
    result = 'updated';
  } else {
    ({ data: pullRequest } = await github.rest.pulls.create({ ...repo, title, body, head: branch, base: defaultBranch }));
    result = 'created';
  }
  core.notice(`Pull request #${pullRequest.number} ${result}: ${pullRequest.html_url}`);
  const autoMerge = await autoMergeFor(github, core, inputs, pullRequest, added);
  return setOutputs(core, { result, changed, added, removed, pullRequest, autoMerge });
}

module.exports = async function main({ github, context, core, env = process.env, wait = sleep }) {
  try {
    return await sync({ github, context, core, inputs: parseInputs(env), wait });
  } catch (error) {
    const hint = isStatus(error, 403, 404) ? ' The token needs contents, pull requests and workflows write on this repository.' : '';
    core.setFailed(`${error.message}${error instanceof ConfigError ? '' : hint}`);
    return 'error';
  }
};
