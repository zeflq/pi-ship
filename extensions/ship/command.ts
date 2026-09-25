/**
 * The /ship command: the deterministic path.
 *
 * Nothing here asks the model for anything, so it costs no turn and no tokens,
 * and nothing about the ticket or title can be invented. It also gets to show
 * the detected file list and take a yes/no *before* the commit exists — which
 * the tool cannot do, since it reports only as it goes.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { loadConfig, resolveProject, type ShipConfig } from "./config.ts";
import { collectChanges } from "./git.ts";
import { ship, TICKET_PATTERN, type ShipRequest } from "./ship.ts";

const TYPES = ["fix", "feat"] as const;

interface ParsedArgs {
	ticket?: string;
	type?: "fix" | "feat";
	title?: string;
	project?: string;
}

/** `/ship [project] TICKET fix "title"` — every part optional in a TUI. */
export function parseArgs(args: string, projects: string[]): ParsedArgs {
	const parsed: ParsedArgs = {};
	// Pull a quoted title out first so its spaces do not confuse the rest.
	const quoted = args.match(/"([^"]+)"|'([^']+)'/);
	let rest = args;
	if (quoted) {
		parsed.title = (quoted[1] ?? quoted[2]).trim();
		rest = args.replace(quoted[0], " ");
	}

	const words = rest.split(/\s+/).filter(Boolean);
	const leftovers: string[] = [];
	for (const word of words) {
		if (!parsed.project && projects.includes(word)) parsed.project = word;
		else if (!parsed.type && (word === "fix" || word === "feat")) parsed.type = word;
		else if (!parsed.ticket && TICKET_PATTERN.test(word)) parsed.ticket = word;
		else leftovers.push(word);
	}

	// An unquoted trailing phrase is the title.
	if (!parsed.title && leftovers.length > 0) parsed.title = leftovers.join(" ");
	return parsed;
}

function describeSelection(repo: string, base: string): string {
	const { files, removed } = collectChanges(repo, base);
	const lines = files.map((file) => `  + ${file}`).concat(removed.map((file) => `  - ${file}`));
	if (lines.length === 0) return `Nothing differs from origin/${base}.`;
	return `${files.length} file(s), ${removed.length} deletion(s) vs origin/${base}:\n${lines.join("\n")}`;
}

async function collectInteractively(
	ctx: ExtensionCommandContext,
	config: ShipConfig,
	parsed: ParsedArgs,
): Promise<ShipRequest | undefined> {
	const projectNames = Object.keys(config.projects);
	const project =
		parsed.project ?? (projectNames.length === 1 ? projectNames[0] : await ctx.ui.select("Project", projectNames));
	if (!project) return undefined;

	let ticket = parsed.ticket;
	while (!ticket) {
		const answer = (await ctx.ui.input("Ticket", "PROJECT_A-412"))?.trim();
		if (answer === undefined) return undefined;
		if (TICKET_PATTERN.test(answer)) ticket = answer;
		else ctx.ui.notify(`"${answer}" must look like PROJECT_A-412`, "warning");
	}

	const type = parsed.type ?? ((await ctx.ui.select("Type", [...TYPES])) as "fix" | "feat" | undefined);
	if (!type) return undefined;

	let title = parsed.title;
	while (!title) {
		const answer = (await ctx.ui.input("Title", "prevent double review on synchronize"))?.trim();
		if (answer === undefined) return undefined;
		if (answer.length > 0 && answer.length <= 72) title = answer;
		else ctx.ui.notify("Title must be 1-72 characters", "warning");
	}

	// Shown before anything is created, so "no" costs nothing.
	const repo = resolveProject(config, project);
	const confirmed = await ctx.ui.confirm(
		`Ship ${type}(${ticket}): ${title}`,
		`${describeSelection(repo, config.base)}\n\nBranch from origin/${config.base} and open a PR?`,
	);
	if (!confirmed) return undefined;

	const body = (await ctx.ui.editor("PR body — why, and how it was verified", ""))?.trim();
	return { project, ticket, type, title, body: body || undefined };
}

export async function runShipCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	let config: ShipConfig;
	try {
		config = loadConfig();
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}

	if (args.trim() === "config") {
		const projects = Object.entries(config.projects)
			.map(([name, path]) => `  ${name} → ${path}`)
			.join("\n");
		ctx.ui.notify(`ship: ${config.path}\nbase origin/${config.base}\n${projects}`, "info");
		return;
	}

	const parsed = parseArgs(args, Object.keys(config.projects));

	let request: ShipRequest | undefined;
	if (ctx.hasUI) {
		request = await collectInteractively(ctx, config, parsed);
		if (!request) {
			ctx.ui.notify("ship cancelled", "info");
			return;
		}
	} else {
		// Print mode has no dialogs: everything must already be on the line.
		const projectNames = Object.keys(config.projects);
		const project = parsed.project ?? (projectNames.length === 1 ? projectNames[0] : undefined);
		if (!project || !parsed.ticket || !parsed.type || !parsed.title) {
			ctx.ui.notify(`Usage: /ship [project] TICKET-123 fix|feat "title"`, "error");
			return;
		}
		request = { project, ticket: parsed.ticket, type: parsed.type, title: parsed.title };
	}

	try {
		const result = ship(request, (message) => ctx.ui.setStatus("ship", message));
		ctx.ui.notify(
			[
				`${result.commitSubject}`,
				`branch ${result.branch} from origin/${result.base}`,
				result.prUrl ?? "no PR opened",
			].join("\n"),
			"info",
		);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	} finally {
		ctx.ui.setStatus("ship", "");
	}
}
