import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  handleConnectedSystems,
  handleSearchAbapObjects,
  handleGetAbapObjectInfo,
  handleAdtDiscovery,
  handleForceRelogin,
} from "../src/tools/discovery"

vi.mock("../src/connections", () => ({
  listConnections: vi.fn(),
  ensureConnected: vi.fn(),
  forceReconnect: vi.fn(),
  resolveConnectionId: vi.fn((id?: string) => id ?? "CAR"),
}))

import { listConnections, ensureConnected, forceReconnect } from "../src/connections"

const mockClient = {
  searchObject: vi.fn(),
  objectStructure: vi.fn(),
  adtDiscovery: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureConnected).mockResolvedValue(mockClient as any)
})

// ─── connected_systems ────────────────────────────────────────────────────────

describe("connected_systems", () => {
  it("lists configured connections", async () => {
    vi.mocked(listConnections).mockReturnValue([
      { id: "CAR", url: "http://sapcar:8001", username: "BASIS", password: "x", client: "600" }
    ])
    const result = await handleConnectedSystems()
    expect(result.content[0].text).toContain("CAR")
    expect(result.content[0].text).toContain("http://sapcar:8001")
    expect(result.content[0].text).toContain("BASIS")
  })

  it("shows default when client is not set", async () => {
    vi.mocked(listConnections).mockReturnValue([
      { id: "DEV", url: "http://dev:8001", username: "USER", password: "x" }
    ])
    const result = await handleConnectedSystems()
    expect(result.content[0].text).toContain("default")
  })

  it("handles empty connection list", async () => {
    vi.mocked(listConnections).mockReturnValue([])
    const result = await handleConnectedSystems()
    expect(result.content[0].text).toContain("Available SAP systems:")
  })
})

// ─── search_abap_objects ──────────────────────────────────────────────────────

describe("search_abap_objects", () => {
  it("returns formatted object list on match", async () => {
    mockClient.searchObject.mockResolvedValue([
      { "adtcore:type": "PROG", "adtcore:name": "ZPROG_TEST", "adtcore:description": "Test prog", "adtcore:uri": "/sap/bc/adt/programs/ZPROG_TEST" }
    ])
    const result = await handleSearchAbapObjects({ query: "ZPROG*" })
    expect(result.content[0].text).toContain("ZPROG_TEST")
    expect(result.content[0].text).toContain("PROG")
    expect(result.content[0].text).toContain("Test prog")
    expect(mockClient.searchObject).toHaveBeenCalledWith("ZPROG*", undefined, 50)
  })

  it("passes objectType and maxResults to the client", async () => {
    mockClient.searchObject.mockResolvedValue([])
    await handleSearchAbapObjects({ query: "Z*", objectType: "CLAS", maxResults: 10 })
    expect(mockClient.searchObject).toHaveBeenCalledWith("Z*", "CLAS", 10)
  })

  it("returns not-found message when results are empty", async () => {
    mockClient.searchObject.mockResolvedValue([])
    const result = await handleSearchAbapObjects({ query: "ZNOTHING" })
    expect(result.content[0].text).toContain('No objects found matching "ZNOTHING"')
  })

  it("returns not-found message when result is null", async () => {
    mockClient.searchObject.mockResolvedValue(null)
    const result = await handleSearchAbapObjects({ query: "ZNOTHING" })
    expect(result.content[0].text).toContain("No objects found")
  })
})

// ─── get_abap_object_info ─────────────────────────────────────────────────────

describe("get_abap_object_info", () => {
  it("returns structured metadata", async () => {
    mockClient.objectStructure.mockResolvedValue({
      objectUrl: "/sap/bc/adt/programs/ZPROG",
      metaData: {
        "adtcore:name": "ZPROG",
        "adtcore:type": "PROG/P",
        "adtcore:description": "My program",
        "adtcore:responsible": "BASIS",
        "adtcore:language": "EN",
        "adtcore:version": "active",
      }
    })
    const result = await handleGetAbapObjectInfo({ url: "/sap/bc/adt/programs/ZPROG" })
    const text = result.content[0].text
    expect(text).toContain("ZPROG")
    expect(text).toContain("PROG/P")
    expect(text).toContain("My program")
    expect(text).toContain("BASIS")
  })

  it("includes class includes when present", async () => {
    mockClient.objectStructure.mockResolvedValue({
      objectUrl: "/sap/bc/adt/oo/classes/ZCL_TEST",
      metaData: { "adtcore:name": "ZCL_TEST", "adtcore:type": "CLAS/OB" },
      includes: [
        { "adtcore:name": "ZCL_TEST=======CCDEF", "adtcore:type": "CLAS/I", "class:includeType": "definitions" }
      ]
    })
    const result = await handleGetAbapObjectInfo({ url: "/sap/bc/adt/oo/classes/ZCL_TEST" })
    expect(result.content[0].text).toContain("Includes (1)")
    expect(result.content[0].text).toContain("ZCL_TEST=======CCDEF")
  })
})

// ─── adt_discovery ────────────────────────────────────────────────────────────

describe("adt_discovery", () => {
  it("lists service collections", async () => {
    mockClient.adtDiscovery.mockResolvedValue([
      { title: "Object management", collection: [{ title: "Programs", href: "/sap/bc/adt/programs" }] },
      { title: "Transports", collection: [] }
    ])
    const result = await handleAdtDiscovery({})
    const text = result.content[0].text
    expect(text).toContain("Object management")
    expect(text).toContain("Programs")
    expect(text).toContain("Transports")
    expect(text).toContain("ADT services (2)")
  })

  it("handles empty discovery", async () => {
    mockClient.adtDiscovery.mockResolvedValue([])
    const result = await handleAdtDiscovery({})
    expect(result.content[0].text).toContain("ADT services (0)")
  })
})

// ─── force_relogin ────────────────────────────────────────────────────────────

describe("force_relogin", () => {
  it("forces a reconnect on the requested connection", async () => {
    vi.mocked(forceReconnect).mockResolvedValue(mockClient as any)
    const result = await handleForceRelogin({ connectionId: "DEV" })
    expect(forceReconnect).toHaveBeenCalledWith("DEV")
    expect(result.content[0].text).toContain("Re-login complete for DEV")
  })

  it("defaults to the first connection when none is given", async () => {
    vi.mocked(forceReconnect).mockResolvedValue(mockClient as any)
    const result = await handleForceRelogin({})
    expect(forceReconnect).toHaveBeenCalledWith(undefined)
    expect(result.content[0].text).toContain("Re-login complete for CAR")
  })

  it("propagates reconnect failures", async () => {
    vi.mocked(forceReconnect).mockRejectedValue(new Error("login failed"))
    await expect(handleForceRelogin({})).rejects.toThrow("login failed")
  })
})
