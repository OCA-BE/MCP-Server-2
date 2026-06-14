import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  handleWhereUsed,
  handleVersionHistory,
  handleAnalyzeDump,
  handleCheckInactiveObjects,
} from "../src/tools/analysis"

vi.mock("../src/connections", () => ({ ensureConnected: vi.fn(), getHeldLock: vi.fn(), trackLock: vi.fn(), forgetLock: vi.fn() }))
import { ensureConnected } from "../src/connections"

const mockClient = {
  usageReferences: vi.fn(),
  usageReferenceSnippets: vi.fn(),
  revisions: vi.fn(),
  dumps: vi.fn(),
  inactiveObjects: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureConnected).mockResolvedValue(mockClient as any)
})

// ─── where_used ───────────────────────────────────────────────────────────────

describe("where_used", () => {
  it("returns snippet-based locations when available", async () => {
    mockClient.usageReferences.mockResolvedValue([{ "adtcore:name": "ZPROG", uri: "/url" }])
    mockClient.usageReferenceSnippets.mockResolvedValue([{
      snippets: [{
        uri: { uri: "/sap/bc/adt/programs/ZPROG/source/main", start: { line: 42 } },
        content: "  CALL FUNCTION 'Z_GET_DATA'."
      }]
    }])
    const result = await handleWhereUsed({ url: "/url" })
    const text = result.content[0].text
    expect(text).toContain(":42")
    expect(text).toContain("Z_GET_DATA")
    expect(text).toContain("Found 1 usage location(s)")
  })

  it("falls back to reference list when snippets fail", async () => {
    mockClient.usageReferences.mockResolvedValue([
      { "adtcore:name": "ZPROG", "adtcore:type": "PROG", uri: "/sap/bc/adt/programs/ZPROG" }
    ])
    mockClient.usageReferenceSnippets.mockRejectedValue(new Error("not supported"))
    const result = await handleWhereUsed({ url: "/url" })
    expect(result.content[0].text).toContain("ZPROG")
    expect(result.content[0].text).toContain("Found 1 usage reference(s)")
  })

  it("returns not-found when no references", async () => {
    mockClient.usageReferences.mockResolvedValue([])
    const result = await handleWhereUsed({ url: "/url" })
    expect(result.content[0].text).toContain("No usages found")
  })
})

// ─── version_history ──────────────────────────────────────────────────────────

describe("version_history", () => {
  it("returns formatted revision list", async () => {
    mockClient.revisions.mockResolvedValue([
      { version: "000002", date: "2024-01-15", author: "BASIS", versionTitle: "Added filter" },
      { version: "000001", date: "2024-01-10", author: "DEV01", versionTitle: "Initial" }
    ])
    const result = await handleVersionHistory({ url: "/url" })
    const text = result.content[0].text
    expect(text).toContain("000002")
    expect(text).toContain("BASIS")
    expect(text).toContain("Added filter")
    expect(text).toContain("Version history (2 revision(s))")
  })

  it("returns no-history message when empty", async () => {
    mockClient.revisions.mockResolvedValue([])
    const result = await handleVersionHistory({ url: "/url" })
    expect(result.content[0].text).toContain("No version history found")
  })
})

// ─── analyze_dump ─────────────────────────────────────────────────────────────

describe("analyze_dump", () => {
  it("returns formatted dump list", async () => {
    mockClient.dumps.mockResolvedValue({
      dumps: [{
        id: "DUMP001",
        text: "Short dump title",
        type: "ABAP_RUNTIME_ERROR",
        categories: [{ term: "Basis", label: "Basis" }],
        author: "BTCH",
        links: []
      }]
    })
    const result = await handleAnalyzeDump({})
    const text = result.content[0].text
    expect(text).toContain("DUMP001")
    expect(text).toContain("Short dump title")
    expect(text).toContain("[Basis]")
    expect(text).toContain("user: BTCH")
  })

  it("returns no-dumps message when list is empty", async () => {
    mockClient.dumps.mockResolvedValue({ dumps: [] })
    const result = await handleAnalyzeDump({})
    expect(result.content[0].text).toContain("No runtime dumps found")
  })
})

// ─── check_inactive_objects ───────────────────────────────────────────────────

describe("check_inactive_objects", () => {
  it("returns list of inactive objects", async () => {
    mockClient.inactiveObjects.mockResolvedValue([{
      object: {
        "adtcore:type": "PROG/P",
        "adtcore:name": "ZPROG",
        "adtcore:uri": "/sap/bc/adt/programs/ZPROG",
        "adtcore:parentUri": "/sap/bc/adt/packages/ZDEV",
        user: "BASIS",
        deleted: false
      }
    }])
    const result = await handleCheckInactiveObjects({})
    const text = result.content[0].text
    expect(text).toContain("ZPROG")
    expect(text).toContain("PROG/P")
    expect(text).toContain("1 inactive object(s)")
  })

  it("returns clean message when all objects are active", async () => {
    mockClient.inactiveObjects.mockResolvedValue([])
    const result = await handleCheckInactiveObjects({})
    expect(result.content[0].text).toContain("No inactive objects")
  })
})
