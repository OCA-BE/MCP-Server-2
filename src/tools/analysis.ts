import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected } from "../connections"

export async function handleWhereUsed(args: {
  url: string
  line?: number
  column?: number
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const refs = await client.usageReferences(args.url, args.line, args.column)

  if (!refs || refs.length === 0) {
    return { content: [{ type: "text" as const, text: `No usages found for: ${args.url}` }] }
  }

  try {
    const groups = await client.usageReferenceSnippets(refs)
    const lines: string[] = []
    for (const group of groups) {
      for (const snip of group.snippets) {
        const line = snip.uri.start?.line ?? 0
        lines.push(`${snip.uri.uri}:${line}\n  ${snip.content.trim()}`)
      }
    }
    if (lines.length > 0) {
      return {
        content: [{
          type: "text" as const,
          text: `Found ${lines.length} usage location(s):\n\n${lines.join("\n\n")}`
        }]
      }
    }
  } catch {
    // Fall through to the plain reference list below.
  }

  const refLines = refs.map(r =>
    `${r["adtcore:name"]}${r["adtcore:type"] ? ` (${r["adtcore:type"]})` : ""} — ${r.uri}`
  )
  return {
    content: [{
      type: "text" as const,
      text: `Found ${refs.length} usage reference(s):\n${refLines.join("\n")}`
    }]
  }
}

export async function handleVersionHistory(args: { url: string; connectionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const revisions = await client.revisions(args.url)

  if (!revisions || revisions.length === 0) {
    return { content: [{ type: "text" as const, text: `No version history found for: ${args.url}` }] }
  }

  const lines = revisions.map(r =>
    `${r.version} | ${r.date} | ${r.author.padEnd(12)} | ${r.versionTitle ?? ""}`
  )

  return {
    content: [{
      type: "text" as const,
      text: `Version history (${revisions.length} revision(s)):\n${lines.join("\n")}`
    }]
  }
}

export async function handleAnalyzeDump(args: { query?: string; connectionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const feed = await client.dumps(args.query)
  const dumps = feed.dumps ?? []

  if (dumps.length === 0) {
    return { content: [{ type: "text" as const, text: "No runtime dumps found." }] }
  }

  const lines = dumps.map(d => {
    const category = d.categories?.[0]?.term ?? d.type
    return `• [${category}] ${d.text}\n    id: ${d.id}${d.author ? ` | user: ${d.author}` : ""}`
  })
  return {
    content: [{
      type: "text" as const,
      text: `Runtime dumps (${dumps.length}):\n\n${lines.join("\n")}`
    }]
  }
}

export async function handleCheckInactiveObjects(args: { connectionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const records = await client.inactiveObjects()

  if (!records || records.length === 0) {
    return { content: [{ type: "text" as const, text: "No inactive objects found." }] }
  }

  const lines = records
    .map(r => r.object)
    .filter((o): o is NonNullable<typeof o> => !!o)
    .map(o => `${o["adtcore:type"].padEnd(12)} ${o["adtcore:name"]}\n  ${o["adtcore:uri"]}`)

  if (lines.length === 0) {
    return { content: [{ type: "text" as const, text: "No inactive objects found." }] }
  }

  return {
    content: [{
      type: "text" as const,
      text: `${lines.length} inactive object(s):\n${lines.join("\n")}`
    }]
  }
}

export function registerAnalysisTools(server: McpServer): void {
  server.registerTool(
    "where_used",
    {
      title: "Where Used",
      description: "Find all places where an ABAP object or symbol is used (cross-reference analysis). Returns source locations with line numbers.",
      inputSchema: {
        url: z.string().describe("ADT URL of the object to find usages of"),
        line: z.number().optional().describe("Line number for symbol-level where-used"),
        column: z.number().optional().describe("Column number for symbol-level where-used"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleWhereUsed
  )

  server.registerTool(
    "version_history",
    {
      title: "Version History",
      description: "Get the version history of an ABAP object — all previous versions with timestamps and authors",
      inputSchema: {
        url: z.string().describe("ADT URL of the object"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleVersionHistory
  )

  server.registerTool(
    "analyze_dump",
    {
      title: "Analyze Runtime Dump",
      description: "List ABAP runtime dumps (ST22 short dumps) from the SAP system",
      inputSchema: {
        query: z.string().optional().describe("Optional search filter"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAnalyzeDump
  )

  server.registerTool(
    "check_inactive_objects",
    {
      title: "Check Inactive Objects",
      description: "List all currently inactive (not yet activated) ABAP objects in the system",
      inputSchema: {
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleCheckInactiveObjects
  )
}
