'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { blobSha } = require('../src/source');

const SOURCE = 'acme/.github';
const SOURCE_SHA = 'a'.repeat(40);
// The account of the action's token, which opens the pull requests.
const BOT = 'sync-app[bot]';

function httpError(status, message) {
  return Object.assign(new Error(`${message} - https://docs.github.com/rest`), { status });
}

function mockCore() {
  const core = { outputs: {}, logs: [], warnings: [], notices: [], failed: [] };
  core.setOutput = (name, value) => { core.outputs[name] = value; };
  core.info = (message) => core.logs.push(message);
  core.warning = (message) => core.warnings.push(message);
  core.notice = (message) => core.notices.push(message);
  core.setFailed = (message) => core.failed.push(message);
  return core;
}

// A source checkout on disk. `files` maps paths relative to its root to contents.
function sourceCheckout(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-workflows-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

// A target repository in memory, behind the parts of Octokit the action uses. `files` maps paths
// to contents on the default branch. Every write is recorded in `calls`.
function mockGithub({ files = {}, defaultBranch = 'main' } = {}) {
  const trees = new Map();
  const commits = new Map();
  const blobs = new Map();
  const refs = new Map();
  const pulls = [];
  const comments = [];
  const calls = [];
  let counter = 0;
  const id = (prefix) => `${prefix}${String(++counter).padStart(39, '0')}`;
  const addTree = (tree) => {
    const sha = id('t');
    trees.set(sha, tree);
    for (const content of Object.values(tree)) blobs.set(blobSha(content), content);
    return sha;
  };
  const addCommit = (tree, parents, message = '') => {
    const sha = id('c');
    commits.set(sha, { tree, parents, message });
    return sha;
  };
  refs.set(defaultBranch, addCommit(addTree(files), []));
  const record = (name, args) => calls.push({ name, ...args });

  const github = {
    mergeable: true,
    // What enablePullRequestAutoMerge fails with, e.g. httpError(...), or null when it succeeds.
    autoMergeError: null,
    // What disablePullRequestAutoMerge fails with, or null when it succeeds.
    disableAutoMergeError: null,
    // Only enablePullRequestAutoMerge and disablePullRequestAutoMerge go through GraphQL. The
    // action's token is the account that opened the pull requests, and turns auto-merge on.
    graphql: async (query, { pullRequestId, mergeMethod }) => {
      const pull = pulls.find((candidate) => candidate.node_id === pullRequestId);
      if (/disablePullRequestAutoMerge/.test(query)) {
        record('disableAutoMerge', { pullRequestId });
        if (github.disableAutoMergeError) throw github.disableAutoMergeError;
        pull.auto_merge = null;
        return { disablePullRequestAutoMerge: { pullRequest: { number: pull.number } } };
      }
      record('enableAutoMerge', { pullRequestId, mergeMethod });
      if (!/enablePullRequestAutoMerge/.test(query)) throw new Error(`Unexpected GraphQL query: ${query}`);
      if (github.autoMergeError) throw github.autoMergeError;
      pull.auto_merge = { merge_method: mergeMethod.toLowerCase(), enabled_by: { login: BOT } };
      return { enablePullRequestAutoMerge: { pullRequest: { number: pull.number } } };
    },
    calls,
    refs,
    pulls,
    comments,
    commit: (sha) => commits.get(sha),
    filesAt: (branch) => trees.get(commits.get(refs.get(branch)).tree),
    // A push to a branch that isn't this action's, e.g. a fix job's commit on the pull request.
    push: (branch, changes) => {
      const parent = refs.get(branch);
      refs.set(branch, addCommit(addTree({ ...trees.get(commits.get(parent).tree), ...changes }), [parent]));
    },
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: defaultBranch } }),
        getBranch: async ({ branch }) => {
          const sha = refs.get(branch);
          return { data: { commit: { sha, commit: { tree: { sha: commits.get(sha).tree } } } } };
        },
        getContent: async ({ path: directory, ref }) => {
          const tree = trees.get(commits.get(ref).tree);
          if (tree[directory] !== undefined) return { data: { type: 'file', name: path.posix.basename(directory), sha: blobSha(tree[directory]) } };
          const entries = Object.entries(tree)
            .filter(([file]) => path.posix.dirname(file) === directory)
            .map(([file, content]) => ({ type: 'file', name: path.posix.basename(file), sha: blobSha(content) }));
          if (entries.length === 0) throw httpError(404, 'Not Found');
          return { data: entries };
        },
      },
      git: {
        getRef: async ({ ref }) => {
          const sha = refs.get(ref.replace(/^heads\//, ''));
          if (!sha) throw httpError(404, 'Not Found');
          return { data: { object: { sha } } };
        },
        getBlob: async ({ file_sha }) => ({ data: { content: Buffer.from(blobs.get(file_sha)).toString('base64'), encoding: 'base64' } }),
        createTree: async ({ base_tree, tree }) => {
          record('createTree', { paths: tree.map((entry) => entry.path) });
          const next = { ...trees.get(base_tree) };
          for (const entry of tree) {
            if (entry.sha === null) delete next[entry.path];
            else next[entry.path] = entry.content;
          }
          return { data: { sha: addTree(next) } };
        },
        createCommit: async ({ message, tree, parents }) => {
          record('createCommit', { message, parents });
          return { data: { sha: addCommit(tree, parents, message) } };
        },
        createRef: async ({ ref, sha }) => {
          const branch = ref.replace(/^refs\/heads\//, '');
          if (refs.has(branch)) throw httpError(422, 'Reference already exists');
          record('createRef', { branch, sha });
          refs.set(branch, sha);
          return { data: {} };
        },
        updateRef: async ({ ref, sha, force }) => {
          const branch = ref.replace(/^heads\//, '');
          record('updateRef', { branch, sha, force });
          refs.set(branch, sha);
          return { data: {} };
        },
        deleteRef: async ({ ref }) => {
          const branch = ref.replace(/^heads\//, '');
          record('deleteRef', { branch });
          refs.delete(branch);
          return { data: {} };
        },
      },
      pulls: {
        // github.mergeable is what GitHub reports: true, false or null while it works it out. A
        // function is called once per request, so a test can make it change between them.
        get: async ({ pull_number }) => {
          record('getPull', { number: pull_number });
          const pull = pulls.find((candidate) => candidate.number === pull_number);
          const mergeable = typeof github.mergeable === 'function' ? github.mergeable() : github.mergeable;
          return { data: { ...pull, mergeable } };
        },
        list: async ({ head, base, state }) => ({
          data: pulls.filter((pull) => pull.state === state && pull.base.ref === base && `acme:${pull.head.ref}` === head),
        }),
        create: async ({ title, body, head, base }) => {
          record('createPull', { title, head, base });
          const number = pulls.length + 1;
          const pull = { number, node_id: `PR_${number}`, user: { login: BOT }, auto_merge: null, title, body, state: 'open', head: { ref: head }, base: { ref: base }, html_url: `https://github.com/acme/app/pull/${number}` };
          pulls.push(pull);
          return { data: pull };
        },
        update: async ({ pull_number, ...changes }) => {
          record('updatePull', { number: pull_number, ...changes });
          const pull = pulls.find((candidate) => candidate.number === pull_number);
          for (const key of ['title', 'body', 'state']) if (changes[key] !== undefined) pull[key] = changes[key];
          return { data: pull };
        },
      },
      issues: {
        createComment: async ({ issue_number, body }) => {
          record('createComment', { number: issue_number });
          comments.push({ number: issue_number, body });
          return { data: {} };
        },
      },
    },
  };
  return github;
}

const context = { repo: { owner: 'acme', repo: 'app' } };

function env(root, overrides = {}) {
  return {
    SYNC_SOURCE_REPOSITORY: SOURCE,
    SYNC_SOURCE_PATH: root,
    SYNC_SOURCE_SHA: SOURCE_SHA,
    GITHUB_WORKSPACE: '/nonexistent',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '42',
    ...overrides,
  };
}

module.exports = { BOT, SOURCE, SOURCE_SHA, httpError, mockCore, mockGithub, sourceCheckout, context, env };
