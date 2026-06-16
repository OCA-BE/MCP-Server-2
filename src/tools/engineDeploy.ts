/**
 * In-system ABAP deployment manager — makes transportability a CHOICE.
 *
 * The MCP can install its in-system ABAP either to $TMP (local, Dev-only,
 * re-pushed by the MCP) or to a Workbench Z package on a transport (so the
 * objects flow Dev→Prod via CTS, independent of the MCP code-push — letting
 * corporate security approve specific units for Production).
 *
 * Which units are transportable is per-connection config. On first run the
 * engine_deploy tool asks; you can re-run any time to flip a unit (e.g. promote
 * a higher-tier unit to transportable later). Risk tiers (riskTiers.ts) gate the
 * MCP *tool* surface; transportability here governs the *in-system* artifacts.
 */
import * as fs from "fs"
import * as path from "path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected, log } from "../connections"
import { handleCreateAbapObject, handleWriteAbapObjectSource } from "./write"
import { handleAbapActivate } from "./activate"
import { handleEngineBootstrap } from "./customizingEngine"
import { getDiagSource, DIAG_CLASS_NAME, DIAG_CLASS_URL, DIAG_ICF_PATH } from "../abap/zcl_mcp_diag"
import { ENGINE_CLASS_NAME, ENGINE_CLASS_URL, ENGINE_ICF_PATH } from "../abap/zcl_mcp_cust_engine"
import { WRITER_REPORT_NAME, WRITER_REPORT_URL } from "../abap/zmcp_cust_write"

export interface DeployObject { kind: "class" | "report"; name: string; url: string; getSource?: () => string }
export interface DeployUnit {
  id: string
  title: string
  tier: 0 | 1
  sicfPath: string
  description: string
  objects: DeployObject[]
}

/** The deployable in-system units. */
export const UNITS: DeployUnit[] = [
  {
    id: "diag", title: "Read-only diagnostics", tier: 0, sicfPath: DIAG_ICF_PATH,
    description: "ping/env, hana_memory, abap_memory — read-only, safe for Production",
    objects: [{ kind: "class", name: DIAG_CLASS_NAME, url: DIAG_CLASS_URL, getSource: getDiagSource }],
  },
  {
    id: "cust", title: "Customizing engine", tier: 1, sicfPath: ENGINE_ICF_PATH,
    description: "customizing write/create/delete, org_copy, retail listing",
    // cust is deployed via handleEngineBootstrap (handles its class + writer report)
    objects: [
      { kind: "class",  name: ENGINE_CLASS_NAME,  url: ENGINE_CLASS_URL },
      { kind: "report", name: WRITER_REPORT_NAME, url: WRITER_REPORT_URL },
    ],
  },
]

export function findUnit(id: string): DeployUnit | undefined {
  return UNITS.find(u => u.id === id)
}

export interface UnitDeploy { transportable: boolean; package: string; transport?: string }
export type DeployConfig = Record<string, Record<string, UnitDeploy>>   // connId → unitId → cfg

const keyOf = (connId?: string) => connId ?? "__default__"

// ── config persistence (injectable IO for tests) ───────────────────────────────
export function configPath(): string {
  return process.env.ABAP_DEPLOY_CONFIG ?? path.resolve(process.cwd(), "engine-deploy.json")
}
type Reader = (p: string) => string
type Writer = (p: string, c: string) => void
const defaultRead: Reader = p => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "")
const defaultWrite: Writer = (p, c) => fs.writeFileSync(p, c)

export function loadConfig(read: Reader = defaultRead): DeployConfig {
  try {
    const raw = read(configPath())
    return raw ? (JSON.parse(raw) as DeployConfig) : {}
  } catch { return {} }
}
export function saveConfig(cfg: DeployConfig, write: Writer = defaultWrite): void {
  write(configPath(), JSON.stringify(cfg, null, 2))
}

export function unitConfig(cfg: DeployConfig, connId: string | undefined, unitId: string): UnitDeploy | undefined {
  return cfg[keyOf(connId)]?.[unitId]
}
export function setUnitConfig(
  cfg: DeployConfig, connId: string | undefined, unitId: string, u: UnitDeploy,
): DeployConfig {
  const k = keyOf(connId)
  return { ...cfg, [k]: { ...(cfg[k] ?? {}), [unitId]: u } }
}
export function isFirstRun(cfg: DeployConfig, connId?: string): boolean {
  const c = cfg[keyOf(connId)]
  return c === undefined || Object.keys(c).length === 0
}

