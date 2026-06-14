import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { TransportRequest, TransportTask, TransportObject } from "abap-adt-api"
import { ensureConnected } from "../connections"

export function formatRequest(r: TransportRequest): string {
  return `${r["tm:number"]} | ${r["tm:status"]} | ${r["tm:owner"].padEnd(12)} | ${r["tm:desc"]}`
}

function formatObject(o: TransportObject): string {
  return `    ${o["tm:pgmid"].padEnd(6)} ${o["tm:type"].padEnd(8)} ${o["tm:name"].padEnd(40)} ${o["tm:obj_info"] ?? ""}`.trimEnd()
}

function formatTaskBlock(task: TransportTask, indent = "  "): string {
  const header = `${indent}Task ${task["tm:number"]} | ${task["tm:owner"].padEnd(12)} | ${task["tm:desc"]}`
  if (task.objects.length === 0) return header + "\n" + indent + "  (no objects)"
  const objLines = task.objects.map(o => indent + "  " + formatObject(o).trimStart())
  return [header, ...objLines].join("\n")
}

function formatRequestDetail(r: TransportRequest): string {
  const lines: string[] = [
    `Transport: ${r["tm:number"]}`,
    `Owner:     ${r["tm:owner"]}`,
    `Status:    ${r["tm:status"]}`,
    `Description: ${r["tm:desc"]}`,
  ]

  const allObjects = [
    ...r.objects,
    ...(r.tasks ?? []).flatMap(t => t.objects),
  ]
  lines.push(`\nTotal objects: ${allObjects.length}`)

  if (r.objects.length > 0) {
    lines.push("\nDirect objects:")
    r.objects.forEach(o => lines.push(formatObject(o)))
  }

  if (r.tasks && r.tasks.length > 0) {
    lines.push(`\nTasks (${r.tasks.length}):`)
    r.tasks.forEach(t => lines.push(formatTaskBlock(t)))
  }

  return lines.join("\n")
}

export async function handleManageTransportRequests(args: {
  action: "list" | "create" | "details" | "release" | "delete" | "change_owner"
  username?: string
  newOwner?: string
  transportNumber?: string
  objectUrl?: string
  description?: string
  packageName?: string
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)

  switch (args.action) {
    case "list": {
      const data = await client.userTransports(args.username ?? client.username)
      const all = [
        ...data.workbench.flatMap(t => t.modifiable),
        ...data.customizing.flatMap(t => t.modifiable),
      ]
      if (all.length === 0) {
        return { content: [{ type: "text" as const, text: `No open transports found.` }] }
      }
      const header = `${"Number".padEnd(12)} | S | Owner        | Description\n${"-".repeat(70)}`
      return {
        content: [{
          type: "text" as const,
          text: `Open transports for ${args.username ?? client.username} (${all.length}):\n${header}\n${all.map(formatRequest).join("\n")}`,
        }]
      }
    }

    case "details": {
      if (!args.transportNumber) return { content: [{ type: "text" as const, text: "transportNumber required" }] }
      const details = await client.transportDetails(args.transportNumber)
      return { content: [{ type: "text" as const, text: formatRequestDetail(details) }] }
    }

    case "create": {
      if (!args.objectUrl || !args.description || !args.packageName) {
        return { content: [{ type: "text" as const, text: "objectUrl, description, and packageName are required for create" }] }
      }
      const num = await client.createTransport(args.objectUrl, args.description, args.packageName)
      return {
        content: [{
          type: "text" as const,
          text: `✅ Transport created: ${num}\nDescription: ${args.description}\nPackage: ${args.packageName}`,
        }]
      }
    }

    case "release": {
      if (!args.transportNumber) return { content: [{ type: "text" as const, text: "transportNumber required" }] }
      const reports = await client.transportRelease(args.transportNumber)
      const success = reports.every(r => r["chkrun:status"] === "released")
      const messages = reports.flatMap(r => r.messages.map(m => `  ${m["chkrun:type"]}: ${m["chkrun:shortText"]}`))
      return {
        content: [{
          type: "text" as const,
          text: success
            ? `✅ Transport ${args.transportNumber} released.\n${messages.join("\n")}`
            : `❌ Transport release failed.\n${messages.join("\n")}`,
        }]
      }
    }

    case "delete": {
      if (!args.transportNumber) return { content: [{ type: "text" as const, text: "transportNumber required" }] }
      await client.transportDelete(args.transportNumber)
      return { content: [{ type: "text" as const, text: `✅ Transport ${args.transportNumber} deleted.` }] }
    }

    case "change_owner": {
      if (!args.transportNumber || !args.newOwner) {
        return { content: [{ type: "text" as const, text: "transportNumber and newOwner are required for change_owner" }] }
      }
      const resp = await client.transportSetOwner(args.transportNumber, args.newOwner)
      return {
        content: [{
          type: "text" as const,
          text: `✅ Transport ${resp["tm:number"]} owner changed to ${resp["tm:targetuser"]}.`,
        }]
      }
    }
  }
}

