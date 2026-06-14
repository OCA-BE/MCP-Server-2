import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  UnitTestAlert,
  UnitTestAlertKind,
  UnitTestMethod,
  UnitTestSeverity
} from "abap-adt-api"
import { ensureConnected } from "../connections"

export async function handleRunAtcAnalysis(args: {
  url: string
  variant?: string
  maxResults?: number
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)

  // Step 1: trigger the run, get run ID
  const runResult = await client.createAtcRun(
    args.variant ?? "DEFAULT",
    args.url,
    args.maxResults ?? 100
  )

  // Step 2: fetch the worklist for this run
  const worklist = await client.atcWorklists(runResult.id)

  if (!worklist.objects || worklist.objects.length === 0) {
    return { content: [{ type: "text" as const, text: "✅ No ATC findings — object passed all checks." }] }
  }

  const findings: string[] = []
  for (const obj of worklist.objects) {
    for (const f of obj.findings) {
      const line = f.location?.range?.start?.line ?? 0
      findings.push(`[P${f.priority}] ${f.checkTitle} (${f.checkId})\n  ${f.messageTitle}\n  ${obj.name} line ${line}`)
    }
  }

  return {
    content: [{
      type: "text" as const,
      text: `ATC Analysis — ${findings.length} finding(s):\n\n${findings.join("\n\n")}`
    }]
  }
}

// Warnings (e.g. tolerable/tolerant) don't fail a method; assertions, exceptions
// and critical/fatal alerts do.
function isFailureAlert(a: UnitTestAlert): boolean {
  return (
    a.kind === UnitTestAlertKind.exception ||
    a.kind === UnitTestAlertKind.failedAssertion ||
    a.severity === UnitTestSeverity.critical ||
    a.severity === UnitTestSeverity.fatal
  )
}

function formatAlerts(alerts: UnitTestAlert[]): string {
  return alerts
    .map(a => `\n    ⚠ [${a.severity}/${a.kind}] ${a.title}${a.details?.length ? "\n      " + a.details.join("\n      ") : ""}`)
    .join("")
}

export async function handleRunUnitTests(args: { url: string; connectionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const classes = await client.unitTestRun(args.url)

  if (!classes || classes.length === 0) {
    return { content: [{ type: "text" as const, text: "No unit test classes found in this object." }] }
  }

  const lines: string[] = []
  let totalPassed = 0
  let totalFailed = 0
  let totalUnknown = 0

  for (const cls of classes) {
    const clsName = cls["adtcore:name"]

    // Class-level alerts (setup / class-constructor failures) apply to the whole class
    const classAlerts = cls.alerts ?? []
    if (classAlerts.length > 0) {
      const failed = classAlerts.some(isFailureAlert)
      if (failed) totalFailed++
      lines.push(`  ${failed ? "❌" : "⚠"} ${clsName} (class-level)${formatAlerts(classAlerts)}`)
    }

    // Derive pass/fail from the run result itself: its testmethods already carry
    // alerts.  unitTestEvaluation returns empty alerts on some systems (seen on
    // S/4HANA 2025), which made failing methods look green — only use it as a
    // fallback when the run result has no method details at all.
    let methods: UnitTestMethod[] = cls.testmethods ?? []
    if (methods.length === 0) {
      try {
        methods = await client.unitTestEvaluation(cls)
      } catch {
        methods = []
      }
    }

    if (methods.length === 0) {
      if (classAlerts.length === 0) {
        totalUnknown++
        lines.push(`  ❓ ${clsName} — no method results from run or evaluation; result UNKNOWN (not passed)`)
      }
      continue
    }

    for (const m of methods) {
      const alerts = m.alerts ?? []
      const failed = alerts.some(isFailureAlert)
      if (failed) totalFailed++
      else totalPassed++

      lines.push(`  ${failed ? "❌" : "✅"} ${clsName}=>${m["adtcore:name"]}${formatAlerts(alerts)}`)
    }
  }

  const summary =
    `Unit test results: ${totalPassed} passed, ${totalFailed} failed` +
    (totalUnknown > 0 ? `, ${totalUnknown} unknown (no alert data returned)` : "")

  return {
    content: [{
      type: "text" as const,
      text: `${summary}\n\n${lines.join("\n")}`
    }]
  }
}

export async function handleCreateTestInclude(args: {
  classUrl: string
  transport?: string
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)

  // The lock is correctly taken on the class object URL — a class test include
  // shares the class's enqueue (it is part of the class object), so the class
  // lock covers it.  But client.createTestInclude expects the class NAME, not the
  // URL: it builds /sap/bc/adt/oo/classes/<clas>/includes, so passing the full URL
  // would be URL-encoded into the path and fail.  Derive the name from the URL.
  const className = decodeURIComponent(args.classUrl.split("/").pop() ?? "")
  const lockResult = await client.lock(args.classUrl)
  const lockHandle = lockResult.LOCK_HANDLE

  try {
    await client.createTestInclude(className, lockHandle, args.transport)
    await client.unLock(args.classUrl, lockHandle)
    return {
      content: [{
        type: "text" as const,
        text: `✅ Test include created for ${className}\nYou can now add local test classes to this include.`
      }]
    }
  } catch (err) {
    try { await client.unLock(args.classUrl, lockHandle) } catch { /* ignore */ }
    throw err
  }
}

export function registerQualityTools(server: McpServer): void {
  server.registerTool(
    "run_atc_analysis",
    {
      title: "Run ATC Analysis",
      description: "Run ABAP Test Cockpit (ATC) quality checks on an ABAP object. Returns findings with priority, check name, message, and location.",
      inputSchema: {
        url: z.string().describe("ADT URL of the object to analyze"),
        variant: z.string().optional().describe("ATC check variant name (default: DEFAULT)"),
        maxResults: z.number().optional().describe("Maximum findings (default: 100)"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleRunAtcAnalysis
  )

  server.registerTool(
    "run_unit_tests",
    {
      title: "Run ABAP Unit Tests",
      description: "Execute ABAP unit tests for an object and return test results with pass/fail status and error details",
      inputSchema: {
        url: z.string().describe("ADT URL of the object containing unit tests"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleRunUnitTests
  )

  server.registerTool(
    "create_test_include",
    {
      title: "Create Test Include",
      description: "Create a unit test include (local test class) for an ABAP class. The class must be locked first.",
      inputSchema: {
        classUrl: z.string().describe("ADT URL of the class to add a test include to"),
        transport: z.string().optional().describe("Transport request number"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleCreateTestInclude
  )
}
