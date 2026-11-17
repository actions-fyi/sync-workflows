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
    ...changes.map((change) => `- ${WORKFLOWS}/${change.name} from ${change.sourcePath}`),
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

function pullRequestBody(inputs, { defaultBranch, changes, removals = [], versionOnly = [], collisions }) {
  const { sourceRepository, sourceSha, serverUrl, runId } = inputs;
  const sourceUrl = `${serverUrl}/${sourceRepository}`;
  const ref = sourceSha || 'HEAD';
  const at = sourceSha ? ` at [\`${sourceSha.slice(0, 7)}\`](${sourceUrl}/commit/${sourceSha})` : '';
  const plural = (count) => (count === 1 ? 'workflow' : 'workflows');
  const source = `[${sourceRepository}](${sourceUrl})${at}`;
  const out = [];
  if (changes.length) {
    out.push(`Updates ${changes.length} ${plural(changes.length)} of this repository to match ${source}.`);
  }
  if (removals.length) {
    const names = removals.map((removal) => `\`${WORKFLOWS}/${removal.name}\``).join(', ');
    out.push(
      ...(out.length ? [''] : []),
      `Removes ${removals.length} ${plural(removals.length)} that ${source} retired: ${names}. The source no longer has ${removals.length === 1 ? 'it' : 'them'}, so a copy here would never be updated again.`,
    );
  }
  if (changes.length) out.push('', '| Workflow | Source | Lines |', '| --- | --- | --- |');
  const diffs = changes.map((change) => ({ change, diff: unifiedDiff(change.before, change.content) }));
  for (const { change, diff } of diffs) {
    const rendered = change.origin === 'template' ? `, a workflow template rendered with \`$default-branch\` = \`${defaultBranch}\`` : '';
    out.push(`| \`${WORKFLOWS}/${change.name}\` | [\`${change.sourcePath}\`](${sourceUrl}/blob/${ref}/${change.sourcePath})${rendered} | ${count(diff)} |`);
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
  out.push(
    '',
    `Only \`.yml\` and \`.yaml\` workflows that this repository already has, under the same file name as in the source, are updated. No workflow is added, one is removed only when the source retired it, and \`actions.lock\` is not synced.`,
  );
  if (versionOnly.length) {
    const names = versionOnly.map((name) => `\`${name}\``).join(', ');
    out.push('', `Not updated: ${names} ${versionOnly.length === 1 ? 'differs' : 'differ'} from the source only in the versions ${versionOnly.length === 1 ? 'it references' : 'they reference'}, which Renovate updates.`);
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
