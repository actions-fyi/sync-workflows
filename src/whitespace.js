'use strict';

// Tells a copy that differs from the source only in whitespace from one that differs in anything
// else. A repository that runs a formatter, such as oxfmt through autofix.ci, rewrites the
// spacing of what the sync brings in: a sync of nothing else would only be formatted back, and
// the next sync would bring the source's spacing in again.
//
// Indentation is kept, because it is YAML's structure. What is ignored:
// - the length of a run of spaces or tabs inside a line, as in the spaces that align comments,
// - whitespace at the end of a line, carriage returns included,
// - blank lines, and whether the file ends in a newline.

// The text with every run of whitespace inside a line made one space, and the blank lines left out.
function withoutWhitespace(text) {
  return text
    .split('\n')
    .map((line) => {
      const indent = line.match(/^[ \t]*/)[0];
      return indent + line.slice(indent.length).replace(/\s+$/, '').replace(/[ \t]+/g, ' ');
    })
    .filter((line) => line.trim() !== '')
    .join('\n');
}

// Whether the two texts differ, and only in whitespace.
function differOnlyInWhitespace(before, after) {
  return before !== after && withoutWhitespace(before) === withoutWhitespace(after);
}

module.exports = { withoutWhitespace, differOnlyInWhitespace };
