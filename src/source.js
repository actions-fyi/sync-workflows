'use strict';

// Reads the source's workflows from its checkout and renders workflow templates.
//
// A workflow is identified by its file name. The source offers a name from .github/workflows or
// from workflow-templates; when both have it, .github/workflows wins and the name is reported as
// a collision. Only .yml and .yaml files are read there: actions.lock, the templates'
// .properties.json and everything else in the two directories are never synced. A file anywhere
// else is read only when the `files` input names it, and is identified by its path.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORKFLOWS = '.github/workflows';
const TEMPLATES = 'workflow-templates';
const { WORKFLOW_FILE } = require('./inputs');

// GitHub replaces these when a workflow is added from a template. Only $default-branch has one
// right value per repository. $protected-branches follows branch protection, and the two cron
// placeholders are random, so a copy with them can't be told apart from an edited one.
const DEFAULT_BRANCH = /\$default-branch/g;
const UNSUPPORTED = /\$(protected-branches|cron-daily|cron-weekly)/g;

function listWorkflowFiles(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
  // isFile is false for a symlink, so a link out of the checkout is never followed.
  return entries.filter((entry) => entry.isFile() && WORKFLOW_FILE.test(entry.name)).map((entry) => entry.name).sort();
}

// Returns { files: Map<name, { origin, path, content }>, collisions: string[] }.
function readSource(root) {
  const files = new Map();
  const collisions = [];
  for (const [origin, directory] of [['workflow', WORKFLOWS], ['template', TEMPLATES]]) {
    for (const name of listWorkflowFiles(path.join(root, directory))) {
      if (files.has(name)) {
        collisions.push(name);
        continue;
      }
      const content = fs.readFileSync(path.join(root, directory, name), 'utf8');
      files.set(name, { origin, path: `${directory}/${name}`, content });
    }
  }
  return { files, collisions };
}

// Another file of the source, by its path in the checkout. Null when the source doesn't have it.
function readSourceFile(root, file) {
  const full = path.join(root, file);
  try {
    // lstat doesn't follow a symlink, so a link out of the checkout is never read.
    if (!fs.lstatSync(full).isFile()) return null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  return fs.readFileSync(full, 'utf8');
}

// Returns { content } or { unsupported: string[] } for a template this can't render.
function render(file, defaultBranch) {
  if (file.origin !== 'template') return { content: file.content };
  const unsupported = [...new Set(file.content.match(UNSUPPORTED) ?? [])];
  if (unsupported.length) return { unsupported };
  return { content: file.content.replace(DEFAULT_BRANCH, () => defaultBranch) };
}

// The SHA git gives a blob with this content, to compare with a tree entry without fetching it.
// SHA-1 is git's object ID, not a security choice: any other hash would never match the tree.
// The match only skips writing a file that's already up to date.
function blobSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); // NOSONAR: git object ID
}

module.exports = { WORKFLOWS, TEMPLATES, WORKFLOW_FILE, readSource, readSourceFile, render, blobSha };
