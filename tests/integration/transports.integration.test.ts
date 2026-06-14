/**
 * Integration tests — Transport tools
 * Read-only (list and details only — create/release excluded).
 * Requires a live SAP connection.
 * Run with: SAP_TEST_CONNECTION=CAR npm run test:integration
 */
import { describe, it, expect, beforeAll } from "vitest"
import { requireConnection, CONNECTION_ID } from "./helpers"
import { handleManageTransportRequests, handleGetTransportForObject, handleListAllTransports } from "../../src/tools/transports"
import { handleSearchAbapObjects } from "../../src/tools/discovery"

beforeAll(() => requireConnection())

describe("manage_transport_requests list [integration]", () => {
  it("returns transport list or a clear no-transports message", async () => {
    const result = await handleManageTransportRequests({ action: "list", connectionId: CONNECTION_ID })
    const text = result.content[0].text
    expect(text).toMatch(/Open transports \(\d+\)|No open transports/)
  })

  it("accepts a specific username", async () => {
    const result = await handleManageTransportRequests({
      action: "list",
      username: "BASIS",
      connectionId: CONNECTION_ID,
    })
    expect(result.content[0].text).toBeTruthy()
  })
})

describe("list_all_transports [integration]", () => {
  it("returns transports for all users or empty message", async () => {
    const result = await handleListAllTransports({
      status: "modifiable",
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    expect(text).toBeTruthy()
    // Either lists transports with owner/status info or reports none
    expect(text).toMatch(/transport|No open transports/i)
  })

  it("accepts released status filter", async () => {
    const result = await handleListAllTransports({
      status: "released",
      connectionId: CONNECTION_ID,
    })
    expect(result.content[0].text).toBeTruthy()
  })

  it("accepts all status filter", async () => {
    const result = await handleListAllTransports({
      status: "all",
      connectionId: CONNECTION_ID,
    })
    expect(result.content[0].text).toBeTruthy()
  })
})

describe("get_transport_for_object [integration]", () => {
  it("returns transport info for a real object", async () => {
    const searchResult = await handleSearchAbapObjects({
      query: "Z*",
      objectType: "PROG",
      maxResults: 1,
      connectionId: CONNECTION_ID,
    })

    const urlMatch = searchResult.content[0].text.match(/URL: ([^\n]+)/)
    if (!urlMatch) { console.log("No Z* programs found, skipping"); return }

    const result = await handleGetTransportForObject({
      url: urlMatch[1].trim(),
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    // Should always include PGMID and Object fields
    expect(text).toContain("PGMID:")
    expect(text).toContain("Object:")
    expect(text).toContain("DevClass:")
  })
})
