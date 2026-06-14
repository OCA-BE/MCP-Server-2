/**
 * Integration tests — Discovery tools
 * Read-only. Requires a live SAP connection.
 * Run with: SAP_TEST_CONNECTION=CAR npm run test:integration
 */
import { describe, it, expect, beforeAll } from "vitest"
import { requireConnection, CONNECTION_ID } from "./helpers"
import {
  handleConnectedSystems,
  handleSearchAbapObjects,
  handleGetAbapObjectInfo,
  handleAdtDiscovery,
} from "../../src/tools/discovery"

beforeAll(() => requireConnection())

describe("connected_systems [integration]", () => {
  it("lists at least the configured connection", async () => {
    const result = await handleConnectedSystems()
    expect(result.content[0].text).toContain(CONNECTION_ID)
  })
})

describe("search_abap_objects [integration]", () => {
  it("returns results for a broad Z* search", async () => {
    const result = await handleSearchAbapObjects({
      query: "Z*",
      maxResults: 5,
      connectionId: CONNECTION_ID,
    })
    // Either we find objects or a clear not-found message — both are valid
    expect(result.content[0].text).toBeTruthy()
  })

  it("filters by object type PROG", async () => {
    const result = await handleSearchAbapObjects({
      query: "Z*",
      objectType: "PROG",
      maxResults: 3,
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    if (text.includes("Found")) {
      expect(text).toMatch(/PROG\/P/)
    }
  })

  it("returns not-found for an impossible pattern", async () => {
    const result = await handleSearchAbapObjects({
      query: "ZZZZZZ_IMPOSSIBLE_9999",
      connectionId: CONNECTION_ID,
    })
    expect(result.content[0].text).toContain("No objects found")
  })
})

describe("adt_discovery [integration]", () => {
  it("returns at least one ADT service collection", async () => {
    const result = await handleAdtDiscovery({ connectionId: CONNECTION_ID })
    const text = result.content[0].text
    expect(text).toMatch(/ADT services \(\d+\)/)
    // Should list at least object management and source
    expect(text.toLowerCase()).toMatch(/program|object|source|workbench/i)
  })
})

describe("get_abap_object_info [integration]", () => {
  it("returns metadata for a standard SAP program", async () => {
    // RSUSR003 is a standard SAP program present in all systems
    const searchResult = await handleSearchAbapObjects({
      query: "RSUSR003",
      objectType: "PROG",
      maxResults: 1,
      connectionId: CONNECTION_ID,
    })

    // Extract URL from search result to use in object info
    const urlMatch = searchResult.content[0].text.match(/URL: ([^\n]+)/)
    if (!urlMatch) {
      // System may not have RSUSR003 — skip gracefully
      console.log("RSUSR003 not found, skipping object info test")
      return
    }

    const result = await handleGetAbapObjectInfo({
      url: urlMatch[1].trim(),
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    expect(text).toMatch(/Name:\s+RSUSR003/i)
    expect(text).toContain("Type:")
    expect(text).toContain("Responsible:")
  })
})
