import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  handleGetAbapObjectLines,
  handleSearchAbapObjectLines,
  handleGetAbapBatchLines,
  handleSyntaxCheck,
} from "../src/tools/source"

vi.mock("../src/connections", () => ({ ensureConnected: vi.fn(), getHeldLock: vi.fn(), trackLock: vi.fn(), forgetLock: vi.fn() }))
import { ensureConnected } from "../src/connections"

const mockClient = {
  getObjectSource: vi.fn(),
  syntaxCheck: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureConnected).mockResolvedValue(mockClient as any)
})

// ─── get_abap_object_lines ────────────────────────────────────────────────────

describe("get_abap_object_lines", () => {
  it("returns source code", async () => {
    mockClient.getObjectSource.mockResolvedValue("REPORT zprog.\nWRITE 'hello'.")
    const result = await handleGetAbapObjectLines({ url: "/sap/bc/adt/programs/ZPROG/source/main" })
    expect(result.content[0].text).toContain("REPORT zprog.")
    expect(result.content[0].text).toContain("WRITE 'hello'.")
  })

  it("handles missing source", async () => {
    mockClient.getObjectSource.mockResolvedValue(null)
    const result = await handleGetAbapObjectLines({ url: "/sap/bc/adt/programs/ZPROG/source/main" })
    expect(result.content[0].text).toContain("No source found at")
  })
})

// ─── search_abap_object_lines ─────────────────────────────────────────────────

describe("search_abap_object_lines", () => {
  const source = "REPORT zprog.\nDATA lv_count TYPE i.\nlv_count = lv_count + 1.\nWRITE lv_count."

  it("returns matching lines with line numbers", async () => {
    mockClient.getObjectSource.mockResolvedValue(source)
    const result = await handleSearchAbapObjectLines({ url: "/url", pattern: "lv_count" })
    const text = result.content[0].text
    expect(text).toContain("Found 3 match(es)")
    expect(text).toContain("2:")
    expect(text).toContain("3:")
    expect(text).toContain("4:")
  })

  it("is case-insensitive", async () => {
    mockClient.getObjectSource.mockResolvedValue("REPORT zprog.\nWRITE 'Hello'.")
    const result = await handleSearchAbapObjectLines({ url: "/url", pattern: "write" })
    expect(result.content[0].text).toContain("Found 1 match(es)")
  })

  it("returns no-match message when nothing found", async () => {
    mockClient.getObjectSource.mockResolvedValue(source)
    const result = await handleSearchAbapObjectLines({ url: "/url", pattern: "NONEXISTENT_XYZ" })
    expect(result.content[0].text).toContain("No matches for")
  })

  it("handles missing source", async () => {
    mockClient.getObjectSource.mockResolvedValue(null)
    const result = await handleSearchAbapObjectLines({ url: "/url", pattern: "anything" })
    expect(result.content[0].text).toContain("No source at")
  })
})

// ─── get_abap_batch_lines ─────────────────────────────────────────────────────

describe("get_abap_batch_lines", () => {
  it("returns source for each URL", async () => {
    mockClient.getObjectSource
      .mockResolvedValueOnce("source A")
      .mockResolvedValueOnce("source B")
    const result = await handleGetAbapBatchLines({ urls: ["/url/A", "/url/B"] })
    const text = result.content[0].text
    expect(text).toContain("=== /url/A ===")
    expect(text).toContain("source A")
    expect(text).toContain("=== /url/B ===")
    expect(text).toContain("source B")
  })

  it("marks failed fetches as errors without failing the whole batch", async () => {
    mockClient.getObjectSource
      .mockResolvedValueOnce("source A")
      .mockRejectedValueOnce(new Error("not found"))
    const result = await handleGetAbapBatchLines({ urls: ["/url/A", "/url/BAD"] })
    const text = result.content[0].text
    expect(text).toContain("source A")
    expect(text).toContain("=== ERROR ===")
  })
})

// ─── syntax_check ─────────────────────────────────────────────────────────────

describe("syntax_check", () => {
  it("returns clean message when no errors", async () => {
    mockClient.syntaxCheck.mockResolvedValue([])
    const result = await handleSyntaxCheck({ url: "/url", mainUrl: "/url", source: "REPORT z." })
    expect(result.content[0].text).toContain("No syntax errors")
  })

  it("returns formatted errors", async () => {
    mockClient.syntaxCheck.mockResolvedValue([
      { line: 5, offset: 3, severity: "E", text: "Syntax error: semicolon expected" }
    ])
    const result = await handleSyntaxCheck({ url: "/url", mainUrl: "/url", source: "bad code" })
    const text = result.content[0].text
    expect(text).toContain("Line 5:3")
    expect(text).toContain("[E]")
    expect(text).toContain("semicolon expected")
    expect(text).toContain("1 message(s)")
  })

  it("handles null result as clean", async () => {
    mockClient.syntaxCheck.mockResolvedValue(null)
    const result = await handleSyntaxCheck({ url: "/url", mainUrl: "/url", source: "REPORT z." })
    expect(result.content[0].text).toContain("No syntax errors")
  })
})
