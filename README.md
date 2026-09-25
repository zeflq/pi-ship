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

`/ship config` prints the resolved configuration.

## Two ways to run it

**`/ship` — the deterministic path.** No LLM turn, no tokens, nothing invented. With a TUI it
prompts for project, ticket, type and title, shows the file set it detected, and asks before
creating anything — so declining costs nothing. Arguments skip whichever prompts they answer:

```
/ship                                                   → prompt for everything
/ship PROJECT_A-412 fix "prevent double review"         → straight to the confirmation
/ship project-back PROJECT_A-412 feat "add export"      → project named explicitly
/ship config                                            → show the resolved config
```

Order does not matter: the project name, `fix`/`feat` and the ticket are recognised wherever they
appear, and an unquoted trailing phrase is taken as the title. In print mode (`pi -p`) there are no
dialogs, so every part must be on the line.

**The `ship` tool — the conversational path.** Ask in plain language: *"raise a PR on project-front for PROJECT_A-412, fix, the double-review
bug"* and the model fills the parameters from what it just changed. It takes:

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

## Debugging push / PR problems

`scripts/ship-debug.ts` is a **temporary standalone probe**, deliberately not wired into the
extension: it registers no command or tool, imports nothing from `extensions/`, and can be deleted
without touching anything else. Run it with node directly:

```bash
node scripts/ship-debug.ts ~/projects/projectFront          # base defaults to develop
node scripts/ship-debug.ts ~/projects/projectFront main
node scripts/ship-debug.ts . develop --keep                 # leave the probe PR open
```

It reports `gh --version`, `gh auth status`, git's credential helper, the origin URL and the repo's
`isArchived` / `viewerPermission`, then pushes a branch carrying an **empty** commit, opens a draft
PR, and closes it again — so it exercises the two things that actually fail, with fake ticket
`DEBUG-1234`, no real work and no LLM turn. Exit code is non-zero when any step fails.

```
✓ repo access
    {"isArchived":true,"viewerPermission":"ADMIN"}
✗ git push  ← a 403 appears here
    remote: This repository was archived so it is read-only.
✓ checkout untouched
```

## Preflight## Auth

The push runs with git's credential helper pinned to gh:

```
git -c credential.helper= -c credential.helper='!gh auth git-credential' push …
```

The empty first value clears whatever the environment inherited — Git Credential Manager, a
keychain helper, one from a different `HOME` — and the second makes git ask the same gh that the
preflight just queried. Without it, gh and git can hold different identities, and a repo gh reports
as writable still fails the push with a bare 403. That is the "works in my shell, fails in the
tool" case, and it is common when ship runs inside an agent runtime rather than your terminal.

## Preflight

Before creating anything, ship checks that `gh` is present and authenticated, that its token can
actually write (`X-OAuth-Scopes` must include `repo` — `gh repo view` cannot tell you this, since
`viewerPermission` describes your account's role on the repo, so a read-only token reports `ADMIN`
and still 403s), and that the repo is neither archived nor read-only — a push-time 403 arrives after the commit exists and says only `403`, which
cannot distinguish an archived repo from missing write access. A common cause of the latter: git
using different credentials than `gh`, which `gh auth setup-git` fixes. Non-GitHub remotes skip the
check.

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
| `extensions/ship/command.ts` | `/ship` — interactive and positional forms |
| `scripts/ship-debug.ts` | temporary standalone push/PR probe — delete when done |
| `skills/shipping/SKILL.md` | conventions for the model |
