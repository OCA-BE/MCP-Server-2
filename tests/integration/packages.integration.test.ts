/**
 * Integration tests — Package browsing tools
 * Read-only. Requires a live SAP connection.
 * Run with: SAP_TEST_CONNECTION=CAR npm run test:integration
 */
import { describe, it, expect, beforeAll } from "vitest"
import { requireConnection, CONNECTION_ID } from "./helpers"
import { handleBrowsePackage } from "../../src/tools/packages"

beforeAll(() => requireConnection())

describe("browse_package [integration]", () => {
  it("browses the $TMP local package", async () => {
    const result = await handleBrowsePackage({
      packageName: "$TMP",
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    // $TMP always exists — should list contents or say empty
    expect(text).toContain("$TMP")
  })

  it("browses a standard SAP package (BASIS root area)", async () => {
    const result = await handleBrowsePackage({
      packageName: "BASIS",
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    expect(text).toBeTruthy()
  })

  it("returns graceful message for non-existent package", async () => {
    const result = await handleBrowsePackage({
      packageName: "ZZZZ_NONEXISTENT_PKG_9999",
      connectionId: CONNECTION_ID,
    })
    // Should not throw
    expect(result.content[0].text).toBeTruthy()
  })
})
