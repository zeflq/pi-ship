/**
 * TEMPORARY — delete this file once the push/PR problem is understood.
 *
 * Standalone probe of the machine, not of this repo's code: it imports nothing
 * from extensions/ and is registered nowhere, so removing it leaves no trace.
 * It answers one question — can git push, and can gh open a PR, from here —
 * using fake ticket DEBUG-1234 and an empty commit, so no real work is involved
 * and no LLM turn is spent.
 *
 *   node scripts/ship-debug.ts <repo-path> [base] [--keep]
 *
 *   node scripts/ship-debug.ts ~/projects/projectFront
 *   node scripts/ship-debug.ts ~/projects/projectFront main
 *   node scripts/ship-debug.ts . develop --keep      # leave the PR open
 *
 * The commit is built in a /tmp worktree, so the checkout you point it at is
 * never modified: HEAD, branch, staged and unstaged changes and the stash are
 * snapshotted before and compared after.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const TICKET = "DEBUG-1234";
const BRANCH = `fix/${TICKET}`;

interface Result {
	out: string;
	err: string;
	ok: boolean;
}

function run(cmd: string, args: string[], cwd: string): Result {
	try {
		const out = execFileSync(cmd, args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
		return { out: out.trim(), err: "", ok: true };
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string; code?: unknown };
		return { out: (e.stdout ?? "").trim(), err: (e.stderr ?? String(e.code ?? error)).trim(), ok: false };
	}
}

function step(label: string, result: Result): boolean {
	console.log(`${result.ok ? "✓" : "✗"} ${label}`);
	const detail = result.ok ? result.out : result.err;
	if (detail) for (const line of detail.split("\n").slice(0, 6)) console.log(`    ${line}`);
	return result.ok;
}

function snapshot(repo: string): Record<string, string> {
	return {
		HEAD: run("git", ["rev-parse", "HEAD"], repo).out,
		"working tree": run("git", ["status", "--porcelain"], repo).out,
		stashes: run("git", ["stash", "list"], repo).out,
	};
}

const rawPath = process.argv[2];
if (!rawPath) {
	console.error("Usage: node scripts/ship-debug.ts <repo-path> [base] [--keep]");
	process.exit(2);
}
const repo = rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : rawPath;
const base = process.argv.slice(3).find((arg) => !arg.startsWith("--")) ?? "develop";
const keep = process.argv.includes("--keep");

if (!existsSync(join(repo, ".git"))) {
	console.error(`${repo} is not a git repository`);
	process.exit(2);
}

console.log(`repo:   ${repo}`);
console.log(`base:   origin/${base}`);
console.log(`ticket: ${TICKET} (fake, empty commit)\n`);

const before = snapshot(repo);

// Who git and gh each think they are. A mismatch here is the usual cause of a
// 403 on push from a machine where `gh auth status` looks fine.
step("gh installed", run("gh", ["--version"], repo));
step("gh authenticated", run("gh", ["auth", "status"], repo));
step("git credential helper", run("git", ["config", "--get-all", "credential.helper"], repo));
step("origin url", run("git", ["remote", "get-url", "origin"], repo));
step("repo access", run("gh", ["repo", "view", "--json", "isArchived,viewerPermission"], repo));
console.log();

let exitCode = 0;
let pushed = false;
const worktree = mkdtempSync(join(tmpdir(), "ship-debug-"));

try {
	if (!step(`fetch origin/${base}`, run("git", ["fetch", "origin", base], repo))) {
		exitCode = 1;
	} else if (
		!step(`worktree + branch ${BRANCH}`, run("git", ["worktree", "add", "--quiet", worktree, "-b", BRANCH, `origin/${base}`], repo))
	) {
		exitCode = 1;
	} else if (
		!step("empty commit", run("git", ["commit", "--quiet", "--allow-empty", "-m", `fix(${TICKET}): ship debug probe`], worktree))
	) {
		exitCode = 1;
	} else {
		pushed = step("git push  ← a 403 appears here", run("git", ["push", "-u", "origin", BRANCH], worktree));
		if (!pushed) {
			exitCode = 1;
		} else {
			const pr = run(
				"gh",
				[
					"pr",
					"create",
					"--base",
					base,
					"--head",
					BRANCH,
					"--draft",
					"--title",
					`[${TICKET}] fix: ship debug probe`,
					"--body",
					"Automated probe. Empty commit, closed immediately.",
				],
				worktree,
			);
			if (!step("gh pr create", pr)) exitCode = 1;
			else console.log(`\nBoth work. PR: ${pr.out.split("\n").filter(Boolean).pop()}`);
		}
	}
} finally {
	run("git", ["worktree", "remove", "--force", worktree], repo);
	rmSync(worktree, { recursive: true, force: true });

	if (pushed && !keep) {
		console.log();
		step("close PR + delete remote branch", run("gh", ["pr", "close", BRANCH, "--delete-branch"], repo));
		run("git", ["branch", "-D", BRANCH], repo);
		run("git", ["fetch", "--prune", "--quiet", "origin"], repo);
	} else if (pushed) {
		console.log(`\nLeft in place: ${BRANCH} and its draft PR.`);
	} else {
		run("git", ["branch", "-D", BRANCH], repo);
	}

	const after = snapshot(repo);
	const drift = Object.keys(before).filter((key) => before[key] !== after[key]);
	console.log(drift.length === 0 ? "\n✓ checkout untouched" : `\n✗ checkout changed: ${drift.join(", ")}`);
}

process.exit(exitCode);
