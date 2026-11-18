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
- Only copies the repository already has are updated. No workflow is added.
- A workflow is removed only when `remove` names it and the source no longer has it. That is how
  a workflow the source retired leaves the repositories that still have a copy. A name the source
  still has is kept, with a warning, and an excluded name is never touched.
- A name in both source directories is taken from `.github/workflows`, with a warning.
- A template that uses `$protected-branches`, `$cron-daily` or `$cron-weekly` is skipped with a
  warning: those have no single right value to compare a copy with.
- A copy is compared as a whole, so a local edit to it is reverted by the next sync.
- With `ignore-versions`, a copy that differs only in the versions it references is left as it
  is: the ref of a `uses:`, with a version comment after it, and the value on the line after a
  `# renovate:` annotation. Renovate updates those, so a sync of nothing else would duplicate its
  pull request. Such a copy counts as matching. A copy that differs in anything else is replaced
  by the source's, versions included.

## The pull request

When a copy differs, or a retired workflow is left, the action commits the new contents and the
removals on top of the default branch and points its branch, `sync/workflows`, at that commit.

- With no open pull request, it opens one. A branch left behind by a closed one is overwritten.
- With an open pull request, it overwrites the branch and rewrites the description.
- If the open pull request's branch already has every copy as it should be and no retired
  workflow, nothing is written, so its checks don't restart and commits added to it, such as a
  lockfile fix, stay.
- Once the default branch matches the source and has no retired workflow, the open pull request
  is closed and its branch deleted.

The commit and the pull request are titled `ci: sync workflows from <source>`. The description
links the source commit, lists each workflow with the file it came from and its changed line
counts, shows each diff, and names the retired workflows it removes.

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
| `remove` | | File names the source retired, removed where a copy is left. |
| `ignore-versions` | `false` | Leave copies that differ only in the versions they reference. |
| `dry-run` | `false` | Report the copies that differ, change nothing. |

| Output | |
| --- | --- |
| `result` | `skipped`, `up-to-date`, `closed`, `created`, `updated`, `unchanged` or `dry-run`. |
| `changed` | A JSON array of the file names that differ from the source. |
| `removed` | A JSON array of the retired file names the repository still has. |
| `pull-request-number`, `pull-request-url` | The sync pull request, or empty. |

The action is a composite action with one `actions/github-script` step and plain CommonJS modules
in `src/`: no npm dependencies, no build, no `dist/`. Run the tests with `node --test test/*.test.js`.

## The actions-fyi setup

Two shared workflows here wrap the action for the org, with `actions-fyi/.github` as the source.

Both are called from one workflow, `workflow-sync.yml`, which lives in `actions-fyi/.github` and is
itself one of the synced workflows. Everything in `actions-fyi/.github` is distributed to the
org's repositories, so the source has no workflow of its own: a job that is only for the source
skips itself everywhere else.

```yaml
on:
  schedule:
    - cron: "43 3 * * *"
  repository_dispatch:
    types: [workflow-sync]
  workflow_dispatch:
    inputs:
      dry-run:
        type: boolean
        default: false
  push:
    branches: [main]
    paths:
      - .github/workflows/*.yml
      - .github/workflows/*.yaml
      - workflow-templates/*.yml
      - workflow-templates/*.yaml
permissions: {}
jobs:
  workflows:
    if: github.event_name != 'push'
    permissions:
      contents: read
      id-token: write
    uses: actions-fyi/sync-workflows/.github/workflows/_workflow-sync.yml@v1.0.0
    with:
      dry-run: ${{ inputs.dry-run || false }}
  dispatch:
    if: github.event_name == 'push' && github.repository == 'actions-fyi/.github'
    permissions:
      id-token: write
    uses: actions-fyi/sync-workflows/.github/workflows/_workflow-sync-dispatch.yml@v1.0.0
```

**`_workflow-sync.yml`** runs the sync in the calling repository, on the schedule, on demand and on the
`workflow-sync` event. It skips itself in the source. It also removes the workflows the source has
retired, which its `RETIRED` list names.

**`_workflow-sync-dispatch.yml`** sends the `workflow-sync` event to the org's repositories, so a change to
the source doesn't wait for their daily run. Only the source runs it: on a push to its `main` that
changes a workflow or a workflow template. In every other repository a push that changes a
workflow starts the run, and both jobs skip.

Both get their token from Octo STS, whose trust policies are in `.github/chainguard` of
`actions-fyi/.github` and name the shared workflow by its `job_workflow_ref`:

| Identity | Trusts | Permissions |
| --- | --- | --- |
| `workflow-sync` | `_workflow-sync.yml` of this repository, called from any repository's default branch | contents, pull requests, workflows: write |
| `workflow-sync-dispatch` | `_workflow-sync-dispatch.yml` of this repository, called from the default branch of `actions-fyi/.github` | contents: write |

This repository's own `workflow-sync.yml` calls `_workflow-sync.yml` with `$/`, so there the workflow runs
from `refs/heads/main`, not from a tag; the `workflow-sync` policy has to accept that ref for this
repository to sync itself.
