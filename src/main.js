'use strict';

// The entry point, called by actions/github-script with its github (Octokit), context and core.
//
// It runs in the repository whose workflows it updates, the target, and reads the source from a
// checkout the workflow made. Everything on the target goes through the API: no clone, no git
// identity, and the commit is signed by GitHub for the token's app.
//
// The result is one of:
//   skipped     the target is the source
//   up-to-date  every copy matches the source, no retired workflow is left, and no sync pull
//               request is open
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
// Retired workflows: a name in `remove` is a workflow the source used to offer and withdrew. A
// target that still has it loses it in the same pull request. A name the source still has isn't
// retired, so it is kept with a warning, whichever of the two is changed first. An excluded name
// is never touched.

const path = require('node:path');
const { ConfigError, parseInputs } = require('./inputs');
const { WORKFLOWS, WORKFLOW_FILE, readSource, render, blobSha } = require('./source');
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

function setOutputs(core, { result, changed = [], removed = [], pullRequest = null }) {
  core.setOutput('result', result);
  core.setOutput('changed', JSON.stringify(changed));
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

  const { files: source, collisions } = readSource(path.resolve(inputs.workspace, inputs.sourcePath));
  if (source.size === 0) {
    throw new ConfigError(`No workflow was found in ${WORKFLOWS} or workflow-templates of the source checkout at "${inputs.sourcePath}".`);
  }

  const { data: repository } = await github.rest.repos.get(repo);
  const defaultBranch = repository.default_branch;
  const { data: base } = await github.rest.repos.getBranch({ ...repo, branch: defaultBranch });
  const baseSha = base.commit.sha;
  const existing = await listWorkflows(github, repo, baseSha);

  // Every copy the target has, with the content it should have. `changes` are those that differ.
  const copies = [];
  for (const [name, sha] of existing) {
    const file = source.get(name);
    if (!file || inputs.exclude.has(name)) continue;
    const rendered = render(file, defaultBranch);
    if (rendered.unsupported) {
      core.warning(`${file.path} uses ${rendered.unsupported.join(', ')}, which can't be synced. Skipping ${name}.`);
      continue;
    }
    copies.push({ name, origin: file.origin, sourcePath: file.path, content: rendered.content, sha: blobSha(rendered.content), currentSha: sha });
  }
  const used = collisions.filter((name) => copies.some((copy) => copy.name === name));
  for (const name of used) {
    core.warning(`The source has ${name} in both ${WORKFLOWS} and workflow-templates. Using ${WORKFLOWS}/${name}.`);
  }
  const changes = [];
  const versionOnly = [];
  for (const copy of copies) {
    if (copy.sha === copy.currentSha) continue;
    copy.before = await readBlob(github, repo, copy.currentSha);
    if (inputs.ignoreVersions && differOnlyInVersions(copy.before, copy.content)) versionOnly.push(copy.name);
    else changes.push(copy);
  }
  const changed = changes.map((change) => change.name);
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
  core.info(`${copies.length} of the ${existing.size} workflows of ${inputs.repository} are copies of a workflow of ${sourceRepository}; ${changes.length} differ. ${removals.length} retired workflows are left.`);

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

  for (const change of changes) core.info(`  ${WORKFLOWS}/${change.name} differs from ${change.sourcePath}`);
  for (const removal of removals) core.info(`  ${WORKFLOWS}/${removal.name} is retired`);
  if (dryRun) {
    const plans = [];
    if (changed.length) plans.push(`${changed.join(', ')} would be updated from ${sourceRepository}`);
    if (removed.length) plans.push(`${removed.join(', ')} would be removed`);
    core.notice(`Dry run: ${plans.join('; ')}.`);
    return setOutputs(core, { result: 'dry-run', changed, removed, pullRequest });
  }

  // The open pull request is left alone when its branch already has every copy as it should be
  // and no retired workflow, so a daily run doesn't restart its checks or drop commits that a fix
  // job added to it. A copy that isn't updated should be on the branch as it is on the default
  // branch.
  const branchSha = await getBranch(github, repo, branch);
  if (pullRequest && branchSha) {
    const onBranch = await listWorkflows(github, repo, branchSha);
    const wanted = (copy) => (changes.includes(copy) ? copy.sha : copy.currentSha);
    if (copies.every((copy) => onBranch.get(copy.name) === wanted(copy)) && removals.every((removal) => !onBranch.has(removal.name))) {
      core.notice(`#${pullRequest.number} already holds these changes: ${pullRequest.html_url}`);
      return setOutputs(core, { result: 'unchanged', changed, removed, pullRequest });
    }
  }

  const { data: tree } = await github.rest.git.createTree({
    ...repo,
    base_tree: base.commit.commit.tree.sha,
    // An entry without a blob deletes the path.
    tree: [
      ...changes.map((change) => ({ path: `${WORKFLOWS}/${change.name}`, mode: '100644', type: 'blob', content: change.content })),
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
  return setOutputs(core, { result, changed, removed, pullRequest });
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
