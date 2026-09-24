/**
 * /ship-debug — run the whole ship path against fake ticket data and change
 * nothing. Reports the config it loaded, the preflight verdict, the branch it
 * would create, the exact commit subject and PR title, and the file set it
 * detected.
 *
 * Use it to check a new machine or a new project entry without needing real
 * work in progress or a real ticket.
 */

import { execFileSync } from "node:child_process";

import { loadConfig, CONFIG_PATH, resolveProject } from "./config.ts";
import { git } from "./git.ts";
import { ship, type ShipResult } from "./ship.ts";

export const DEBUG_TICKET = "DEBUG-1234";
export const DEBUG_TITLE = "debug probe — nothing is created";

export interface DebugReport {
	lines: string[];
	ok: boolean;
}

/** Runs a dry ship for one project, or for every configured project. */
export function shipDebug(project?: string): DebugReport {
	const lines: string[] = [`config: ${CONFIG_PATH}`];
	let ok = true;

	let projects: string[];
	let base: string;
	try {
		const config = loadConfig();
		base = config.base;
		projects = project ? [project] : Object.keys(config.projects);
		lines.push(`base:   origin/${base}`, `ticket: ${DEBUG_TICKET} (fake)`, "");
		for (const [name, path] of Object.entries(config.projects)) {
			lines.push(`  ${project && name !== project ? " " : "→"} ${name} → ${path}`);
		}
		lines.push("");
		// resolveProject throws on a path that is not a git repo, which is the
		// most common config mistake.
		for (const name of projects) resolveProject(config, name);
	} catch (error) {
		return { lines: [...lines, `config error: ${error instanceof Error ? error.message : String(error)}`], ok: false };
	}

	for (const name of projects) {
		lines.push(`── ${name} ──`);
		try {
			const result: ShipResult = ship(
				{ project: name, ticket: DEBUG_TICKET, type: "fix", title: DEBUG_TITLE, dryRun: true },
				(message) => lines.push(`   ${message}`),
			);
			lines.push(
				`   branch:  ${result.branch}  (from origin/${result.base})`,
				`   commit:  ${result.commitSubject}`,
				`   PR:      ${result.prTitle}`,
				`   files:   ${result.shipped.length > 0 ? result.shipped.join(", ") : "(none)"}`,
			);
			if (result.removed.length > 0) lines.push(`   removed: ${result.removed.join(", ")}`);
		} catch (error) {
			ok = false;
			lines.push(`   FAILED: ${error instanceof Error ? error.message : String(error)}`);
		}
		lines.push("");
	}

	lines.push(ok ? "Dry run complete. Nothing was branched, committed or pushed." : "Dry run found problems — see above.");
	return { lines, ok };
}

/**
 * Live probe: actually push a branch and open a draft PR with an **empty**
 * commit, then close the PR and delete the branch again.
 *
 * This is the only way to test the parts a dry run cannot reach — git's push
 * credentials and `gh pr create` — and it does it without an LLM turn and
 * without shipping any real work.
 */
export function shipDebugLive(project?: string, options?: { keep?: boolean }): DebugReport {
	const lines: string[] = [`config: ${CONFIG_PATH}`, `ticket: ${DEBUG_TICKET} (fake, empty commit)`, ""];

	let repo: string;
	let name: string;
	try {
		const config = loadConfig();
		const names = Object.keys(config.projects);
		name = project ?? (names.length === 1 ? names[0] : "");
		if (!name) {
			return { lines: [...lines, `Pick a project: ${names.join(", ")}`], ok: false };
		}
		repo = resolveProject(config, name);
	} catch (error) {
		return { lines: [...lines, `config error: ${error instanceof Error ? error.message : String(error)}`], ok: false };
	}

	lines.push(`── ${name} — live probe ──`);
	let result: ShipResult | undefined;
	try {
		result = ship(
			{
				project: name,
				ticket: DEBUG_TICKET,
				type: "fix",
				title: "ship debug probe",
				body: "Automated probe from /ship-debug live. Empty commit, closed immediately.",
				probe: true,
				draft: true,
			},
			(message) => lines.push(`   ${message}`),
		);
		lines.push(`   ✓ push and gh pr create both work`, `   PR: ${result.prUrl ?? "(no url returned)"}`);
	} catch (error) {
		lines.push(`   ✗ ${error instanceof Error ? error.message : String(error)}`);
		return { lines: [...lines, "", "Probe failed — the message above is the real reason a ship would fail."], ok: false };
	}

	if (options?.keep) {
		lines.push("", `Left in place: branch ${result.branch} and its draft PR. Clean up when done.`);
		return { lines, ok: true };
	}

	// Cleanup is best-effort and reported: a half-removed probe must not look
	// like a success.
	let cleaned = true;
	try {
		execFileSync("gh", ["pr", "close", result.branch, "--delete-branch"], {
			cwd: repo,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		lines.push(`   ✓ closed the PR and deleted origin/${result.branch}`);
	} catch (error) {
		cleaned = false;
		const stderr = (error as { stderr?: string }).stderr?.trim();
		lines.push(`   ! could not close the PR${stderr ? `: ${stderr}` : ""} — remove ${result.branch} by hand`);
	}
	git(["branch", "-D", result.branch], { cwd: repo, allowFailure: true });
	// gh deletes the remote branch, but the stale tracking ref stays until pruned.
	git(["fetch", "--prune", "--quiet", "origin"], { cwd: repo, allowFailure: true });

	lines.push("", cleaned ? "Probe complete and cleaned up." : "Probe worked, cleanup did not — see above.");
	return { lines, ok: cleaned };
}
