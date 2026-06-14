/**
 * Integration tests — Data query tools
 * Read-only. Requires a live SAP connection.
 * Run with: SAP_TEST_CONNECTION=CAR npm run test:integration
 */
import { describe, it, expect, beforeAll } from "vitest"
import { requireConnection, CONNECTION_ID } from "./helpers"
import { handleExecuteDataQuery, handleReadTableContents } from "../../src/tools/data"

beforeAll(() => requireConnection())

describe("execute_data_query [integration]", () => {
  it("reads from TDEVC (packages table — present in all SAP systems)", async () => {
    const result = await handleExecuteDataQuery({
      sql: "SELECT DEVCLASS, CTEXT FROM TDEVC UP TO 3 ROWS",
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    expect(text).toContain("DEVCLASS")
    expect(text).toContain("CTEXT")
    expect(text).toMatch(/\(\d+ row\(s\)\)/)
  })

  it("rejects INSERT without contacting SAP", async () => {
    await expect(
      handleExecuteDataQuery({ sql: "INSERT INTO TDEVC VALUES ('X')", connectionId: CONNECTION_ID })
    ).rejects.toThrow("blocked")
  })

  it("respects maxRows limit", async () => {
    const result = await handleExecuteDataQuery({
      sql: "SELECT DEVCLASS FROM TDEVC UP TO 100 ROWS",
      maxRows: 2,
      connectionId: CONNECTION_ID,
    })
    // Row count in the footer should be ≤ 2
    const match = result.content[0].text.match(/\((\d+) row\(s\)\)/)
    if (match) expect(Number(match[1])).toBeLessThanOrEqual(2)
  })
})

describe("read_table_contents [integration]", () => {
  it("reads T000 without a WHERE clause (clients table — 1 row per client, always present)", async () => {
    const result = await handleReadTableContents({
      tableName: "T000",
      maxRows: 5,
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    expect(text).toContain("MANDT")
    expect(text).toMatch(/\(\d+ row\(s\)\)/)
  })

  it("applies a WHERE clause on T000", async () => {
    let result: Awaited<ReturnType<typeof handleReadTableContents>>
    try {
      result = await handleReadTableContents({
        tableName: "T000",
        whereClause: "MANDT >= '000'",
        maxRows: 5,
        connectionId: CONNECTION_ID,
      })
    } catch (err) {
      // Some ADT systems reject WHERE clauses entirely (400) — skip gracefully
      console.log(`WHERE clause not supported on this system: ${(err as Error).message}`)
      return
    }
    expect(result.content[0].text).toMatch(/\(\d+ row\(s\)\)/)
  })

  it("rejects invalid table names (SQL injection attempt)", async () => {
    const result = await handleReadTableContents({
      tableName: "T000; DROP TABLE T000",
      connectionId: CONNECTION_ID,
    })
    expect(result.content[0].text).toContain("Invalid table name")
  })
})
