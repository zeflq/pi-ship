/**
 * Ship configuration: `<root>/.pi/ship.json`, where <root> is the directory pi
 * was started in (or the nearest ancestor that has one). Config is per
 * workspace, not per user, so a bridged or cloned workspace carries its own.
 *
 * {
 *   "projects": {
 *     "project-front": "./project-front",
 *     "project-back":  "./project-back"
 *   },
 *   "base": "develop"
 * }
 *
 * Project paths are resolved against <root>, so they stay valid on whichever
 * machine the workspace is mounted on.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

export const CONFIG_DIR = ".pi";
export const CONFIG_NAME = "ship.json";

export interface ShipConfig {
	/** Directory holding `.pi/ship.json` — every project path is relative to it. */
	root: string;
	path: string;
	projects: Record<string, string>;
	base: string;
}

/** Nearest `<dir>/.pi/ship.json` walking up from `from`. PI_SHIP_CONFIG wins. */
export function findConfig(from: string = process.cwd()): string | undefined {
	const override = process.env.PI_SHIP_CONFIG?.trim();
	if (override) return override;

	let dir = resolve(from);
	const { root } = parse(dir);
	while (true) {
		const candidate = join(dir, CONFIG_DIR, CONFIG_NAME);
		if (existsSync(candidate)) return candidate;
		if (dir === root) return undefined;
		dir = dirname(dir);
	}
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadConfig(from?: string): ShipConfig {
	const configPath = findConfig(from);
	if (!configPath) {
		throw new Error(
			`No ${CONFIG_DIR}/${CONFIG_NAME} found from ${resolve(from ?? process.cwd())} upwards. Create one:\n` +
				`{\n  "projects": { "project-front": "./project-front" },\n  "base": "develop"\n}`,
		);
	}
	if (!existsSync(configPath)) {
		throw new Error(`PI_SHIP_CONFIG points at ${configPath}, which does not exist`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (error) {
		throw new Error(`${configPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	const raw = parsed as { projects?: unknown; base?: unknown };
	if (typeof raw.projects !== "object" || raw.projects === null || Array.isArray(raw.projects)) {
		throw new Error(`${configPath}: "projects" must be an object of name -> path relative to the workspace root`);
	}

	// <root>/.pi/ship.json → <root>
	const root = dirname(dirname(configPath));

	const projects: Record<string, string> = {};
	for (const [name, path] of Object.entries(raw.projects as Record<string, unknown>)) {
		if (typeof path !== "string" || !path.trim()) {
			throw new Error(`${configPath}: project "${name}" must map to a path string`);
		}
		const expanded = expandHome(path.trim());
		projects[name] = isAbsolute(expanded) ? expanded : resolve(root, expanded);
	}

	if (Object.keys(projects).length === 0) {
		throw new Error(`${configPath}: no projects configured`);
	}

	return {
		root,
		path: configPath,
		projects,
		base: typeof raw.base === "string" && raw.base.trim() ? raw.base.trim() : "develop",
	};
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
