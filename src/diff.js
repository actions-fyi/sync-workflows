'use strict';

// A line diff in unified format, for the pull request's description. No dependencies: a longest
// common subsequence table over the lines that differ, after the common start and end are cut off.

const MAX_CELLS = 4_000_000;

function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Returns [{ type: ' ' | '-' | '+', line }], or null when the files are too large to compare.
function diffLines(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) return null;
  // lcs[i][j]: the length of the longest common subsequence of a[start+i..] and b[start+j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[start + i] === b[start + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = a.slice(0, start).map((line) => ({ type: ' ', line }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      ops.push({ type: ' ', line: a[start + i] });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ type: '-', line: a[start + i++] });
    } else {
      ops.push({ type: '+', line: b[start + j++] });
    }
  }
  for (const line of a.slice(endA)) ops.push({ type: ' ', line });
  return ops;
}

// Returns { added, removed, text }, text being the hunks with `context` lines around each change,
// or null when the files are too large to compare.
function unifiedDiff(before, after, context = 3) {
  const ops = diffLines(before, after);
  if (ops === null) return null;
  const keep = new Uint8Array(ops.length);
  let added = 0;
  let removed = 0;
  ops.forEach((op, index) => {
    if (op.type === ' ') return;
    if (op.type === '+') added++;
    else removed++;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) keep[k] = 1;
  });
  const out = [];
  let lineA = 1;
  let lineB = 1;
  let index = 0;
  while (index < ops.length) {
    if (!keep[index]) {
      lineA++;
      lineB++;
      index++;
      continue;
    }
    const hunk = [];
    const startA = lineA;
    const startB = lineB;
    for (; index < ops.length && keep[index]; index++) {
      const op = ops[index];
      hunk.push(`${op.type}${op.line}`);
      if (op.type !== '+') lineA++;
      if (op.type !== '-') lineB++;
    }
    const countA = lineA - startA;
    const countB = lineB - startB;
    // As git does: a hunk with no lines on a side starts at the line before it.
    out.push(`@@ -${countA ? startA : startA - 1},${countA} +${countB ? startB : startB - 1},${countB} @@`, ...hunk);
  }
  return { added, removed, text: out.join('\n') };
}

module.exports = { unifiedDiff };
