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
//   unchanged   the open pull request already holds exactly these changes
//   dry-run     copies differ or a retired workflow is left, and dry-run kept this from writing
//               anything
//
// Versions: with ignore-versions, a copy that differs from the source only in the versions it
// references is left as it is. Renovate updates those in every repository from the same releases
// the source follows, so a sync of nothing else would only duplicate its pull request. Such a
// copy counts as matching: it opens no pull request, and it doesn't keep one open. A copy that
// differs in anything else is replaced by the source's, versions included.
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

const path = require('node:path');
const { ConfigError, parseInputs } = require('./inputs');
const { WORKFLOWS, WORKFLOW_FILE, readSource, readSourceFile, render, blobSha } = require('./source');
const { commitMessage, pullRequestBody } = require('./describe');
const { differOnlyInVersions } = require('./versions');

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

function setOutputs(core, { result, changed = [], added = [], removed = [], pullRequest = null }) {
  core.setOutput('result', result);
  core.setOutput('changed', JSON.stringify(changed));
  core.setOutput('added', JSON.stringify(added));
  core.setOutput('removed', JSON.stringify(removed));
  core.setOutput('pull-request-number', pullRequest ? String(pullRequest.number) : '');
  core.setOutput('pull-request-url', pullRequest?.html_url ?? '');
  return result;
}

async function sync({ github, context, core, inputs }) {
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
  for (const copy of copies) {
    if (copy.sha === copy.currentSha) continue;
    if (copy.currentSha === null) {
      copy.before = '';
      copy.added = true;
      changes.push(copy);
      continue;
    }
    copy.before = await readBlob(github, repo, copy.currentSha);
    if (inputs.ignoreVersions && copy.origin !== 'file' && differOnlyInVersions(copy.before, copy.content)) versionOnly.push(copy.name);
    else changes.push(copy);
  }
  const changed = changes.map((change) => change.name);
  const added = changes.filter((change) => change.added).map((change) => change.name);
  if (versionOnly.length) {
    core.info(`${versionOnly.join(', ')} differ from the source only in the versions they reference, and are left to Renovate.`);
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
    await github.rest.issues.createComment({
      ...repo,
      issue_number: pullRequest.number,
      body: versionOnly.length
        ? `Closing: the workflows on \`${defaultBranch}\` now differ from ${sourceRepository} only in the versions they reference, which Renovate updates, so there is nothing left to sync.`
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
  const branchSha = await getBranch(github, repo, branch);
  if (pullRequest && branchSha) {
    const onBranch = await listWorkflows(github, repo, branchSha);
    for (const copy of copies) {
      if (copy.origin === 'file') onBranch.set(copy.path, await fileSha(github, repo, copy.path, branchSha));
    }
    const wanted = (copy) => (changes.includes(copy) ? copy.sha : copy.currentSha);
    const held = (copy) => onBranch.get(copy.origin === 'file' ? copy.path : copy.name);
    if (copies.every((copy) => held(copy) === wanted(copy)) && removals.every((removal) => !onBranch.has(removal.name))) {
      core.notice(`#${pullRequest.number} already holds these changes: ${pullRequest.html_url}`);
      return setOutputs(core, { result: 'unchanged', changed, added, removed, pullRequest });
    }
  }

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

  const body = pullRequestBody(inputs, { defaultBranch, changes, removals, versionOnly, collisions: used });
  let result;
  if (pullRequest) {
    ({ data: pullRequest } = await github.rest.pulls.update({ ...repo, pull_number: pullRequest.number, title, body }));
    result = 'updated';
  } else {
    ({ data: pullRequest } = await github.rest.pulls.create({ ...repo, title, body, head: branch, base: defaultBranch }));
    result = 'created';
  }
  core.notice(`Pull request #${pullRequest.number} ${result}: ${pullRequest.html_url}`);
  return setOutputs(core, { result, changed, added, removed, pullRequest });
}

module.exports = async function main({ github, context, core, env = process.env }) {
  try {
    return await sync({ github, context, core, inputs: parseInputs(env) });
  } catch (error) {
    const hint = isStatus(error, 403, 404) ? ' The token needs contents, pull requests and workflows write on this repository.' : '';
    core.setFailed(`${error.message}${error instanceof ConfigError ? '' : hint}`);
    return 'error';
  }
};
