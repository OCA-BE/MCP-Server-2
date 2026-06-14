import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { randomUUID } from "crypto"
import { ensureConnected } from "../connections"
import { DebugBreakpoint } from "abap-adt-api"

// Per-connection debug session state
export const debugSessions = new Map<string, {
  terminalId: string
  ideId: string
  user: string
}>()

export async function handleAbapDebugSession(args: {
  action: "listen" | "detach" | "status"
  username?: string
  connectionId?: string
}) {
  const connId = args.connectionId ?? "default"
  const client = await ensureConnected(args.connectionId)

  if (args.action === "status") {
    const session = debugSessions.get(connId)
    return {
      content: [{
        type: "text" as const,
        text: session
          ? `Active debug session:\n  Terminal ID: ${session.terminalId}\n  IDE ID: ${session.ideId}\n  User: ${session.user}`
          : "No active debug session."
      }]
    }
  }

  if (args.action === "detach") {
    const session = debugSessions.get(connId)
    if (!session) return { content: [{ type: "text" as const, text: "No active debug session." }] }
    try {
      await client.debuggerDeleteListener("user", session.terminalId, session.ideId, session.user)
    } catch { /* ignore */ }
    debugSessions.delete(connId)
    return { content: [{ type: "text" as const, text: "🔌 Debug session detached." }] }
  }

  // listen
  const user = args.username ?? client.username
  const terminalId = randomUUID()
  const ideId = randomUUID()

  const conflictResult = await client.debuggerListeners("user", terminalId, ideId, user, true)
  if (conflictResult) {
    return {
      content: [{
        type: "text" as const,
        text: `❌ Debug listener conflict: ${JSON.stringify(conflictResult)}\nAnother debugger may already be attached for this user.`
      }]
    }
  }

  debugSessions.set(connId, { terminalId, ideId, user })

  // Listen for a debuggee (blocks until a breakpoint is hit or timeout)
  const debuggee = await client.debuggerListen("user", terminalId, ideId, user, false)

  if (!debuggee) {
    debugSessions.delete(connId)
    return { content: [{ type: "text" as const, text: "Debug listener ended without hitting a breakpoint." }] }
  }

  return {
    content: [{
      type: "text" as const,
      text: `🐛 Breakpoint hit!\n${JSON.stringify(debuggee, null, 2)}\n\nUse abap_debug_step, abap_debug_variable, abap_debug_stack to inspect the program state.`
    }]
  }
}

export async function handleAbapDebugSetBreakpoint(args: {
  sourceUrl: string
  line: number
  username?: string
  connectionId?: string
}) {
  const connId = args.connectionId ?? "default"
  const client = await ensureConnected(args.connectionId)
  const session = debugSessions.get(connId)
  const terminalId = session?.terminalId ?? randomUUID()
  const ideId = session?.ideId ?? randomUUID()
  const user = args.username ?? client.username

  // A breakpoint is passed as a URI string of the form "<sourceUri>#start=<line>"
  const bpUri = `${args.sourceUrl}#start=${args.line}`
  const results = await client.debuggerSetBreakpoints("user", terminalId, ideId, ideId, [bpUri], user)

  const lines = results.map(r =>
    "id" in r ? `🔴 ${r.id}` : `⚠ error: ${JSON.stringify(r)}`
  )
  return {
    content: [{
      type: "text" as const,
      text: `Breakpoint set at ${args.sourceUrl} line ${args.line}.\n${lines.join("\n")}`
    }]
  }
}

export async function handleAbapDebugDeleteBreakpoint(args: {
  breakpointId: string
  username?: string
  connectionId?: string
}) {
  const connId = args.connectionId ?? "default"
  const client = await ensureConnected(args.connectionId)
  const session = debugSessions.get(connId)
  const terminalId = session?.terminalId ?? randomUUID()
  const ideId = session?.ideId ?? randomUUID()
  const user = args.username ?? client.username

  // Only the breakpoint id is used by the delete endpoint.
  await client.debuggerDeleteBreakpoints({ id: args.breakpointId } as DebugBreakpoint, "user", terminalId, ideId, user)
  return {
    content: [{ type: "text" as const, text: `⚪ Breakpoint deleted: ${args.breakpointId}` }]
  }
}

