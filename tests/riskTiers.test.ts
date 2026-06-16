import { describe, it, expect, vi } from "vitest"
import { tierOf, getMaxTier, wrapServerWithTierGating, TOOL_TIERS } from "../src/tools/riskTiers"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

vi.mock("../src/connections", () => ({ log: vi.fn() }))

describe("risk tiers", () => {
  it("classifies known read/write/code tools", () => {
    expect(tierOf("hana_memory_report")).toBe(0)
    expect(tierOf("execute_data_query")).toBe(0)
    expect(tierOf("customizing_apply")).toBe(1)
    expect(tierOf("org_copy")).toBe(1)
    expect(tierOf("create_abap_object")).toBe(2)
    expect(tierOf("write_abap_object_source")).toBe(2)
  })

  it("defaults unmapped tools to tier 2 (fail-safe)", () => {
    expect(tierOf("some_brand_new_tool")).toBe(2)
  })

  it("getMaxTier reads ABAP_MCP_MAX_TIER (default 2)", () => {
    const prev = process.env.ABAP_MCP_MAX_TIER
    delete process.env.ABAP_MCP_MAX_TIER
    expect(getMaxTier()).toBe(2)
    process.env.ABAP_MCP_MAX_TIER = "0"
    expect(getMaxTier()).toBe(0)
    process.env.ABAP_MCP_MAX_TIER = "1"
    expect(getMaxTier()).toBe(1)
    if (prev === undefined) delete process.env.ABAP_MCP_MAX_TIER
    else process.env.ABAP_MCP_MAX_TIER = prev
  })

  it("gating skips tools above the ceiling and keeps those at/below it", () => {
    const registered: string[] = []
    const fake = { registerTool: (name: string) => { registered.push(name) } } as unknown as McpServer
    const gated = wrapServerWithTierGating(fake, 0)
    gated.registerTool("hana_memory_report", {}, (() => {}) as never)   // tier 0 → kept
    gated.registerTool("customizing_apply", {}, (() => {}) as never)     // tier 1 → skipped
    gated.registerTool("create_abap_object", {}, (() => {}) as never)    // tier 2 → skipped
    expect(registered).toEqual(["hana_memory_report"])
  })

  it("tier 1 ceiling exposes reads + config writes, not code writes", () => {
    const registered: string[] = []
    const fake = { registerTool: (name: string) => { registered.push(name) } } as unknown as McpServer
    const gated = wrapServerWithTierGating(fake, 1)
    gated.registerTool("customizing_read", {}, (() => {}) as never)      // 0 → kept
    gated.registerTool("customizing_apply", {}, (() => {}) as never)     // 1 → kept
    gated.registerTool("write_abap_object_source", {}, (() => {}) as never) // 2 → skipped
    expect(registered).toEqual(["customizing_read", "customizing_apply"])
  })

  it("every classified tool has a valid tier", () => {
    for (const [name, tier] of Object.entries(TOOL_TIERS)) {
      expect([0, 1, 2], `${name}`).toContain(tier)
    }
  })
})
