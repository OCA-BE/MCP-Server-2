import { describe, it, expect } from "vitest"
import {
  UNITS, findUnit, loadConfig, saveConfig, unitConfig, setUnitConfig,
  isFirstRun, resolveTarget, buildSetupPrompt, buildStatus,
  icfNodeName, buildIcfSetupReport,
  type DeployConfig,
} from "../src/tools/engineDeploy"

describe("deploy units registry", () => {
  it("has diag (Tier 0) and cust (Tier 1)", () => {
    expect(findUnit("diag")?.tier).toBe(0)
    expect(findUnit("cust")?.tier).toBe(1)
    expect(findUnit("nope")).toBeUndefined()
    expect(UNITS.map(u => u.id).sort()).toEqual(["cust", "diag"])
  })
})

describe("config persistence (injected IO)", () => {
  it("loadConfig: empty → {}, valid → parsed, malformed → {}", () => {
    expect(loadConfig(() => "")).toEqual({})
    expect(loadConfig(() => JSON.stringify({ S4: { diag: { transportable: true, package: "ZMCP_DIAG" } } })))
      .toEqual({ S4: { diag: { transportable: true, package: "ZMCP_DIAG" } } })
    expect(loadConfig(() => "{bad")).toEqual({})
  })

  it("saveConfig writes pretty JSON via the injected writer", () => {
    let captured = ""
    saveConfig({ S4: { diag: { transportable: false, package: "$TMP" } } }, (_p, c) => { captured = c })
    expect(JSON.parse(captured)).toEqual({ S4: { diag: { transportable: false, package: "$TMP" } } })
  })

  it("setUnitConfig / unitConfig round-trip per connection", () => {
    let cfg: DeployConfig = {}
    cfg = setUnitConfig(cfg, "S4", "diag", { transportable: true, package: "ZMCP_DIAG", transport: "DEVK900100" })
    expect(unitConfig(cfg, "S4", "diag")).toEqual({ transportable: true, package: "ZMCP_DIAG", transport: "DEVK900100" })
    expect(unitConfig(cfg, "CAR", "diag")).toBeUndefined()
  })

  it("isFirstRun true until a unit is configured for that connection", () => {
    expect(isFirstRun({}, "S4")).toBe(true)
    const cfg = setUnitConfig({}, "S4", "diag", { transportable: false, package: "$TMP" })
    expect(isFirstRun(cfg, "S4")).toBe(false)
    expect(isFirstRun(cfg, "CAR")).toBe(true)   // per-connection
  })
})

describe("resolveTarget", () => {
  it("transportable requires a real Z package (not $TMP)", () => {
    expect(resolveTarget({ transportable: true })).toMatchObject({ ok: false })
    expect(resolveTarget({ transportable: true, package: "$TMP" })).toMatchObject({ ok: false })
  })
  it("transportable with a Z package + transport", () => {
    const r = resolveTarget({ transportable: true, package: "ZMCP_DIAG", transport: "DEVK900100" })
    expect(r).toEqual({ ok: true, deploy: { transportable: true, package: "ZMCP_DIAG", transport: "DEVK900100" } })
  })
  it("non-transportable → $TMP", () => {
    expect(resolveTarget({})).toEqual({ ok: true, deploy: { transportable: false, package: "$TMP" } })
    expect(resolveTarget({ transportable: false })).toEqual({ ok: true, deploy: { transportable: false, package: "$TMP" } })
  })
})

describe("SICF installer", () => {
  it("derives the node name from the SICF path", () => {
    expect(icfNodeName("/sap/bc/zmcp_diag")).toBe("ZMCP_DIAG")
    expect(icfNodeName("/sap/bc/zmcp_cust")).toBe("ZMCP_CUST")
  })
  it("bakes node/handler/path/package into the generated report", () => {
    const src = buildIcfSetupReport({
      node: "ZMCP_DIAG", path: "/sap/bc/zmcp_diag", handler: "ZCL_MCP_DIAG",
      docu: "MCP diagnostics", nodePackage: "ZMCP_DIAG",
    })
    expect(src).toContain("cl_icf_tree=>if_icf_tree~insert_node")  // create (not modify-only change_node)
    expect(src).toContain("node_already_existing = 2")             // idempotent
    expect(src).toContain("icf_name    = 'ZMCP_DIAG'")
    expect(src).toContain("ls_handler = 'ZCL_MCP_DIAG'")
    expect(src).toContain("url = '/sap/bc/zmcp_diag'")
    expect(src).toContain("package     = 'ZMCP_DIAG'")
    expect(src).toContain("ZMCP_ICF_LOG_ZMCP_DIAG")
    expect(src).toContain("RISK LEVEL HARMLESS")   // run via AUnit
  })
})

describe("prompts", () => {
  it("setup prompt lists units + transportable guidance", () => {
    const p = buildSetupPrompt("S4")
    expect(p).toContain("diag")
    expect(p).toContain("cust")
    expect(p).toContain("TRANSPORTABLE")
    expect(p).toContain("$TMP")
  })
  it("status reflects configured + not-deployed units", () => {
    const cfg = setUnitConfig({}, "S4", "diag", { transportable: true, package: "ZMCP_DIAG", transport: "DEVK900100" })
    const s = buildStatus(cfg, "S4")
    expect(s).toContain("transportable in ZMCP_DIAG")
    expect(s).toContain("cust")          // listed
    expect(s).toContain("not deployed yet")
  })
})
