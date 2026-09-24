/**
 * /ship-debug — run the whole ship path against fake ticket data and change
 * nothing. Reports the config it loaded, the preflight verdict, the branch it
 * would create, the exact commit subject and PR title, and the file set it
 * detected.
 *
 * Use it to check a new machine or a new project entry without needing real
 * work in progress or a real ticket.
 */

import { loadConfig, CONFIG_PATH, resolveProject } from "./config.ts";
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
