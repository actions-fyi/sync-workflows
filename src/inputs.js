'use strict';

// Every input reaches the script through the step's env; see action.yml.

// The file names of workflows: no directory, and .yml or .yaml. src/source.js reads the same ones.
const WORKFLOW_FILE = /^[^/\\]+\.ya?ml$/;

// The merge methods GitHub's auto-merge takes, as the auto-merge input spells them.
const MERGE_METHODS = ['merge', 'squash', 'rebase'];

class ConfigError extends Error {}

function bool(env, key, fallback) {
  const value = (env[key] ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ConfigError(`${key} must be true or false, not "${value}".`);
}

function list(value) {
  return (value ?? '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function parseInputs(env) {
  const sourceRepository = (env.SYNC_SOURCE_REPOSITORY ?? '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(sourceRepository)) {
    throw new ConfigError(`source-repository must be owner/name, not "${sourceRepository}".`);
  }
  const sourceSha = (env.SYNC_SOURCE_SHA ?? '').trim();
  if (sourceSha && !/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new ConfigError('source-sha must be a full commit SHA.');
  }
  const branch = (env.SYNC_BRANCH ?? '').trim() || 'sync/workflows';
  // The rules of git check-ref-format that a typo could break.
  if (/^[/.-]|[/.]$|\.\.|\/\.|\/\/|@\{|\.lock(\/|$)|[\s~^:?*[\\]/.test(branch)) {
    throw new ConfigError(`branch "${branch}" is not a valid branch name.`);
  }
  const title = (env.SYNC_TITLE ?? '').trim() || `ci: sync workflows from ${sourceRepository}`;
  if (/[\r\n]/.test(title)) throw new ConfigError('title must be a single line.');
  const remove = new Set(list(env.SYNC_REMOVE));
  for (const name of remove) {
    if (!WORKFLOW_FILE.test(name)) throw new ConfigError(`remove lists "${name}", which is not a .yml or .yaml file name.`);
  }
  const files = new Set(list(env.SYNC_FILES).map((file) => file.replace(/^\.\//, '')));
  for (const file of files) {
    // A path inside the repository, as git writes it. The workflow directories go by file name.
    if (/^\/|\\|(^|\/)\.{1,2}(\/|$)|\/\/|\/$|^\.git(\/|$)/.test(file)) {
      throw new ConfigError(`files lists "${file}", which is not a path of a file in the repository.`);
    }
    if (/^(\.github\/workflows|workflow-templates)\//.test(file)) {
      throw new ConfigError(`files lists "${file}", but workflows and workflow templates are synced by file name, not as files.`);
    }
  }
  const autoMerge = (env.SYNC_AUTO_MERGE ?? '').trim().toLowerCase();
  if (autoMerge && !MERGE_METHODS.includes(autoMerge)) {
    throw new ConfigError(`auto-merge must be empty or one of ${MERGE_METHODS.join(', ')}, not "${autoMerge}".`);
  }
  return {
    sourceRepository,
    sourcePath: (env.SYNC_SOURCE_PATH ?? '').trim() || '.',
    sourceSha,
    branch,
    title,
    exclude: new Set(list(env.SYNC_EXCLUDE)),
    remove,
    files,
    add: bool(env, 'SYNC_ADD', false),
    ignoreVersions: bool(env, 'SYNC_IGNORE_VERSIONS', false),
    ignoreWhitespace: bool(env, 'SYNC_IGNORE_WHITESPACE', true),
    dryRun: bool(env, 'SYNC_DRY_RUN', false),
    force: bool(env, 'SYNC_FORCE', false),
    autoMerge,
    workspace: env.GITHUB_WORKSPACE || process.cwd(),
    serverUrl: (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, ''),
    runId: env.GITHUB_RUN_ID || '',
  };
}

module.exports = { ConfigError, MERGE_METHODS, WORKFLOW_FILE, parseInputs };
