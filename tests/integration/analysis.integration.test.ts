/**
 * Integration tests — Analysis tools
 * Read-only. Requires a live SAP connection.
 * Run with: SAP_TEST_CONNECTION=CAR npm run test:integration
 */
import { describe, it, expect, beforeAll } from "vitest"
import { requireConnection, CONNECTION_ID } from "./helpers"
import { handleSearchAbapObjects } from "../../src/tools/discovery"
import {
  handleWhereUsed,
  handleVersionHistory,
  handleAnalyzeDump,
  handleCheckInactiveObjects,
} from "../../src/tools/analysis"

beforeAll(() => requireConnection())

async function findObjectUrl(query: string, type: string): Promise<string | null> {
  const result = await handleSearchAbapObjects({ query, objectType: type, maxResults: 1, connectionId: CONNECTION_ID })
  const match = result.content[0].text.match(/URL: ([^\n]+)/)
  return match ? match[1].trim() : null
}

describe("where_used [integration]", () => {
  it("returns references or a clear not-found message", async () => {
    const url = await findObjectUrl("RSUSR003", "PROG")
    if (!url) { console.log("No test program found, skipping"); return }

    const result = await handleWhereUsed({ url, connectionId: CONNECTION_ID })
    const text = result.content[0].text
    expect(text).toMatch(/Found \d+ usage|No usages found/)
  })
})

describe("version_history [integration]", () => {
  it("returns revision history or a clear not-found message", async () => {
    const url = await findObjectUrl("RSUSR003", "PROG")
    if (!url) { console.log("No test program found, skipping"); return }

    const result = await handleVersionHistory({ url, connectionId: CONNECTION_ID })
    const text = result.content[0].text
    expect(text).toMatch(/Version history \(\d+ revision|No version history found/)
  })
})

describe("analyze_dump [integration]", () => {
  it("returns dump list or a clear no-dumps message", async () => {
    const result = await handleAnalyzeDump({ connectionId: CONNECTION_ID })
    const text = result.content[0].text
    expect(text).toMatch(/Runtime dumps \(\d+\)|No runtime dumps found/)
  })
})

describe("check_inactive_objects [integration]", () => {
  it("returns inactive list or a clear all-active message", async () => {
    const result = await handleCheckInactiveObjects({ connectionId: CONNECTION_ID })
    const text = result.content[0].text
    expect(text).toMatch(/\d+ inactive object|No inactive objects/)
  })
})
