/**
 * Standalone runner for the same dry run /ship-debug performs, for checking a
 * machine without starting pi:
 *
 *   node scripts/ship-debug.ts               # every configured project
 *   node scripts/ship-debug.ts project-front # just one
 *   PI_SHIP_CONFIG=/tmp/ship.json node scripts/ship-debug.ts
 */

import { shipDebug } from "../extensions/ship/debug.ts";

const report = shipDebug(process.argv[2]);
console.log(report.lines.join("\n"));
process.exit(report.ok ? 0 : 1);
