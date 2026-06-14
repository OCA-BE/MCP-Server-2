import { describe, it, expect, vi, beforeEach } from "vitest"
import { handleGetTextElements, handleSetTextElements } from "../src/tools/textelements"

vi.mock("../src/connections", () => ({
  ensureConnected: vi.fn(),
  getHeldLock: vi.fn(),
  trackLock: vi.fn(),
  forgetLock: vi.fn(),
  dropSessionLocks: vi.fn(),
  isInvalidLockError: vi.fn(),
  isEditingError: vi.fn(),
  editingConflictHint: vi.fn((err: unknown) => String((err as Error).message)),
  log: vi.fn(),
}))
import { ensureConnected, getHeldLock, trackLock, forgetLock, isInvalidLockError, isEditingError } from "../src/connections"

// Mock ADTClient.textElementsUrl as a static method
vi.mock("abap-adt-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("abap-adt-api")>()
  return {
    ...actual,
    ADTClient: class {
      static textElementsUrl(_type: string, name: string) {
        return `/sap/bc/adt/programs/programs/${name}/textelements`
      }
      getTextElements = mockClient.getTextElements
      setTextElements = mockClient.setTextElements
      lock = mockClient.lock
      unLock = mockClient.unLock
    }
  }
})

const mockClient = {
  getTextElements: vi.fn(),
  setTextElements: vi.fn(),
  lock: vi.fn(),
  unLock: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureConnected).mockResolvedValue(mockClient as any)
  vi.mocked(getHeldLock).mockReturnValue(undefined)
  vi.mocked(isInvalidLockError).mockReturnValue(false)
  vi.mocked(isEditingError).mockReturnValue(false)
  mockClient.lock.mockResolvedValue({ LOCK_HANDLE: "LH_TEXT_001" })
  mockClient.unLock.mockResolvedValue(undefined)
  mockClient.setTextElements.mockResolvedValue(undefined)
})

// ─── get_text_elements ────────────────────────────────────────────────────────

describe("get_text_elements — single category", () => {
  it("returns formatted selection texts", async () => {
    mockClient.getTextElements.mockResolvedValue({
      programName: "ZCAR_MM_ORDERS",
      textElements: [
        { id: "P_PLANT",   text: "Plant" },
        { id: "P_MATNR",   text: "Material number", maxLength: 18 },
        { id: "S_WERKS",   text: "Plant range" },
      ]
    })
    const result = await handleGetTextElements({
      objectType: "PROG/P", objectName: "ZCAR_MM_ORDERS", category: "selections",
    })
    const text = result.content[0].text
    expect(text).toContain("ZCAR_MM_ORDERS")
    expect(text).toContain("P_PLANT")
    expect(text).toContain("Plant")
    expect(text).toContain("P_MATNR")
    expect(text).toContain("Material number")
    expect(text).toContain("max 18")
    expect(text).toContain("S_WERKS")
    expect(text).toContain("selections (3)")
  })

  it("returns formatted text symbols", async () => {
    mockClient.getTextElements.mockResolvedValue({
      programName: "ZPROG",
      textElements: [{ id: "001", text: "No data found" }, { id: "002", text: "Processing complete" }]
    })
    const result = await handleGetTextElements({ objectType: "PROG/P", objectName: "ZPROG", category: "symbols" })
    expect(result.content[0].text).toContain("001")
    expect(result.content[0].text).toContain("No data found")
    expect(result.content[0].text).toContain("symbols (2)")
  })

  it("returns formatted headings", async () => {
    mockClient.getTextElements.mockResolvedValue({
      programName: "ZPROG",
      textElements: [{ id: "S", text: "Orders" }, { id: "H", text: "Order Report" }]
    })
    const result = await handleGetTextElements({ objectType: "PROG/P", objectName: "ZPROG", category: "headings" })
    expect(result.content[0].text).toContain("headings (2)")
    expect(result.content[0].text).toContain("Order Report")
  })

  it("shows no-elements message when list is empty", async () => {
    mockClient.getTextElements.mockResolvedValue({ programName: "ZPROG", textElements: [] })
    const result = await handleGetTextElements({ objectType: "PROG/P", objectName: "ZPROG", category: "selections" })
    expect(result.content[0].text).toContain("No selections text elements found")
  })

  it("includes DDIC reference when present", async () => {
    mockClient.getTextElements.mockResolvedValue({
      programName: "ZPROG",
      textElements: [{ id: "P_MATNR", text: "Material", ddicReference: "MATNR" }]
    })
    const result = await handleGetTextElements({ objectType: "PROG/P", objectName: "ZPROG", category: "selections" })
    expect(result.content[0].text).toContain("DDIC: MATNR")
  })
})

