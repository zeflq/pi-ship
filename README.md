# pi-ship

A [pi](https://github.com/earendil-works) extension that turns "ship PROJECT_A-412" into a branch,
a commit and a pull request — **without touching your working checkout**.

The workflow it assumes: you work on the base branch (`develop`), and when a ticket is done you
want it on its own branch as a PR, while your local state stays exactly where it is.

## What it does

```
branch   fix/PROJECT_A-412          → taken? fix/PROJECT_A-412-a → -b … → -y
commit   fix(PROJECT_A-412): prevent double review on synchronize
PR       [PROJECT_A-412] fix: prevent double review on synchronize   → base develop
```

The model supplies the prose — ticket, type, title, body — and the extension performs the git and
`gh` steps deterministically, so the naming never drifts between sessions.

## Why it cannot disturb your work

The commit is built in a `git worktree` branched from a freshly fetched `origin/develop`. The
selected files are copied into it, committed, pushed, and the worktree is removed in a `finally`.

Your HEAD, current branch, staged and unstaged changes and stash list are snapshotted before the
operation and compared after. A mismatch raises an error rather than passing silently — the
guarantee is enforced, not merely intended.

## Install

```bash
git clone https://github.com/<you>/pi-ship ~/projects/pi-ship
```

Then either add it to `~/.pi/agent/settings.json`:

```json
{ "packages": ["/Users/you/projects/pi-ship"] }
```

or load it for one session:

```bash
pi -e ~/projects/pi-ship/extensions/ship
```

## Configure

`~/.pi/ship.json` maps project names to local clones (override the path with `PI_SHIP_CONFIG`):

```json
{
  "projects": {
    "project-front": "~/projects/projectFront",
    "project-back":  "~/projects/projectBack"
  },
  "base": "develop"
}
```

`/ship` prints the resolved configuration.

## Use

Ask in plain language: *"raise a PR on project-front for PROJECT_A-412, fix, the double-review
bug"*. The `ship` tool takes:

| Parameter | Required | Notes |
| --- | --- | --- |
| `project` | yes | key from `~/.pi/ship.json` |
| `ticket` | yes | `PROJECT_A-412` — uppercase key, dash, number |
| `type` | yes | `fix` or `feat` |
| `title` | yes | imperative, under 72 chars; reused in the commit and the PR |
| `files` | no | **omit it** — ship takes every change against the base. Pass a list only to narrow that |
| `remove` | no | detected automatically when `files` is omitted |
| `body` | no | commit body and PR description |
| `draft` | no | open the PR as a draft |
| `commitOnly` | no | stop after the local commit — no push, no PR |

By default the file set is everything that differs from `origin/develop`: local commits, staged and
unstaged edits, new files and deletions. Work starts on the base branch, so the current work is the
ticket.

It refuses to ship git-ignored paths, files outside the repo, files already identical to the base,
and malformed ticket ids.

## Guardrails

A `tool_call` hook blocks hand-run `git commit`, `git switch`, `git checkout -b`, `git branch` and
bare force pushes, so the worktree guarantee cannot be bypassed mid-session. Narrow the patterns in
`extensions/ship/index.ts` if that is stricter than you want.

`skills/shipping/SKILL.md` carries the conventions the model follows: what to ask for, how to write
the title, what never goes in a PR body.

## Layout

| Path | Role |
| --- | --- |
| `extensions/ship/index.ts` | pi wiring: the `ship` tool, the `/ship` command, the guard hook |
| `extensions/ship/ship.ts` | the operation: worktree, copy, commit, push, PR |
| `extensions/ship/git.ts` | git helpers: snapshots, branch naming, change collection |
| `extensions/ship/config.ts` | `~/.pi/ship.json` loading and validation |
| `skills/shipping/SKILL.md` | conventions for the model |
