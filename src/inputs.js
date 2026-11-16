'use strict';

// Every input reaches the script through the step's env; see action.yml.

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
  return {
    sourceRepository,
    sourcePath: (env.SYNC_SOURCE_PATH ?? '').trim() || '.',
    sourceSha,
    branch,
    title,
    exclude: new Set(list(env.SYNC_EXCLUDE)),
    dryRun: bool(env, 'SYNC_DRY_RUN', false),
    workspace: env.GITHUB_WORKSPACE || process.cwd(),
    serverUrl: (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, ''),
    runId: env.GITHUB_RUN_ID || '',
  };
}

module.exports = { ConfigError, parseInputs };
