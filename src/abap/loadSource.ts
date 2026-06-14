/**
 * Reads ABAP source for the Customizing Engine from disk at call time.
 *
 * The engine class and writer report live as standalone .abap files next to
 * this module (the single source of truth). Reading them at bootstrap time —
 * rather than baking them into the bundle — means an ABAP-only change is picked
 * up by the next `customizing_engine_bootstrap` call with NO rebuild and NO
 * server restart. (A tool-schema change still needs a rebuild + MCP reconnect.)
 *
 * Dynamic spots in the source are marked {{PLACEHOLDER}} and substituted here.
 */
import * as fs from "fs"
import * as path from "path"

// Candidate directories holding the .abap files, in priority order. Covers the
// bundled runtime (dist/index.js → repo/src/abap), the unbundled/ts-node runtime
// (this module already sits in src/abap), and an explicit override.
function candidateDirs(): string[] {
  const dirs = [
    process.env.ABAP_SRC_DIR,
    __dirname,                                   // ts-node / vitest: src/abap
    path.resolve(__dirname, "../src/abap"),      // bundled: dist → repo/src/abap
    path.resolve(process.cwd(), "src/abap"),     // run from repo root
  ]
  return dirs.filter((d): d is string => Boolean(d))
}

/** Read a .abap file by base name (no extension) from the first dir that has it. */
export function readAbap(baseName: string): string {
  const file = `${baseName}.abap`
  const tried: string[] = []
  for (const dir of candidateDirs()) {
    const p = path.join(dir, file)
    tried.push(p)
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8")
  }
  throw new Error(
    `ABAP source ${file} not found. Looked in:\n  ${tried.join("\n  ")}\n` +
    `Set ABAP_SRC_DIR to the directory containing the .abap files if running outside the repo.`,
  )
}

/** Substitute {{KEY}} placeholders with the given values. */
export function applyPlaceholders(src: string, vars: Record<string, string>): string {
  let out = src
  for (const [key, val] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(val)
  }
  return out
}
