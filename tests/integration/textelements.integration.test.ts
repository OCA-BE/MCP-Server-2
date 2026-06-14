/**
 * Integration tests — Text element tools
 * Read-only. Requires a live SAP connection.
 * Run with: SAP_TEST_CONNECTION=CAR npm run test:integration
 */
import { describe, it, expect, beforeAll } from "vitest"
import { requireConnection, CONNECTION_ID } from "./helpers"
import { handleSearchAbapObjects } from "../../src/tools/discovery"
import { handleGetTextElements } from "../../src/tools/textelements"

beforeAll(() => requireConnection())

// Resolve a Z program that has text elements
let testProgram: string | null = null
let testProgramName: string | null = null

async function resolveTextProgram(): Promise<{ name: string } | null> {
  if (testProgram !== undefined) return testProgram ? { name: testProgram! } : null

  // Try to find any Z program — RSUSR003 is a standard program with selection texts
  const result = await handleSearchAbapObjects({
    query: "RSUSR003",
    objectType: "PROG",
    maxResults: 1,
    connectionId: CONNECTION_ID,
  })
  const nameMatch = result.content[0].text.match(/Name:\s+(\S+)/)
  testProgram = nameMatch ? nameMatch[1] : null
  testProgramName = testProgram
  return testProgram ? { name: testProgram } : null
}

describe("get_text_elements [integration]", () => {
  it("fetches all text element categories at once", async () => {
    const prog = await resolveTextProgram()
    if (!prog) { console.log("No test program found, skipping"); return }

    const result = await handleGetTextElements({
      objectType: "PROG/P",
      objectName: prog.name,
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    expect(text).toContain("Text elements for")
    // All three categories should appear in the response
    expect(text).toContain("selections")
    expect(text).toContain("symbols")
    expect(text).toContain("headings")
  })

  it("fetches only selections category", async () => {
    const prog = await resolveTextProgram()
    if (!prog) { console.log("No test program found, skipping"); return }

    const result = await handleGetTextElements({
      objectType: "PROG/P",
      objectName: prog.name,
      category: "selections",
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    expect(text).toContain("Text elements for")
  })

  it("fetches only symbols category", async () => {
    const prog = await resolveTextProgram()
    if (!prog) { console.log("No test program found, skipping"); return }

    const result = await handleGetTextElements({
      objectType: "PROG/P",
      objectName: prog.name,
      category: "symbols",
      connectionId: CONNECTION_ID,
    })
    expect(result.content[0].text).toContain("Text elements for")
  })

  it("returns graceful response for non-existent program", async () => {
    const result = await handleGetTextElements({
      objectType: "PROG/P",
      objectName: "ZZZZ_NONEXISTENT_9999",
      connectionId: CONNECTION_ID,
    })
    // Should not throw — may return empty or error message
    expect(result.content[0].text).toBeTruthy()
  })
})
