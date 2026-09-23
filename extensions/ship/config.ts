/**
 * Ship configuration: ~/.pi/ship.json
 *
 * {
 *   "projects": {
 *     "project-front": "~/projects/projectFront",
 *     "project-back":  "~/projects/projectBack"
 *   },
 *   "base": "develop"
 * }
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** PI_SHIP_CONFIG overrides the location, which is also how the tests point at a fixture. */
export const CONFIG_PATH = process.env.PI_SHIP_CONFIG?.trim() || join(homedir(), ".pi", "ship.json");

export interface ShipConfig {
	projects: Record<string, string>;
	base: string;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return isAbsolute(path) ? path : resolve(path);
}

export function loadConfig(configPath = CONFIG_PATH): ShipConfig {
	if (!existsSync(configPath)) {
		throw new Error(
			`No ship config at ${configPath}. Create it:\n` +
				`{\n  "projects": { "project-front": "~/projects/projectFront" },\n  "base": "develop"\n}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (error) {
		throw new Error(`${configPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	const raw = parsed as { projects?: unknown; base?: unknown };
	if (typeof raw.projects !== "object" || raw.projects === null || Array.isArray(raw.projects)) {
		throw new Error(`${configPath}: "projects" must be an object of name -> repository path`);
	}

	const projects: Record<string, string> = {};
	for (const [name, path] of Object.entries(raw.projects as Record<string, unknown>)) {
		if (typeof path !== "string" || !path.trim()) {
			throw new Error(`${configPath}: project "${name}" must map to a path string`);
		}
		projects[name] = expandHome(path.trim());
	}

	if (Object.keys(projects).length === 0) {
		throw new Error(`${configPath}: no projects configured`);
	}

	return { projects, base: typeof raw.base === "string" && raw.base.trim() ? raw.base.trim() : "develop" };
}

/** Resolves a project name to its repository path, listing the alternatives on a miss. */
export function resolveProject(config: ShipConfig, project: string): string {
	const path = config.projects[project];
	if (!path) {
		throw new Error(`Unknown project "${project}". Configured: ${Object.keys(config.projects).join(", ")}`);
	}
	if (!existsSync(join(path, ".git"))) {
		throw new Error(`Project "${project}" points at ${path}, which is not a git repository`);
	}
	return path;
}