// ── prompts ─────────────────────────────────────────────────────────────────
export function buildSetupPrompt(connId?: string): string {
  const lines = [
    `In-system ABAP deployment — first-run setup for connection '${connId ?? "(default)"}'.`,
    ``,
    `Decide which units are TRANSPORTABLE: created in a Workbench Z package on a`,
    `transport so they can be released to Production via CTS, independent of this MCP`,
    `(corporate security approves them like any transport). Units not made transportable`,
    `deploy to $TMP (local, Dev-only — the MCP re-pushes them as needed).`,
    ``,
    `Units:`,
    ...UNITS.map(u => `  • ${u.id}  (Tier ${u.tier}) — ${u.title}: ${u.description}`),
    ``,
    `Run engine_deploy once per unit:`,
    `  • transportable:  engine_deploy unit:"diag" transportable:true package:"ZMCP_DIAG" transport:"<DEVK9…>"`,
    `  • Dev-only ($TMP): engine_deploy unit:"cust" transportable:false`,
    ``,
    `Recommendation: make 'diag' (Tier 0, read-only) transportable for Production box-health;`,
    `keep 'cust' (writes) and all code-creation tools Dev-only. You can flip any unit later`,
    `by re-running engine_deploy with new package/transport.`,
  ]
  return lines.join("\n")
}

export function buildStatus(cfg: DeployConfig, connId?: string): string {
  const lines = [`In-system deployment config for '${connId ?? "(default)"}':`]
  for (const u of UNITS) {
    const c = unitConfig(cfg, connId, u.id)
    lines.push(c
      ? `  • ${u.id} (Tier ${u.tier}) → ${c.transportable ? `transportable in ${c.package}${c.transport ? ` (${c.transport})` : ""}` : `$TMP (Dev-only)`}`
      : `  • ${u.id} (Tier ${u.tier}) → not deployed yet`)
  }
  lines.push(``, `Flip a unit: engine_deploy unit:"<id>" transportable:true package:"<Zpkg>" transport:"<req>"`)
  return lines.join("\n")
}

/** Resolve the target package for a deploy request; '' error string when invalid. */
export function resolveTarget(args: { transportable?: boolean; package?: string; transport?: string }):
  { ok: true; deploy: UnitDeploy } | { ok: false; error: string } {
  if (args.transportable) {
    if (!args.package || args.package.toUpperCase() === "$TMP") {
      return { ok: false, error: `transportable:true needs a Workbench Z package (not $TMP) in 'package'` }
    }
    return { ok: true, deploy: { transportable: true, package: args.package, transport: args.transport } }
  }
  return { ok: true, deploy: { transportable: false, package: "$TMP" } }
}

// ── deploy execution ──────────────────────────────────────────────────────────
async function deployUnitObjects(unit: DeployUnit, target: UnitDeploy, connectionId?: string): Promise<string[]> {
  const out: string[] = []
  // cust ships via the existing bootstrap (class + writer report, package/transport aware)
  if (unit.id === "cust") {
    const r = await handleEngineBootstrap({
      packageName: target.package, transport: target.transport, connectionId,
    })
    out.push(r.content[0]?.text ?? "(no output)")
    return out
  }
  const client = await ensureConnected(connectionId)
  for (const o of unit.objects) {
    let exists = false
    try { await client.getObjectSource(`${o.url}/source/main`); exists = true } catch { exists = false }
    if (!exists) {
      await handleCreateAbapObject({
        objectType: o.kind === "class" ? "CLAS/OC" : "PROG/P",
        name: o.name, description: `MCP ${unit.id} unit (${unit.title})`,
        packageName: target.package, transport: target.transport, connectionId,
      })
      out.push(`created ${o.name} in ${target.package}`)
    } else {
      out.push(`${o.name} exists — updating source (package unchanged; recreate to move packages)`)
    }
    if (o.getSource) {
      await handleWriteAbapObjectSource({ url: o.url, source: o.getSource(), transport: target.transport, connectionId })
    }
    const act = await handleAbapActivate({ url: o.url, connectionId })
    if (/❌|Activation failed/i.test(act.content[0]?.text ?? "")) {
      out.push(`❌ activation of ${o.name} failed: ${act.content[0]?.text}`)
      return out
    }
    out.push(`activated ${o.name}`)
  }
  out.push(`ℹ️  SICF: register node ${unit.sicfPath} with handler ${unit.objects[0].name} (one-time, in SICF) to expose this unit over HTTP.`)
  return out
}

