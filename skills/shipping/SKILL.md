---
name: shipping
description: Use when the user asks to raise a PR, open a PR, ship a ticket, or commit work. Defines the inputs the ship tool needs, how files are selected, and the branch, commit and PR naming.
---

# Shipping

Work reaches review through the `ship` tool. It branches from `origin/develop` in a throwaway
worktree, so the current branch, index, uncommitted changes and stashes are never modified.

<request-routing>
| User said | Action |
|---|---|
| "ship it", "raise a PR", "open a PR", "push this up" | Run the ship workflow |
| "commit this", "just commit" | Run the ship workflow with `commitOnly: true` |
| "draft PR", "WIP PR", "not ready for review" | Run the ship workflow with `draft: true` |
| "add the notes to the PR", "update the description" | Edit the PR with `gh pr edit` — never re-ship |
| "I'll do it myself", "give me the command" | Tell them `/ship [project] TICKET fix\|feat "title"` |
</request-routing>

<required-inputs>
  <input><name>project</name><meaning>Key from ~/.pi/ship.json naming the repository.</meaning><example>`project-front` · `project-back`</example></input>
  <input><name>ticket</name><meaning>Uppercase key, dash, number. Always comes from the user.</meaning><example>`PROJECT_A-412`</example></input>
  <input><name>type</name><meaning>`fix` repairs broken behavior, `feat` adds behavior.</meaning><example>Restoring a 500-ing endpoint → `fix` · adding an export button → `feat`</example></input>
  <input><name>title</name><meaning>Imperative, under 72 chars, no trailing period, no ticket id — ship adds it.</meaning><example>`prevent double review on synchronize` — never `fixed the double review bug`</example></input>
</required-inputs>

<missing-input-handling>
IF the ticket id is absent → ask: *"Which ticket is this for?"* — stop here.
ELSE IF the project is absent AND ~/.pi/ship.json holds exactly one project → use that project.
ELSE IF the project is absent → ask which project — stop here.
ELSE IF `fix` versus `feat` is not decidable from the change → ask which — stop here.
ELSE → continue to Preview.
<example>User says "ship this to project-front" with no id → ask for the ticket, never invent `PROJECT_A-1`.</example>
</missing-input-handling>

<preview>
  <step number="1">
    <action>List what ship will select: every change against the base branch.</action>
    <example>`git status --porcelain` and `git log --oneline origin/develop..HEAD`</example>
  </step>
  <step number="2">
    <action>Report any path in that list the user did not mention, then continue.</action>
    <example>A lockfile, a `console.log` left in, an unrelated config → name it before shipping.</example>
  </step>
</preview>

<file-selection>
IF the user named specific files → pass them as `files`, and say what is being left behind.
ELSE → omit `files` entirely; ship commits every change against the base branch.
<example>Work started on `develop`, so local commits, staged and unstaged edits, new files and deletions are all one ticket → call ship with no `files`.</example>
</file-selection>

<naming>
Derived by ship — never construct these by hand:

```
branch   fix/PROJECT_A-412          → taken? fix/PROJECT_A-412-a → -b … → -y
commit   fix(PROJECT_A-412): prevent double review on synchronize
PR       [PROJECT_A-412] fix: prevent double review on synchronize   → base develop
```
</naming>

<rules>
  <rule><requirement>Never run `git commit`, `git switch`, `git checkout -b` or `git branch` — ship owns branch creation.</requirement><example>User asks for a branch → call ship, never `git checkout -b feat/PROJECT_A-412`.</example></rule>
  <rule><requirement>Never force-push.</requirement><example>A push must be redone → `git push --force-with-lease`, never `git push -f`.</example></rule>
  <rule><requirement>Never put tokens, auth.json contents, .env values or customer data in a title or body.</requirement><example>PR bodies are public — write "refreshes the stored credential", never the credential.</example></rule>
  <rule><requirement>Never invent a ticket id, and never reuse one from earlier in the session without confirming.</requirement><example>Second ship in one session → ask whether it is the same ticket.</example></rule>
  <rule><requirement>Write the body as one paragraph of why, then how it was verified.</requirement><example>"Two jobs raced on synchronize. Verified by pushing twice to PR #14 — one review posted."</example></rule>
  <rule><requirement>Report the PR URL ship returns back to the user.</requirement><example>`opened https://github.com/org/project-front/pull/57` → paste that link in the reply.</example></rule>
</rules>

<self-verification>
  <check>The ticket id came from the user — not invented, not carried over unconfirmed.</check>
  <check>The selection was previewed and every unmentioned path was reported before shipping.</check>
  <check>The title is imperative, under 72 chars, and carries no ticket id or trailing period.</check>
  <check>No credential, token or customer data appears in the title or body.</check>
  <check>The PR URL was reported back to the user.</check>
</self-verification>
