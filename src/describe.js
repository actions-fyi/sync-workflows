'use strict';

// The commit message and the pull request's description.

const { WORKFLOWS } = require('./source');
const { unifiedDiff } = require('./diff');

const MARKER = '<!-- sync-workflows -->';
// GitHub rejects a pull request body over 65,536 characters; the rest is for the text around.
const DIFF_BUDGET = 50_000;

function sourceLabel({ sourceRepository, sourceSha }) {
  return sourceSha ? `${sourceRepository}@${sourceSha}` : sourceRepository;
}

function commitMessage(inputs, changes, removals = []) {
  const lines = [
    ...changes.map((change) => `- ${change.path} ${change.added ? 'added ' : ''}from ${change.sourcePath}`),
    ...removals.map((removal) => `- ${WORKFLOWS}/${removal.name} removed: the source retired it`),
  ];
  return `${inputs.title}\n\nSource: ${sourceLabel(inputs)}\n\n${lines.join('\n')}\n`;
}

// A fence longer than any run of backticks in the text, so the text can't close it.
function fence(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(longest + 1);
}

function count(diff) {
  return diff ? `+${diff.added} −${diff.removed}` : 'too large to compare';
}

function pullRequestBody(inputs, { defaultBranch, changes, removals = [], versionOnly = [], whitespaceOnly = [], collisions }) {
  const { sourceRepository, sourceSha, serverUrl, runId } = inputs;
  const sourceUrl = `${serverUrl}/${sourceRepository}`;
  const ref = sourceSha || 'HEAD';
  const at = sourceSha ? ` at [\`${sourceSha.slice(0, 7)}\`](${sourceUrl}/commit/${sourceSha})` : '';
  const plural = (count) => (count === 1 ? 'workflow' : 'workflows');
  // "workflows" unless one of them is another file.
  const noun = (list) => (list.some((change) => change.origin === 'file') ? (list.length === 1 ? 'file' : 'files') : plural(list.length));
  const source = `[${sourceRepository}](${sourceUrl})${at}`;
  const updates = changes.filter((change) => !change.added);
  const additions = changes.filter((change) => change.added);
  const out = [];
  const paragraph = (text) => out.push(...(out.length ? [''] : []), text);
  if (updates.length) {
    paragraph(`Updates ${updates.length} ${noun(updates)} of this repository to match ${source}.`);
  }
  if (additions.length) {
    paragraph(`Adds ${additions.length} ${noun(additions)} of ${source} that this repository doesn't have yet.`);
  }
  if (removals.length) {
    const names = removals.map((removal) => `\`${WORKFLOWS}/${removal.name}\``).join(', ');
    paragraph(
      `Removes ${removals.length} ${plural(removals.length)} that ${source} retired: ${names}. The source no longer has ${removals.length === 1 ? 'it' : 'them'}, so a copy here would never be updated again.`,
    );
  }
  if (changes.length) out.push('', '| File | Source | Lines |', '| --- | --- | --- |');
  const diffs = changes.map((change) => ({ change, diff: unifiedDiff(change.before, change.content) }));
  for (const { change, diff } of diffs) {
    const rendered = change.origin === 'template' ? `, a workflow template rendered with \`$default-branch\` = \`${defaultBranch}\`` : '';
    out.push(`| \`${change.path}\`${change.added ? ' (new)' : ''} | [\`${change.sourcePath}\`](${sourceUrl}/blob/${ref}/${change.sourcePath})${rendered} | ${count(diff)} |`);
  }
  let budget = DIFF_BUDGET;
  for (const { change, diff } of diffs) {
    out.push('', `<details>`, `<summary><code>${change.name}</code> (${count(diff)})</summary>`, '');
    if (diff && diff.text.length <= budget) {
      budget -= diff.text.length;
      const marks = fence(diff.text);
      out.push(`${marks}diff`, diff.text, marks);
    } else {
      out.push('The diff is too long to show here; see the Files changed tab.');
    }
    out.push('', '</details>');
  }
  const scope = [
    inputs.add
      ? 'Workflows are synced by file name: `.yml` and `.yaml` files only. Every workflow in `.github/workflows` of the source is kept here, and added when it is missing. A workflow template is only updated where this repository already has a copy.'
      : 'Workflows are synced by file name: only `.yml` and `.yaml` workflows that this repository already has are updated, and none is added.',
    'A workflow is removed only when the source retired it, and `actions.lock` is not synced.',
  ];
  if (inputs.files?.size) {
    const names = [...inputs.files].map((file) => `\`${file}\``).join(', ');
    scope.push(`Also synced, as ${inputs.files.size === 1 ? 'it is' : 'they are'} in the source: ${names}.`);
  }
  out.push('', scope.join(' '));
  if (versionOnly.length) {
    const names = versionOnly.map((name) => `\`${name}\``).join(', ');
    out.push('', `Not updated: ${names} ${versionOnly.length === 1 ? 'differs' : 'differ'} from the source only in the versions ${versionOnly.length === 1 ? 'it references' : 'they reference'}, which Renovate updates.`);
  }
  if (whitespaceOnly.length) {
    const names = whitespaceOnly.map((name) => `\`${name}\``).join(', ');
    out.push('', `Not updated: ${names} ${whitespaceOnly.length === 1 ? 'differs' : 'differ'} from the source only in whitespace, which this repository's formatter sets.`);
  }
  if (collisions.length) {
    const names = collisions.map((name) => `\`${name}\``).join(', ');
    out.push('', `The source has ${names} in both \`.github/workflows\` and \`workflow-templates\`; the one in \`.github/workflows\` was used.`);
  }
  const run = runId ? ` in run [#${runId}](${serverUrl}/${inputs.repository}/actions/runs/${runId})` : '';
  out.push('', '---', '', `Opened and kept up to date by workflow sync${run}. Changes pushed to this branch are overwritten by the next sync.`, MARKER);
  return out.join('\n');
}

module.exports = { MARKER, commitMessage, pullRequestBody };