export async function handleEngineDeploy(args: {
  unit?: string
  transportable?: boolean
  package?: string
  transport?: string
  connectionId?: string
}) {
  const cfg = loadConfig()

  // No unit specified → first-run setup prompt, or current status.
  if (!args.unit) {
    const text = isFirstRun(cfg, args.connectionId)
      ? buildSetupPrompt(args.connectionId)
      : buildStatus(cfg, args.connectionId)
    return { content: [{ type: "text" as const, text }] }
  }

  const unit = findUnit(args.unit)
  if (!unit) {
    return { content: [{ type: "text" as const, text:
      `❌ Unknown unit '${args.unit}'. Known units: ${UNITS.map(u => u.id).join(", ")}.` }] }
  }
  const resolved = resolveTarget(args)
  if (!resolved.ok) {
    return { content: [{ type: "text" as const, text: `❌ ${resolved.error}.` }] }
  }
  const target = resolved.deploy

  let result: string[]
  try {
    result = await deployUnitObjects(unit, target, args.connectionId)
  } catch (err) {
    return { content: [{ type: "text" as const, text:
      `❌ Deploy of unit '${unit.id}' failed: ${String((err as Error).message ?? err)}` }] }
  }

  // Persist the choice (the "flip" is just re-running with new values).
  try {
    saveConfig(setUnitConfig(cfg, args.connectionId, unit.id, target))
  } catch (err) {
    log("WARN", "could not persist engine-deploy config", err)
  }

  const head = target.transportable
    ? `✅ Unit '${unit.id}' deployed TRANSPORTABLE → package ${target.package}${target.transport ? ` on ${target.transport}` : ""} (release via CTS to reach Production).`
    : `✅ Unit '${unit.id}' deployed to $TMP (Dev-only).`
  return { content: [{ type: "text" as const, text: [head, "", ...result].join("\n") }] }
}

export function registerEngineDeployTools(server: McpServer): void {
  server.registerTool(
    "engine_deploy",
    {
      title: "Deploy In-System Engine (choose transportability)",
      description:
        "Install/manage the MCP's in-system ABAP, choosing per unit whether it is TRANSPORTABLE " +
        "(created in a Workbench Z package on a transport, to be released to Production via CTS " +
        "independent of the MCP) or deployed to $TMP (local, Dev-only). Run with NO unit to see the " +
        "first-run setup prompt (or current status). Run per unit to deploy/flip:\n" +
        "  engine_deploy unit:\"diag\" transportable:true package:\"ZMCP_DIAG\" transport:\"DEVK9…\"\n" +
        "  engine_deploy unit:\"cust\" transportable:false\n" +
        "Re-run any time to flip a unit (e.g. promote a higher-tier unit to transportable). Units: " +
        "diag (Tier 0 read-only diagnostics) · cust (Tier 1 customizing engine). After a transportable " +
        "deploy, register the unit's SICF node once (reported in the output).",
      inputSchema: {
        unit:          z.string().optional().describe("Unit to deploy: 'diag' or 'cust'. Omit to see the setup prompt / status."),
        transportable: z.boolean().optional().describe("true = create in a Workbench Z package on a transport (CTS to Prod); false/omitted = $TMP (Dev-only)."),
        package:       z.string().optional().describe("Workbench Z package for a transportable deploy (required when transportable:true; must not be $TMP)."),
        transport:     z.string().optional().describe("Workbench transport request to record the objects onto (for a transportable deploy)."),
        connectionId:  z.string().optional().describe("SAP system connection ID"),
      },
    },
    handleEngineDeploy,
  )
}
