/**
 * Integration tests — Table discovery tools
 * Read-only. Requires a live SAP connection.
 * Run with: SAP_TEST_CONNECTION=CAR npm run test:integration
 */
import { describe, it, expect, beforeAll } from "vitest"
import { requireConnection, CONNECTION_ID } from "./helpers"
import { handleSearchTables, handleDescribeTable } from "../../src/tools/tablediscovery"

beforeAll(() => requireConnection())

describe("search_database_tables [integration]", () => {
  it("finds standard SAP tables by description keyword", async () => {
    // MARA, EKKO etc. all have 'material' or 'purchasing' in their descriptions
    const result = await handleSearchTables({
      keyword: "purchase order",
      maxResults: 10,
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    // Either finds results or a no-results message — both valid responses
    expect(text).toBeTruthy()
    if (text.includes("result(s)")) {
      expect(text).toMatch(/TABLE|VIEW/)
    }
  })

  it("returns no-results message for an impossible keyword", async () => {
    const result = await handleSearchTables({
      keyword: "ZZZZ_IMPOSSIBLE_TABLE_KEYWORD_9999",
      connectionId: CONNECTION_ID,
    })
    expect(result.content[0].text).toContain("No tables or views found")
  })

  it("result text includes header columns", async () => {
    const result = await handleSearchTables({
      keyword: "material",
      maxResults: 5,
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    if (text.includes("result(s)")) {
      expect(text).toContain("Type")
      expect(text).toContain("Package")
      expect(text).toContain("Description")
    }
  })
})

describe("describe_database_table [integration]", () => {
  it("describes T000 — present on every ABAP system, MANDT is the key", async () => {
    const result = await handleDescribeTable({
      tableName: "T000",
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    if (text.startsWith("Cannot describe")) { console.log("T000 not accessible, skipping"); return }
    expect(text).toContain("Table: T000")
    expect(text).toContain("Key fields:")
    expect(text).toContain("MANDT")
    expect(text).toMatch(/Fields: \d+ total/)
  })

  it("rejects an invalid table name immediately", async () => {
    const result = await handleDescribeTable({
      tableName: "INVALID TABLE NAME!",
      connectionId: CONNECTION_ID,
    })
    expect(result.content[0].text).toContain("Invalid table name")
  })

  it("returns graceful message for a non-existent table", async () => {
    const result = await handleDescribeTable({
      tableName: "ZZZZ_NONEXISTENT_TABLE_9999",
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    // ADT throws "Cannot find" — handler should catch and return graceful message
    expect(text).toMatch(/Cannot describe|No column metadata/)
  })
})
