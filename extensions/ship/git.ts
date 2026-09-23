/**
 * Git helpers for ship.
 *
 * Everything here treats the developer's working tree as read-only: the commit
 * is built in a throwaway worktree branched from origin/<base>, so HEAD, the
 * index, the current branch and the stash are never modified.
 */

import { execFileSync } from "node:child_process";

export interface RunOptions {
	cwd: string;
	input?: string;
	/** Return undefined instead of throwing when the command exits non-zero. */
	allowFailure?: boolean;
}

export function git(args: string[], options: RunOptions): string | undefined {
	try {
		return execFileSync("git", args, {
			cwd: options.cwd,
			encoding: "utf-8",
			input: options.input,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		if (options.allowFailure) return undefined;
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
	}
}

/** The three facts that must be identical before and after a ship. */
export interface WorkspaceSnapshot {
	head: string;
	status: string;
	stashes: string;
}

export function snapshot(cwd: string): WorkspaceSnapshot {
	return {
		head: git(["rev-parse", "HEAD"], { cwd }) ?? "",
		status: git(["status", "--porcelain"], { cwd }) ?? "",
		stashes: git(["stash", "list"], { cwd }) ?? "",
	};
}

export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
	const changes: string[] = [];
	if (before.head !== after.head) changes.push(`HEAD moved ${before.head.slice(0, 8)} → ${after.head.slice(0, 8)}`);
	if (before.status !== after.status) changes.push("working tree / index changed");
	if (before.stashes !== after.stashes) changes.push("stash list changed");
	return changes;
}

export function branchExists(cwd: string, name: string): boolean {
	const local = git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd, allowFailure: true });
	if (local !== undefined) return true;
	const remote = git(["ls-remote", "--heads", "origin", name], { cwd, allowFailure: true });
	return Boolean(remote);
}

/**
 * First free name in `fix/TICKET`, `fix/TICKET-a`, … `fix/TICKET-y`.
 * Checks local and remote refs, so two people on the same ticket cannot land
 * on the same branch name and have the second push rejected.
 */
export function nextBranchName(cwd: string, prefix: string): string {
	if (!branchExists(cwd, prefix)) return prefix;
	for (let code = "a".charCodeAt(0); code <= "y".charCodeAt(0); code++) {
		const candidate = `${prefix}-${String.fromCharCode(code)}`;
		if (!branchExists(cwd, candidate)) return candidate;
	}
	throw new Error(`Every name from ${prefix} to ${prefix}-y is taken — close some branches or use a new ticket`);
}

export interface CollectedChanges {
	files: string[];
	removed: string[];
}

/**
 * Everything the developer has that origin/<base> does not: local commits,
 * staged and unstaged edits, and untracked files. This is the default file set
 * — the workflow is that work starts on the base branch, so "my current work"
 * and "the ticket" are the same thing.
 */
export function collectChanges(cwd: string, base: string): CollectedChanges {
	const files = new Set<string>();
	const removed = new Set<string>();

	// --name-status against a commit compares the working tree, so this covers
	// local commits and uncommitted edits in one pass.
	const tracked = git(["diff", "--name-status", "-z", `origin/${base}`], { cwd }) ?? "";
	const fields = tracked.split("\0").filter(Boolean);
	for (let i = 0; i < fields.length; i++) {
		const status = fields[i];
		if (!status) continue;
		const code = status[0];
		if (code === "R" || code === "C") {
			// rename/copy: old path, then new path
			const from = fields[++i];
			const to = fields[++i];
			if (code === "R" && from) removed.add(from);
			if (to) files.add(to);
			continue;
		}
		const path = fields[++i];
		if (!path) continue;
		if (code === "D") removed.add(path);
		else files.add(path);
	}

	const untracked = git(["ls-files", "--others", "--exclude-standard"], { cwd }) ?? "";
	for (const path of untracked.split("\n").filter(Boolean)) files.add(path);

	return { files: [...files].sort(), removed: [...removed].sort() };
}

/** Paths git would ignore; committing these is nearly always a mistake. */
export function ignoredPaths(cwd: string, paths: string[]): string[] {
	if (paths.length === 0) return [];
	const out = git(["check-ignore", "--no-index", "--", ...paths], { cwd, allowFailure: true });
	return out ? out.split("\n").filter(Boolean) : [];
}
