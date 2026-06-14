/**
 * Integration tests — Customizing tools (Phase 0, read-only)
 * Requires a live SAP connection.
 * Run with: SAP_TEST_CONNECTION=CAR npm run test:integration
 *
 * Uses only tables present on every ABAP system (IMG metadata, DD*).
 */
import { describe, it, expect, beforeAll } from "vitest"
import { requireConnection, CONNECTION_ID } from "./helpers"
import {
  handleImgSearch,
  handleCustomizingDescribe,
  handleCustomizingRead,
  handleCustomizingDiff,
  handleCustomizingPlanChange,
} from "../../src/tools/customizing"

beforeAll(() => requireConnection())

describe("img_search [integration]", () => {
  it("finds IMG activities matching 'company code'", async () => {
    const result = await handleImgSearch({ keyword: "company code", connectionId: CONNECTION_ID })
    const text = result.content[0].text
    // Either finds results or gracefully says none found / not accessible
    expect(text).toBeTruthy()
    // Should not throw or return empty
    expect(text.length).toBeGreaterThan(10)
  })

  it("returns no-results message for impossible keyword", async () => {
    const result = await handleImgSearch({ keyword: "ZZZZ_IMPOSSIBLE_IMG_9999", connectionId: CONNECTION_ID })
    expect(result.content[0].text).toMatch(/No IMG (activities found|nodes matching)|not accessible/i)
  })
})

describe("customizing_describe [integration]", () => {
  it("describes T000 — exists on every system", async () => {
    const result = await handleCustomizingDescribe({ objectName: "T000", connectionId: CONNECTION_ID })
    const text = result.content[0].text
    expect(text).toContain("T000")
    expect(text).toContain("MANDT")
  })

  it("describes T001 (company codes) — present on ERP backends", async () => {
    const result = await handleCustomizingDescribe({ objectName: "T001", connectionId: CONNECTION_ID })
    const text = result.content[0].text
    expect(text).toContain("T001")
    // Full describe on an ERP backend shows fields/delivery class; on a non-ERP
    // backend (e.g. CAR, no FI) the tool still resolves the base table/transport.
    expect(text).toMatch(/BUKRS|Key fields|Delivery class|Base table|Transport object/i)
  })
})

describe("customizing_read [integration]", () => {
  it("reads T000 without a filter", async () => {
    const result = await handleCustomizingRead({ objectName: "T000", maxRows: 5, connectionId: CONNECTION_ID })
    const text = result.content[0].text
    expect(text).toContain("T000")
    expect(text).toMatch(/MANDT|\d+ row\(s\)/)
  })

  it("reads T001 (gracefully handles non-ERP backends without FI)", async () => {
    // T001 (company codes) only exists where FI is installed. On an ERP backend
    // it returns rows; on a non-ERP backend (e.g. CAR) the tool cleanly reports
    // the table isn't there. Both are acceptable — it must not crash unexpectedly.
    try {
      const all = await handleCustomizingRead({ objectName: "T001", maxRows: 1, connectionId: CONNECTION_ID })
      expect(all.content[0].text).toBeTruthy()
    } catch (e) {
      expect(String(e)).toMatch(/cannot find|not found|T001/i)
    }
  })
})

describe("customizing_diff [integration]", () => {
  it("diffs T000 between two client numbers (graceful when one doesn't exist)", async () => {
    const result = await handleCustomizingDiff({
      objectName: "T000",
      keyField: "MANDT",
      sourceKey: "600",
      targetKey: "999",
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    expect(text).toContain("T000")
    // Either identical, missing rows, or empty target — all valid
    expect(text).toMatch(/identical|SOURCE|TARGET|row\(s\)/i)
  })
})

describe("customizing_plan_change [integration]", () => {
  it("generates a dry-run plan for T000 client copy", async () => {
    const result = await handleCustomizingPlanChange({
      objectName: "T000",
      keyField: "MANDT",
      sourceKey: "600",
      targetKey: "999",
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    expect(text).toContain("DRY RUN")
    expect(text).toContain("T000")
    // Must always include the write-safety disclaimer
    expect(text).toMatch(/DRY RUN|nothing (is )?written/i)
  })
})
