'use strict';

// Tells a copy that differs from the source only in the versions it references from one that
// differs in anything else. Renovate updates those versions in every repository on its own, from
// the same releases the source follows, so a sync of nothing else would only duplicate its pull
// request.
//
// A version is what Renovate's github-actions manager and its githubActionsVersions custom
// manager update:
// - the ref of `uses: owner/repo[/path]@ref`, with a version comment after it, as in
//   `uses: actions/checkout@<sha> # v7.0.1`. A local `./` or `$/` reference has no ref.
// - the value on the line after a `# renovate: datasource=... depName=...` comment, as in
//   `ZIZMOR_VERSION: 1.31.1`.

const USES = /^(\s*(?:-\s*)?uses:\s*['"]?[^\s'"@#]+)@[^\s'"#]+(['"]?)(\s*#.*)?$/;
const VERSION_COMMENT = /^\s*#\s*v?\d[\w.+-]*\s*$/;
const RENOVATE = /^\s*#\s*renovate:\s/;
const ASSIGNMENT = /^(\s*(?:-\s*)?[\w.-]+\s*:\s*)\S.*$/;

// The text with every version replaced by the same placeholder.
function withoutVersions(text) {
  let annotated = false;
  return text
    .split('\n')
    .map((line) => {
      if (annotated && line.trim() !== '') {
        annotated = false;
        return line.replace(ASSIGNMENT, '$1@');
      }
      if (RENOVATE.test(line)) {
        annotated = true;
        return line;
      }
      return line.replace(USES, (match, target, quote, comment = '') => `${target}@${quote}${VERSION_COMMENT.test(comment) ? '' : comment}`);
    })
    .join('\n');
}

// Whether the two texts differ, and only in versions.
function differOnlyInVersions(before, after) {
  return before !== after && withoutVersions(before) === withoutVersions(after);
}

module.exports = { withoutVersions, differOnlyInVersions };
