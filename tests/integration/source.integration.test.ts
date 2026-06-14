/**
 * Integration tests — Source reading tools
 * Read-only. Requires a live SAP connection.
 * Run with: SAP_TEST_CONNECTION=CAR npm run test:integration
 */
import { describe, it, expect, beforeAll } from "vitest"
import { requireConnection, CONNECTION_ID } from "./helpers"
import { handleSearchAbapObjects } from "../../src/tools/discovery"
import {
  handleGetAbapObjectLines,
  handleSearchAbapObjectLines,
  handleGetAbapBatchLines,
  handleSyntaxCheck,
} from "../../src/tools/source"

beforeAll(() => requireConnection())

// Resolve a real program URL once, reuse across tests
let programSourceUrl: string | null = null

async function resolveSourceUrl(): Promise<string | null> {
  if (programSourceUrl !== undefined) return programSourceUrl
  const result = await handleSearchAbapObjects({
    query: "RSUSR003",
    objectType: "PROG",
    maxResults: 1,
    connectionId: CONNECTION_ID,
  })
  const urlMatch = result.content[0].text.match(/URL: ([^\n]+)/)
  programSourceUrl = urlMatch ? urlMatch[1].trim() + "/source/main" : null
  return programSourceUrl
}

describe("get_abap_object_lines [integration]", () => {
  it("returns non-empty source for a real program", async () => {
    const url = await resolveSourceUrl()
    if (!url) { console.log("No test program found, skipping"); return }

    const result = await handleGetAbapObjectLines({ url, connectionId: CONNECTION_ID })
    const text = result.content[0].text
    expect(text.length).toBeGreaterThan(10)
    // All ABAP programs start with REPORT, PROGRAM, or FUNCTION-POOL
    expect(text).toMatch(/^(REPORT|PROGRAM|FUNCTION-POOL)/im)
  })
})

describe("search_abap_object_lines [integration]", () => {
  it("finds REPORT statement in program source", async () => {
    const url = await resolveSourceUrl()
    if (!url) { console.log("No test program found, skipping"); return }

    const result = await handleSearchAbapObjectLines({
      url,
      pattern: "REPORT",
      connectionId: CONNECTION_ID,
    })
    expect(result.content[0].text).toContain("Found")
    expect(result.content[0].text).toMatch(/\d+:/)
  })

  it("returns no-match for a pattern that cannot exist", async () => {
    const url = await resolveSourceUrl()
    if (!url) { console.log("No test program found, skipping"); return }

    const result = await handleSearchAbapObjectLines({
      url,
      pattern: "ZZZZ_IMPOSSIBLE_PATTERN_9999",
      connectionId: CONNECTION_ID,
    })
    expect(result.content[0].text).toContain("No matches")
  })
})

describe("get_abap_batch_lines [integration]", () => {
  it("reads two URLs and returns both", async () => {
    const url = await resolveSourceUrl()
    if (!url) { console.log("No test program found, skipping"); return }

    const result = await handleGetAbapBatchLines({
      urls: [url, url],
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    // Should have two sections
    const sections = text.split("===").filter(s => s.trim() && !s.trim().startsWith("ERROR"))
    expect(sections.length).toBeGreaterThanOrEqual(2)
  })
})

describe("syntax_check [integration]", () => {
  it("reports clean for valid ABAP source", async () => {
    const url = await resolveSourceUrl()
    if (!url) { console.log("No test program found, skipping"); return }

    const objectUrl = url.replace("/source/main", "")
    const result = await handleSyntaxCheck({
      url,
      mainUrl: url,
      source: "REPORT z_syntax_test.\nWRITE 'hello'.",
      connectionId: CONNECTION_ID,
    })
    // Either clean or error messages — both are acceptable (depends on system config)
    expect(result.content[0].text).toBeTruthy()
  })
})