describe("get_text_elements — all categories", () => {
  it("fetches all three categories and combines output", async () => {
    mockClient.getTextElements
      .mockResolvedValueOnce({ programName: "ZPROG", textElements: [{ id: "P_PLANT", text: "Plant" }] })
      .mockResolvedValueOnce({ programName: "ZPROG", textElements: [{ id: "001", text: "No data" }] })
      .mockResolvedValueOnce({ programName: "ZPROG", textElements: [{ id: "H", text: "Report" }] })
    const result = await handleGetTextElements({ objectType: "PROG/P", objectName: "ZPROG" })
    const text = result.content[0].text
    expect(text).toContain("selections (1)")
    expect(text).toContain("symbols (1)")
    expect(text).toContain("headings (1)")
    expect(mockClient.getTextElements).toHaveBeenCalledTimes(3)
  })

  it("tolerates a category returning an error (treats as empty)", async () => {
    mockClient.getTextElements
      .mockResolvedValueOnce({ programName: "ZPROG", textElements: [{ id: "P_X", text: "X" }] })
      .mockRejectedValueOnce(new Error("404"))
      .mockResolvedValueOnce({ programName: "ZPROG", textElements: [] })
    const result = await handleGetTextElements({ objectType: "PROG/P", objectName: "ZPROG" })
    expect(result.content[0].text).toContain("selections (1)")
    expect(result.content[0].text).toContain("No symbols text elements found")
  })
})

// ─── set_text_elements — no pre-existing lock ─────────────────────────────────

const baseArgs = {
  objectType: "PROG/P",
  objectName: "ZCAR_MM_ORDERS",
  objectUrl: "/sap/bc/adt/programs/programs/ZCAR_MM_ORDERS",
  category: "selections" as const,
  elements: [
    { id: "P_PLANT", text: "Plant" },
    { id: "P_MATNR", text: "Material number" },
  ],
}

// The handler locks the TEXT-ELEMENTS resource (REPT), not the program object URL.
// In the mocked ADTClient, textElementsUrl(type, name) → /sap/bc/adt/programs/programs/<name>/textelements
const TEXT_URL = "/sap/bc/adt/programs/programs/ZCAR_MM_ORDERS/textelements"

