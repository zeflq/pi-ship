/**
 * pi extension: ship work to a PR without disturbing the working checkout.
 *
 * The model supplies the prose (title, body, which files it touched); this
 * extension performs the git and gh steps deterministically.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { runShipCommand } from "./command.ts";
import { CONFIG_PATH, loadConfig } from "./config.ts";
import { ship, type ShipRequest } from "./ship.ts";

function formatResult(result: ReturnType<typeof ship>): string {
	const lines = [
		`Branch:  ${result.branch}  (from origin/${result.base})`,
		`Commit:  ${result.commitSubject}`,
		`Files:   ${result.shipped.join(", ") || "(none)"}${result.autoSelected ? "  (auto-selected)" : ""}`,
	];
	if (result.removed.length > 0) lines.push(`Removed: ${result.removed.join(", ")}`);
	lines.push(result.prUrl ? `PR:      ${result.prUrl}` : `PR:      not opened (commit-only)`);
	lines.push("", "Your checkout is untouched: same HEAD, same staged and unstaged changes, same stashes.");
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ship",
		label: "Ship to PR",
		description:
			"Branch from origin/<base>, commit the named working-tree files onto it, push, and open a pull request. " +
			"Never modifies the current branch, index, working tree or stash.",
		promptSnippet: "Open a PR for the current changes from a ticket id, without touching the working checkout",
		promptGuidelines: [
			"Use ship when the user asks to raise a PR for a ticket; it needs the project, ticket id, fix|feat and a title.",
			"Let ship pick the files by default: it ships everything that differs from the base branch. Pass files only to narrow that, when one session mixed two pieces of work.",
		],
		parameters: Type.Object({
			project: Type.String({ description: 'Project key from ~/.pi/ship.json, e.g. "project-front"' }),
			ticket: Type.String({ description: 'Ticket id, e.g. "PROJECT_A-412"' }),
			type: Type.Union([Type.Literal("fix"), Type.Literal("feat")]),
			title: Type.String({ description: "Imperative summary, under 72 chars. Used for the commit and the PR title." }),
			files: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Repo-relative paths to commit. Omit to ship everything that differs from the base branch — " +
						"local commits, staged and unstaged edits, and new files. Only pass this to narrow that set.",
				}),
			),
			remove: Type.Optional(
				Type.Array(Type.String(), { description: "Repo-relative paths to delete. Detected automatically when files is omitted." }),
			),
			body: Type.Optional(Type.String({ description: "Commit body and PR description: what changed, why, how verified" })),
			draft: Type.Optional(Type.Boolean({ description: "Open the PR as a draft" })),
			commitOnly: Type.Optional(Type.Boolean({ description: "Stop after the local commit — no push, no PR" })),
		}),
		async execute(_toolCallId, params, _signal, onUpdate) {
			const result = ship(params as ShipRequest, (message) => {
				onUpdate?.({ content: [{ type: "text", text: `[ship] ${message}` }], details: {} });
			});
			return { content: [{ type: "text", text: formatResult(result) }], details: { ...result } };
		},
	});

	pi.registerCommand("ship", {
		description: 'Branch, commit and open a PR — /ship [project] TICKET-123 fix|feat "title", or /ship config',
		getArgumentCompletions: (prefix: string) => {
			let names: string[];
			try {
				names = [...Object.keys(loadConfig().projects), "config"];
			} catch {
				return null;
			}
			const items = names.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
			return items.length > 0 ? items : null;
		},
		handler: runShipCommand,
	});

	// A ship is only safe because the checkout is read-only. Committing or
	// force-pushing by hand in the middle of one is how that gets broken.
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (/\bgit\s+push\b/.test(command) && /\s(--force|-f)(\s|$)/.test(command)) {
			return { block: true, reason: "Use --force-with-lease, or the ship tool, instead of a bare force push." };
		}
		if (/\bgit\s+(commit|switch|checkout\s+-b|branch)\b/.test(command)) {
			return {
				block: true,
				reason: `Use the ship tool to branch and commit — it works in a throwaway worktree and leaves this checkout alone. Config: ${CONFIG_PATH}`,
			};
		}
	});
}
