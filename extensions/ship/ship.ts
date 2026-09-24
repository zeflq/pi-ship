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
import { collectChanges, diffSnapshots, git, ignoredPaths, nextBranchName, originSlug, snapshot } from "./git.ts";

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
	/** Report the plan and change nothing: no branch, no commit, no push. */
	dryRun?: boolean;
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
	/** True when nothing was created — the result is a plan. */
	dryRun: boolean;
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

/**
 * Everything the PR path needs, checked before any work happens: gh present and
 * authenticated, and the remote writable.
 *
 * A push-time 403 arrives after the commit exists and says only "403" — an
 * archived repo and read-only access are indistinguishable there, and both are
 * common when shipping from a machine whose git credentials differ from its gh
 * login. A missing gh is worse: without this check the branch gets pushed and
 * the run dies at `gh pr create`, leaving a branch with no PR.
 */
function assertCanOpenPr(repo: string): void {
	try {
		execFileSync("gh", ["--version"], { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
	} catch {
		throw new Error(
			"The GitHub CLI (gh) is required to open the PR: https://cli.github.com — " +
				"or pass commitOnly to stop after the local commit.",
		);
	}

	const slug = originSlug(repo);
	if (!slug) return; // not a github.com remote: let gh speak for itself later

	let json: string;
	try {
		json = execFileSync("gh", ["repo", "view", slug, "--json", "isArchived,viewerPermission"], {
			cwd: repo,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		// Covers an expired login, no network, and a repo gh cannot see. All of
		// them would fail the push or the PR, so surface gh's own words now.
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Error(
			`Cannot read ${slug} with gh${stderr ? `: ${stderr}` : ""}. ` +
				"Check `gh auth status` — git may also be using different credentials than gh, which `gh auth setup-git` fixes.",
		);
	}

	const info = JSON.parse(json) as { isArchived?: boolean; viewerPermission?: string };
	if (info.isArchived) {
		throw new Error(`${slug} is archived on GitHub, so it is read-only. Unarchive it in Settings before shipping.`);
	}
	if (info.viewerPermission === "READ" || info.viewerPermission === "NONE") {
		throw new Error(
			`No write access to ${slug} (permission: ${info.viewerPermission}). ` +
				"Check `gh auth status` — git may be using different credentials than gh; `gh auth setup-git` fixes that.",
		);
	}
}

/** The preflight verdict as a line of text, for dry runs. */
function preflightSummary(repo: string): string {
	try {
		assertCanOpenPr(repo);
		const slug = originSlug(repo);
		return slug
			? `preflight ok — gh can write to ${slug}`
			: "preflight ok — gh present; origin is not a github.com remote, so access was not checked";
	} catch (error) {
		return `preflight would FAIL — ${error instanceof Error ? error.message : String(error)}`;
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

	if (!request.commitOnly && !request.dryRun) assertCanOpenPr(repo);
	else if (request.dryRun) onProgress?.(preflightSummary(repo));

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

	if (request.dryRun) {
		onProgress?.("dry run — nothing created");
		return { repo, branch, base, commitSubject, prTitle, shipped: files, removed: removals, autoSelected, dryRun: true };
	}

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
			dryRun: false,
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
