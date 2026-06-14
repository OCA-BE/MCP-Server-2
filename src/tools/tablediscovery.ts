import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected } from "../connections"

export async function handleSearchTables(args: {
  keyword: string
  maxResults?: number
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const max = args.maxResults ?? 50

  // Search for transparent tables (TABL) and views (VIEW) matching the keyword
  const [tables, views] = await Promise.all([
    client.searchObject(args.keyword, "TABL", max),
    client.searchObject(args.keyword, "VIEW", max),
  ])

  const all = [
    ...tables.map(r => ({ kind: "TABLE", name: r["adtcore:name"], desc: r["adtcore:description"] ?? "", pkg: r["adtcore:packageName"] ?? "" })),
    ...views.map(r => ({ kind: "VIEW",  name: r["adtcore:name"], desc: r["adtcore:description"] ?? "", pkg: r["adtcore:packageName"] ?? "" })),
  ].sort((a, b) => a.name.localeCompare(b.name))

  if (all.length === 0) {
    return { content: [{ type: "text" as const, text: `No tables or views found matching "${args.keyword}".` }] }
  }

  const rows = all.map(r =>
    `  ${r.kind.padEnd(5)}  ${r.name.padEnd(30)} ${r.pkg.padEnd(20)} ${r.desc}`
  )
  const header = `  ${"Type".padEnd(5)}  ${"Table/View".padEnd(30)} ${"Package".padEnd(20)} Description\n  ${"-".repeat(90)}`

  return {
    content: [{
      type: "text" as const,
      text: `Tables/views matching "${args.keyword}" (${all.length} result(s)):\n\n${header}\n${rows.join("\n")}\n\n` +
        `Use describe_database_table to see the fields of any table above, ` +
        `then read_table_contents or execute_data_query to query it.`,
    }]
  }
}

export async function handleDescribeTable(args: {
  tableName: string
  connectionId?: string
}) {
  if (!/^[A-Z0-9_/]{1,120}$/i.test(args.tableName)) {
    return { content: [{ type: "text" as const, text: `Invalid table name: ${args.tableName}` }] }
  }

  const client = await ensureConnected(args.connectionId)
  // Fetch 0 rows — we only want the column metadata
  let result: Awaited<ReturnType<typeof client.tableContents>>
  try {
    result = await client.tableContents(args.tableName, 0)
  } catch (err) {
    const msg = String((err as { message?: string })?.message ?? err)
    return { content: [{ type: "text" as const, text: `Cannot describe table ${args.tableName}: ${msg}` }] }
  }
  const cols = result.columns

  if (!cols || cols.length === 0) {
    return { content: [{ type: "text" as const, text: `No column metadata returned for ${args.tableName}. Table may not exist or you lack authorization.` }] }
  }

  const keyFields = cols.filter(c => c.keyAttribute)
  const dataFields = cols.filter(c => !c.keyAttribute)

  function fmtCol(c: typeof cols[0]): string {
    const key = c.keyAttribute ? "🔑" : "  "
    const len = c.length > 0 ? `(${c.length})` : ""
    return `  ${key} ${c.name.padEnd(30)} ${c.colType.padEnd(10)} ${len.padEnd(8)} ${c.description}`
  }

  const lines = [
    `Table: ${args.tableName}`,
    `Fields: ${cols.length} total, ${keyFields.length} key field(s)`,
    "",
    `${"Field".padEnd(34)} ${"Type".padEnd(10)} ${"Length".padEnd(8)} Description`,
    "-".repeat(80),
    ...cols.map(fmtCol),
    "",
    `Key fields: ${keyFields.map(c => c.name).join(", ")}`,
    "",
    `Example query:`,
    `  read_table_contents  tableName: ${args.tableName}  maxRows: 10`,
  ]

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

export function registerTableDiscoveryTools(server: McpServer): void {
  server.registerTool(
    "search_database_tables",
    {
      title: "Search Database Tables",
      description:
        "Search for SAP database tables and views by description keyword. " +
        "Works for all installed tables — standard SAP, industry solutions (IS-Retail, IS-Automotive, IS-Mill, etc.), " +
        "and custom Z/Y tables. Use this when you know what data you want but not the technical table name. " +
        "Examples: 'article listing', 'vehicle order', 'warehouse transfer', 'purchase order header'.",
      inputSchema: {
        keyword: z.string().describe("Description keyword to search for (e.g. 'article listing', 'transport request', 'material valuation')"),
        maxResults: z.number().optional().describe("Maximum results per object type (default: 50)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleSearchTables
  )

  server.registerTool(
    "describe_database_table",
    {
      title: "Describe Database Table",
      description:
        "Show all field names, types, lengths, and descriptions for a SAP database table or view. " +
        "Key fields are marked with 🔑. Use this after search_database_tables to understand the structure " +
        "before querying, so you know which fields to filter or select.",
      inputSchema: {
        tableName: z.string().describe("SAP table or view name (e.g. MARA, WLK1, EKKO, Z_MY_TABLE)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleDescribeTable
  )
}
