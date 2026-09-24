/**
 * Standalone runner for the same dry run /ship-debug performs, for checking a
 * machine without starting pi:
 *
 *   node scripts/ship-debug.ts                    # dry: every configured project
 *   node scripts/ship-debug.ts project-front      # dry: one project
 *   node scripts/ship-debug.ts live project-front # push an empty probe PR, then close it
 *   node scripts/ship-debug.ts live project-front --keep
 */

import { shipDebug, shipDebugLive } from "../extensions/ship/debug.ts";

const args = process.argv.slice(2);
const live = args.includes("live");
const keep = args.includes("--keep");
const project = args.find((arg) => arg !== "live" && arg !== "--keep");

const report = live ? shipDebugLive(project, { keep }) : shipDebug(project);
console.log(report.lines.join("\n"));
process.exit(report.ok ? 0 : 1);
