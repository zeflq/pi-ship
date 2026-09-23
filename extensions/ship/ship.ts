/**
 * The ship operation: branch from origin/<base>, commit the named files as they
 * are in the working tree, push, open a PR — all without touching the
 * developer's checkout.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { loadConfig, resolveProject } from "./config.ts";
import { collectChanges, diffSnapshots, git, ignoredPaths, nextBranchName, snapshot } from "./git.ts";

export const TICKET_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;

export interface ShipRequest {
	project: string;
	ticket: string;
	type: "fix" | "feat";
	title: string;
	/** Defaults to every change against the base: local commits, edits, untracked files. */
	files?: string[];
	/** Defaults to the deletions found in that same comparison. */
	remove?: string[];
	body?: string;
	draft?: boolean;
	/** Stop after the local commit — no push, no PR. */
	commitOnly?: boolean;
}

export interface ShipResult {
	repo: string;
	branch: string;
	base: string;
	commitSubject: string;
	prTitle: string;
	prUrl?: string;
	shipped: string[];
	removed: string[];
	/** True when the file set was detected rather than supplied. */
	autoSelected: boolean;
}

function assertValid(request: ShipRequest): void {
	if (!TICKET_PATTERN.test(request.ticket)) {
		throw new Error(`Ticket "${request.ticket}" must look like PROJECT_A-412 (uppercase key, dash, number)`);
	}
	if (request.type !== "fix" && request.type !== "feat") {
		throw new Error(`Type must be "fix" or "feat", got "${request.type}"`);
	}
	const title = request.title.trim();
	if (!title) throw new Error("A title is required — it becomes the commit subject and the PR title");
	if (title.length > 72) throw new Error(`Title is ${title.length} chars; keep it under 72`);
}

/** Repo-relative, inside the repo, present on disk, not ignored. */
function normalizeFiles(repo: string, files: string[]): string[] {
	const normalized = files.map((file) => {
		const absolute = isAbsolute(file) ? file : resolve(repo, file);
		const rel = relative(repo, absolute);
		if (rel.startsWith("..")) throw new Error(`"${file}" is outside ${repo}`);
		if (!existsSync(absolute)) throw new Error(`"${rel}" does not exist in the working tree`);
		if (statSync(absolute).isDirectory()) throw new Error(`"${rel}" is a directory — list the files instead`);
		return rel;
	});

	const ignored = ignoredPaths(repo, normalized);
	if (ignored.length > 0) {
		throw new Error(`Refusing to commit git-ignored paths: ${ignored.join(", ")}`);
	}
	return normalized;
}

function gh(args: string[], cwd: string): string {
	try {
		return execFileSync("gh", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		if (/not found|ENOENT/.test(String((error as { code?: string }).code ?? "") + stderr)) {
			throw new Error("The GitHub CLI (gh) is required to open the PR: https://cli.github.com");
		}
		throw new Error(`gh ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
	}
}

export function ship(request: ShipRequest, onProgress?: (message: string) => void): ShipResult {
	assertValid(request);

	const config = loadConfig();
	const repo = resolveProject(config, request.project);
	const base = config.base;
	const title = request.title.trim();

	// Anything that differs afterwards means we disturbed the dev's work.
	const before = snapshot(repo);

	onProgress?.(`fetching origin/${base}`);
	git(["fetch", "origin", base], { cwd: repo });
	if (git(["rev-parse", "--verify", `origin/${base}`], { cwd: repo, allowFailure: true }) === undefined) {
		throw new Error(`origin/${base} does not exist in ${repo}`);
	}

	// Work starts on the base branch, so by default everything that differs from
	// it is the ticket. An explicit list narrows that when a session mixed two
	// pieces of work.
	const autoSelected = request.files === undefined && request.remove === undefined;
	const detected = autoSelected ? collectChanges(repo, base) : undefined;
	const files = normalizeFiles(repo, detected ? detected.files : (request.files ?? []));
	const removals = (detected ? detected.removed : (request.remove ?? [])).map((file) =>
		relative(repo, resolve(repo, file)),
	);

	if (files.length === 0 && removals.length === 0) {
		throw new Error(
			autoSelected
				? `Nothing differs from origin/${base} — no local commits, edits or new files to ship`
				: "Nothing to ship: the files list and remove list are both empty",
		);
	}
	if (autoSelected) {
		onProgress?.(
			`selected ${files.length} changed file(s)` +
				`${removals.length > 0 ? ` and ${removals.length} deletion(s)` : ""} vs origin/${base}`,
		);
	}

	const branch = nextBranchName(repo, `${request.type}/${request.ticket}`);
	const commitSubject = `${request.type}(${request.ticket}): ${title}`;
	const prTitle = `[${request.ticket}] ${request.type}: ${title}`;

	const worktree = mkdtempSync(join(tmpdir(), "pi-ship-"));
	try {
		onProgress?.(`creating ${branch} from origin/${base}`);
		git(["worktree", "add", "--quiet", worktree, "-b", branch, `origin/${base}`], { cwd: repo });

		for (const file of files) {
			const target = join(worktree, file);
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(join(repo, file), target);
		}
		for (const path of removals) {
			git(["rm", "-q", "--ignore-unmatch", "--", path], { cwd: worktree, allowFailure: true });
		}

		// Removals are already staged by `git rm`; passing them to `add` makes the
		// whole call fail (the path is gone), which would silently stage nothing.
		if (files.length > 0) git(["add", "--", ...files], { cwd: worktree });

		if (git(["diff", "--cached", "--quiet"], { cwd: worktree, allowFailure: true }) !== undefined) {
			throw new Error(`Those files are already identical to origin/${base} — nothing to ship`);
		}

		const message = request.body?.trim() ? `${commitSubject}\n\n${request.body.trim()}\n` : `${commitSubject}\n`;
		git(["commit", "--quiet", "-F", "-"], { cwd: worktree, input: message });
		onProgress?.(`committed ${files.length} file(s) as ${commitSubject}`);

		let prUrl: string | undefined;
		if (!request.commitOnly) {
			onProgress?.(`pushing ${branch}`);
			git(["push", "--quiet", "-u", "origin", branch], { cwd: worktree });

			const prBody = request.body?.trim() || `Ticket: ${request.ticket}`;
			const args = ["pr", "create", "--base", base, "--head", branch, "--title", prTitle, "--body", prBody];
			if (request.draft) args.push("--draft");
			prUrl = gh(args, worktree).split("\n").filter(Boolean).pop();
			onProgress?.(`opened ${prUrl}`);
		}

		return {
			repo,
			branch,
			base,
			commitSubject,
			prTitle,
			prUrl,
			shipped: files,
			removed: removals,
			autoSelected,
		};
	} finally {
		// Remove the worktree first, then verify we left the checkout alone —
		// a mismatch here is a bug worth shouting about.
		git(["worktree", "remove", "--force", worktree], { cwd: repo, allowFailure: true });
		rmSync(worktree, { recursive: true, force: true });

		const changes = diffSnapshots(before, snapshot(repo));
		if (changes.length > 0) {
			throw new Error(`ship modified the working checkout, which it must never do: ${changes.join("; ")}`);
		}
	}
}