describe("set_text_elements — locks the text-elements resource", () => {
  it("locks textUrl (not the program URL), writes, then always releases", async () => {
    const result = await handleSetTextElements(baseArgs)
    // Lock taken on the text-elements resource, never on the program object URL
    expect(mockClient.lock).toHaveBeenCalledWith(TEXT_URL)
    expect(mockClient.lock).not.toHaveBeenCalledWith(baseArgs.objectUrl)
    expect(mockClient.setTextElements).toHaveBeenCalledWith(
      TEXT_URL,
      "selections",
      [{ id: "P_PLANT", text: "Plant" }, { id: "P_MATNR", text: "Material number" }],
      "LH_TEXT_001",
      undefined
    )
    // Lock always released after success (no SM12 leak)
    expect(mockClient.unLock).toHaveBeenCalledWith(TEXT_URL, "LH_TEXT_001")
    const text = result.content[0].text
    expect(text).toContain("✅")
    expect(text).toContain("ZCAR_MM_ORDERS")
    expect(text).toContain("2 element(s)")
    expect(text).toContain("abap_activate")
  })

  it("works without an objectUrl argument (no longer required)", async () => {
    const { objectUrl, ...noUrl } = baseArgs
    const result = await handleSetTextElements(noUrl)
    expect(mockClient.lock).toHaveBeenCalledWith(TEXT_URL)
    expect(result.content[0].text).toContain("✅")
  })

  it("passes transport number through to setTextElements", async () => {
    await handleSetTextElements({ ...baseArgs, transport: "CARX000123" })
    expect(mockClient.setTextElements).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(Array), expect.any(String), "CARX000123"
    )
  })

  it("releases the lock and rethrows when the write fails", async () => {
    mockClient.setTextElements.mockRejectedValue(new Error("validation error"))
    await expect(handleSetTextElements(baseArgs)).rejects.toThrow("validation error")
    expect(mockClient.unLock).toHaveBeenCalledWith(TEXT_URL, "LH_TEXT_001")
  })
})

// ─── set_text_elements — stale handle auto-recovery ──────────────────────────

describe("set_text_elements — stale handle auto-recovery", () => {
  it("releases the stale handle, re-acquires, and retries on invalid-lock error", async () => {
    vi.mocked(isInvalidLockError).mockReturnValue(true)
    mockClient.lock
      .mockResolvedValueOnce({ LOCK_HANDLE: "STALE_HANDLE" })
      .mockResolvedValueOnce({ LOCK_HANDLE: "FRESH_HANDLE" })
    mockClient.setTextElements
      .mockRejectedValueOnce(new Error("Resource is not locked (invalid lock handle)"))
      .mockResolvedValueOnce(undefined)

    const result = await handleSetTextElements(baseArgs)
    expect(mockClient.setTextElements).toHaveBeenCalledTimes(2)
    // Stale handle was released before re-acquiring (prevents self-conflict)
    expect(mockClient.unLock).toHaveBeenCalledWith(TEXT_URL, "STALE_HANDLE")
    // Retried with the fresh handle, then released it on success
    expect(mockClient.setTextElements).toHaveBeenLastCalledWith(
      TEXT_URL, "selections", expect.any(Array), "FRESH_HANDLE", undefined
    )
    expect(mockClient.unLock).toHaveBeenCalledWith(TEXT_URL, "FRESH_HANDLE")
    expect(result.content[0].text).toContain("✅")
  })

  it("releases the fresh lock and rethrows if the retry also fails", async () => {
    vi.mocked(isInvalidLockError).mockReturnValue(true)
    mockClient.lock
      .mockResolvedValueOnce({ LOCK_HANDLE: "STALE_HANDLE" })
      .mockResolvedValueOnce({ LOCK_HANDLE: "FRESH_HANDLE" })
    mockClient.setTextElements.mockRejectedValue(new Error("still broken"))
    await expect(handleSetTextElements(baseArgs)).rejects.toThrow()
    expect(mockClient.unLock).toHaveBeenCalledWith(TEXT_URL, "FRESH_HANDLE")
  })
})

// ─── set_text_elements — other categories ────────────────────────────────────

describe("set_text_elements — other categories", () => {
  it("works for symbols category", async () => {
    const result = await handleSetTextElements({
      ...baseArgs, category: "symbols", elements: [{ id: "001", text: "No data found" }],
    })
    expect(mockClient.setTextElements).toHaveBeenCalledWith(
      expect.any(String), "symbols", expect.any(Array), expect.any(String), undefined
    )
    expect(result.content[0].text).toContain("symbols")
  })

  it("works for headings category", async () => {
    await handleSetTextElements({
      ...baseArgs, category: "headings",
      elements: [{ id: "H", text: "Order Report" }, { id: "S", text: "Orders" }],
    })
    expect(mockClient.setTextElements).toHaveBeenCalledWith(
      expect.any(String), "headings", expect.any(Array), expect.any(String), undefined
    )
  })
})
