# Sync Workflows

Keeps a repository's copies of the workflows and workflow templates of a source repository up to
date, by opening one pull request and keeping it current.

It runs in the repository it updates, and pulls. Nothing is pushed from a central list.

## What is synced

A workflow is identified by its file name. A workflow in `.github/workflows` of the repository is
updated when the source has a file of the same name in either of:

- `.github/workflows`, copied as it is.
- `workflow-templates`, rendered first: `$default-branch` becomes the repository's default branch.

The rules:

- Only `.yml` and `.yaml` files are synced. `actions.lock`, a template's `.properties.json` and
  every other file are never read or written.
- Only copies the repository already has are updated. No workflow is added or removed.
- A name in both source directories is taken from `.github/workflows`, with a warning.
- A template that uses `$protected-branches`, `$cron-daily` or `$cron-weekly` is skipped with a
  warning: those have no single right value to compare a copy with.
- A copy is compared as a whole, so a local edit to it is reverted by the next sync.

## The pull request

When a copy differs, the action commits the new contents on top of the default branch and points
its branch, `sync/workflows`, at that commit.

- With no open pull request, it opens one. A branch left behind by a closed one is overwritten.
- With an open pull request, it overwrites the branch and rewrites the description.
- If the open pull request's branch already has every copy as it should be, nothing is written, so
  its checks don't restart and commits added to it, such as a lockfile fix, stay.
- Once the default branch matches the source, the open pull request is closed and its branch
  deleted.

The commit and the pull request are titled `ci: sync workflows from <source>`. The description
links the source commit, lists each workflow with the file it came from and its changed line
counts, and shows each diff.

## Usage

```yaml
steps:
  - uses: actions/checkout@v7.0.1
    id: source
    with:
      repository: my-org/.github
      path: source
      sparse-checkout: |
        .github/workflows
        workflow-templates
      persist-credentials: false
  - uses: actions-fyi/sync-workflows@v1
    with:
      source-repository: my-org/.github
      source-path: source
      source-sha: ${{ steps.source.outputs.commit }}
      github-token: ${{ steps.app.outputs.token }}
```

The token needs contents, pull requests and workflows write on the repository. The job's own
`GITHUB_TOKEN` can't have the last one, so pass a GitHub App's token. A dry run only reads.

| Input | Default | |
| --- | --- | --- |
| `source-repository` | required | The source, `owner/name`. |
| `source-path` | `.` | The source's checkout, relative to the workspace. |
| `source-sha` | | The checked-out source commit, to link to. |
| `github-token` | `github.token` | Reads the repository, pushes the branch, opens the pull request. |
| `branch` | `sync/workflows` | The pull request's branch. It belongs to the action. |
| `title` | `ci: sync workflows from <source-repository>` | The commit subject and pull request title. |
| `exclude` | | File names never synced, separated by newlines or commas. |
| `dry-run` | `false` | Report the copies that differ, change nothing. |

| Output | |
| --- | --- |
| `result` | `skipped`, `up-to-date`, `closed`, `created`, `updated`, `unchanged` or `dry-run`. |
| `changed` | A JSON array of the file names that differ from the source. |
| `pull-request-number`, `pull-request-url` | The sync pull request, or empty. |

The action is a composite action with one `actions/github-script` step and plain CommonJS modules
in `src/`: no npm dependencies, no build, no `dist/`. Run the tests with `node --test test/*.test.js`.

## The actions-fyi setup

Two shared workflows here wrap the action for the org, with `actions-fyi/.github` as the source.

**`_file-sync.yml`** runs the sync in the calling repository. Its caller, `file-sync.yml`, lives in
`actions-fyi/.github` and is itself one of the synced workflows:

```yaml
on:
  schedule:
    - cron: "43 3 * * *"
  repository_dispatch:
    types: [file-sync]
  workflow_dispatch:
    inputs:
      dry-run:
        type: boolean
        default: false
permissions: {}
jobs:
  workflows:
    permissions:
      contents: read
      id-token: write
    uses: actions-fyi/sync-workflows/.github/workflows/_file-sync.yml@v1.0.0
    with:
      dry-run: ${{ inputs.dry-run || false }}
```

**`_file-sync-dispatch.yml`** sends the `file-sync` event to the org's repositories, so a change to
the source doesn't wait for their daily run. Its caller lives only in `actions-fyi/.github`:

```yaml
on:
  push:
    branches: [main]
    paths:
      - .github/workflows/*.yml
      - .github/workflows/*.yaml
      - workflow-templates/*.yml
      - workflow-templates/*.yaml
permissions: {}
jobs:
  dispatch:
    permissions:
      id-token: write
    uses: actions-fyi/sync-workflows/.github/workflows/_file-sync-dispatch.yml@v1.0.0
```

Both get their token from Octo STS, whose trust policies are in `.github/chainguard` of
`actions-fyi/.github` and name the shared workflow by its `job_workflow_ref`:

| Identity | Trusts | Permissions |
| --- | --- | --- |
| `file-sync` | `_file-sync.yml` of this repository, called from any repository's default branch | contents, pull requests, workflows: write |
| `file-sync-dispatch` | `_file-sync-dispatch.yml` of this repository, called from the default branch of `actions-fyi/.github` | contents: write |

This repository's own `file-sync.yml` calls `_file-sync.yml` with `$/`, so there the workflow runs
from `refs/heads/main`, not from a tag; the `file-sync` policy has to accept that ref for this
repository to sync itself.

## Origin

This began as a fork of [step-security/repo-file-sync-action](https://github.com/step-security/repo-file-sync-action),
itself a fork of [BetaHuhn/repo-file-sync-action](https://github.com/BetaHuhn/repo-file-sync-action), and
was rewritten for this one job. See [LICENSE](LICENSE).