export async function handleListAllTransports(args: {
  status?: "modifiable" | "released" | "all"
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const status = args.status ?? "modifiable"

  const users = await client.systemUsers()
  const results = await Promise.allSettled(
    users.map(u => client.userTransports(u.id))
  )

  const sections: string[] = []
  let totalCount = 0

  for (let i = 0; i < users.length; i++) {
    const res = results[i]
    if (res.status === "rejected") continue

    const data = res.value
    const requests: TransportRequest[] = []

    for (const target of [...data.workbench, ...data.customizing]) {
      if (status === "modifiable" || status === "all") requests.push(...target.modifiable)
      if (status === "released" || status === "all") requests.push(...target.released)
    }

    if (requests.length === 0) continue
    totalCount += requests.length

    const lines = requests.map(r => {
      const allObjects = [
        ...r.objects,
        ...(r.tasks ?? []).flatMap(t => t.objects),
      ]
      const objSummary = allObjects.length > 0
        ? `\n` + allObjects.map(o => `    ${o["tm:pgmid"].padEnd(6)} ${o["tm:type"].padEnd(8)} ${o["tm:name"]}`).join("\n")
        : "\n    (no objects)"
      return `  ${r["tm:number"]} | ${r["tm:status"]} | ${r["tm:desc"]}\n  Owner: ${r["tm:owner"]}${objSummary}`
    })

    sections.push(`── ${users[i].id} (${requests.length} transport(s)) ──\n${lines.join("\n\n")}`)
  }

  if (totalCount === 0) {
    return { content: [{ type: "text" as const, text: `No ${status} transports found across ${users.length} users.` }] }
  }

  return {
    content: [{
      type: "text" as const,
      text: `All ${status} transports — ${totalCount} total across ${users.length} users:\n\n` + sections.join("\n\n"),
    }]
  }
}

export async function handleGetTransportForObject(args: {
  url: string
  packageName?: string
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const info = await client.transportInfo(args.url, args.packageName)

  const lines = [
    `PGMID:    ${info.PGMID}`,
    `Object:   ${info.OBJECT} / ${info.OBJECTNAME}`,
    `DevClass: ${info.DEVCLASS}`,
    `Operation:${info.OPERATION}`,
    info.CTEXT ? `Text:     ${info.CTEXT}` : "",
  ].filter(Boolean)

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

export function registerTransportTools(server: McpServer): void {
  server.registerTool(
    "manage_transport_requests",
    {
      title: "Manage Transport Requests",
      description:
        "View, create, and manage SAP transport requests. " +
        "Actions: list (one user's open transports), details (full readable view with all objects), " +
        "create (new transport), release (export transport), delete (remove transport), " +
        "change_owner (reassign transport to another user).",
      inputSchema: {
        action: z.enum(["list", "create", "details", "release", "delete", "change_owner"])
          .describe("Action to perform"),
        username: z.string().optional()
          .describe("Username for list action (defaults to current user)"),
        newOwner: z.string().optional()
          .describe("New owner username for change_owner action"),
        transportNumber: z.string().optional()
          .describe("Transport number for details / release / delete / change_owner (e.g. DEVK123456)"),
        objectUrl: z.string().optional()
          .describe("Object ADT URL (create action — determines target system)"),
        description: z.string().optional()
          .describe("Description for new transport (create action)"),
        packageName: z.string().optional()
          .describe("Package name for new transport (create action)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleManageTransportRequests
  )

  server.registerTool(
    "list_all_transports",
    {
      title: "List All Transports",
      description:
        "List open (or all) transport requests across ALL users in the SAP system. " +
        "Shows each transport's owner, description, status, and every object contained in it. " +
        "Useful for a pre-upgrade audit of what is in flight across the landscape.",
      inputSchema: {
        status: z.enum(["modifiable", "released", "all"]).optional()
          .describe("Which transports to show: modifiable (default, open/unreleased), released, or all"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleListAllTransports
  )

  server.registerTool(
    "get_transport_for_object",
    {
      title: "Get Transport Info for Object",
      description: "Determine which transport request is needed to modify an ABAP object",
      inputSchema: {
        url: z.string().describe("ADT URL of the object"),
        packageName: z.string().optional().describe("Package name of the object"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
      }
    },
    handleGetTransportForObject
  )
}