export async function handleAbapDebugStep(args: {
  stepType: "stepInto" | "stepOver" | "stepReturn" | "stepContinue" | "terminateDebuggee"
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const result = await client.debuggerStep(args.stepType)
  return {
    content: [{
      type: "text" as const,
      text: `Step: ${args.stepType}\n${JSON.stringify(result, null, 2)}`
    }]
  }
}

export async function handleAbapDebugVariable(args: {
  variables: string[]
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const result = await client.debuggerVariables(args.variables)
  const lines = result.map(v =>
    `${v.NAME} (${v.ACTUAL_TYPE_NAME || v.DECLARED_TYPE_NAME}) = ${v.VALUE}`
  )
  return {
    content: [{ type: "text" as const, text: lines.length ? lines.join("\n") : "No variables returned." }]
  }
}

export async function handleAbapDebugStack(args: { connectionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const stack = await client.debuggerStackTrace()
  return {
    content: [{ type: "text" as const, text: JSON.stringify(stack, null, 2) }]
  }
}

export async function handleAbapDebugSetVariable(args: {
  variableName: string
  value: string
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const result = await client.debuggerSetVariableValue(args.variableName, args.value)
  return {
    content: [{
      type: "text" as const,
      text: `Variable ${args.variableName} set to: ${result}`
    }]
  }
}

export function registerDebugTools(server: McpServer): void {
  server.registerTool(
    "abap_debug_session",
    {
      title: "ABAP Debug Session",
      description: "Manage an ABAP debugging session. Use 'listen' to wait for a breakpoint to be hit, 'status' to check state, or 'detach' to end.",
      inputSchema: {
        action: z.enum(["listen", "detach", "status"]).describe("listen: wait for breakpoint hit; detach: end session; status: show current state"),
        username: z.string().optional().describe("SAP username to debug (listen action, default: connected user)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAbapDebugSession
  )

  server.registerTool(
    "abap_debug_set_breakpoint",
    {
      title: "Set ABAP Breakpoint",
      description: "Set a breakpoint in an ABAP program at a specific line. Returns the breakpoint id(s), which can be passed to abap_debug_delete_breakpoint.",
      inputSchema: {
        sourceUrl: z.string().describe("ADT source URL of the object (e.g. /sap/bc/adt/programs/programs/Z_MY_PROG/source/main)"),
        line: z.number().describe("Line number for the breakpoint"),
        username: z.string().optional().describe("SAP username (defaults to connected user)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAbapDebugSetBreakpoint
  )

  server.registerTool(
    "abap_debug_delete_breakpoint",
    {
      title: "Delete ABAP Breakpoint",
      description: "Delete a breakpoint by its id (returned from abap_debug_set_breakpoint)",
      inputSchema: {
        breakpointId: z.string().describe("Breakpoint id returned by abap_debug_set_breakpoint"),
        username: z.string().optional().describe("SAP username (defaults to connected user)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAbapDebugDeleteBreakpoint
  )

  server.registerTool(
    "abap_debug_step",
    {
      title: "ABAP Debug Step",
      description: "Step through ABAP code in an active debug session",
      inputSchema: {
        stepType: z.enum(["stepInto", "stepOver", "stepReturn", "stepContinue", "terminateDebuggee"])
          .describe("Step type: stepInto (F5), stepOver (F6), stepReturn (F7), stepContinue (F8), terminateDebuggee"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAbapDebugStep
  )

  server.registerTool(
    "abap_debug_variable",
    {
      title: "ABAP Debug Variable",
      description: "Inspect variable values in an active ABAP debug session",
      inputSchema: {
        variables: z.array(z.string()).describe("Variable names to inspect (e.g. ['LV_COUNT', 'WA_MARA', 'IT_TABLE'])"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAbapDebugVariable
  )

  server.registerTool(
    "abap_debug_stack",
    {
      title: "ABAP Debug Stack",
      description: "Get the current call stack in an active ABAP debug session",
      inputSchema: {
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAbapDebugStack
  )

  server.registerTool(
    "abap_debug_set_variable",
    {
      title: "ABAP Debug Set Variable",
      description: "Change the value of a variable in an active ABAP debug session",
      inputSchema: {
        variableName: z.string().describe("Variable name to change"),
        value: z.string().describe("New value to set"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleAbapDebugSetVariable
  )
}
