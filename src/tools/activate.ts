import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ensureConnected, getHeldLock, forgetLock, log, isEditingError, editingConflictHint } from "../connections"
import { ActivationResult, InactiveObjectElement } from "abap-adt-api"

export function formatActivationResult(result: ActivationResult): string {
  const msgLines = (result.messages ?? []).map(m =>
    `  [${m.type}] ${m.objDescr ? m.objDescr + " " : ""}${m.line ? `line ${m.line}: ` : ""}${m.shortText}`
  )

  if (result.success) {
    return `✅ Activation successful${msgLines.length ? "\nMessages:\n" + msgLines.join("\n") : ""}`
  }

  const stillInactive = (result.inactive ?? [])
    .map(r => r.object?.["adtcore:name"])
    .filter(Boolean)

  return `❌ Activation failed — object(s) remain inactive.\n` +
    (msgLines.length ? `Messages:\n${msgLines.join("\n")}\n` : "") +
    (stillInactive.length ? `Inactive: ${stillInactive.join(", ")}` : "Check the source for syntax errors.")
}

export async function handleAbapActivate(args: {
  url: string
  connectionId?: string
  preaudit?: boolean
}) {
  const client = await ensureConnected(args.connectionId)

  // ADT activation acquires its own internal lock.  If this server currently
  // holds a lock on the same object (e.g. left from write_abap_object_source
  // or set_text_elements), release it first — otherwise ADT sees a conflict
  // and returns "User … is currently editing".
  const heldHandle = getHeldLock(args.connectionId, args.url)
  if (heldHandle) {
    log("INFO", `Auto-releasing lock before activation: ${args.url.split("/").pop()}`)
    try {
      await client.unLock(args.url, heldHandle)
    } catch (unlockErr) {
      // Log but don't abort — the lock may already be gone (idempotent unlock).
      // If it's genuinely still held, the activation call will fail with a clear message below.
      log("WARN", `Auto-unlock failed for ${args.url.split("/").pop()} — proceeding with activation`, unlockErr)
    }
    forgetLock(args.connectionId, args.url)
  }

  const obj = await client.objectStructure(args.url)
  const objectName = obj.metaData["adtcore:name"]
  const objectType = obj.metaData["adtcore:type"]

  let result
  try {
    result = await client.activate(objectName, obj.objectUrl, undefined, args.preaudit ?? false)
  } catch (err) {
    if (isEditingError(err)) {
      throw new Error(editingConflictHint(err, objectName))
    }
    throw err
  }

  // Also surface "currently editing" that comes back as a failed activation result (not thrown)
  if (!result.success) {
    const editMsg = (result.messages ?? []).find(m =>
      isEditingError({ message: m.shortText })
    )
    if (editMsg) {
      throw new Error(editingConflictHint(new Error(editMsg.shortText), objectName))
    }
  }

  return {
    content: [{
      type: "text" as const,
      text: `${formatActivationResult(result)}\nObject: ${objectName} (${objectType})`
    }]
  }
}

export async function handleAbapActivateMultiple(args: {
  urls: string[]
  connectionId?: string
  preaudit?: boolean
}) {
  const client = await ensureConnected(args.connectionId)

  const records = await client.inactiveObjects()
  const wanted = new Set(args.urls)
  const toActivate = records
    .map(r => r.object)
    .filter((o): o is InactiveObjectElement => !!o && wanted.has(o["adtcore:uri"]))

  if (toActivate.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: "None of the requested objects are currently inactive. They may already be active, or the URLs may not match the inactive worklist."
      }]
    }
  }

  const result = await client.activate(toActivate, args.preaudit ?? false)
  const names = toActivate.map(o => o["adtcore:name"]).join(", ")

  return {
    content: [{
      type: "text" as const,
      text: `${formatActivationResult(result)}\nActivated: ${names}`
    }]
  }
}

export function registerActivateTools(server: McpServer): void {
  server.registerTool(
    "abap_activate",
    {
      title: "Activate ABAP Object",
      description: "Activate an ABAP object — compiles it and makes it executable (equivalent to F8/Activate in the ABAP workbench). " +
        "If the object is currently locked by a prior write_abap_object_source or set_text_elements call, " +
        "the lock is released automatically before activation. " +
        "The object must have been written/saved first.",
      inputSchema: {
        url: z.string().describe("ADT URL of the ABAP object to activate (e.g. /sap/bc/adt/programs/programs/Z_MY_PROG)"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
        preaudit: z.boolean().optional().describe("Run pre-activation ATC checks before activating. Default: false")
      }
    },
    handleAbapActivate
  )

  server.registerTool(
    "abap_activate_multiple",
    {
      title: "Activate Multiple ABAP Objects",
      description: "Activate several inactive ABAP objects in one batch operation. " +
        "Only objects that are currently inactive can be activated; the full object metadata is resolved automatically.",
      inputSchema: {
        urls: z.array(z.string()).describe("Array of ADT object URLs to activate"),
        connectionId: z.string().optional().describe("SAP system connection ID"),
        preaudit: z.boolean().optional().describe("Run pre-activation ATC checks. Default: false")
      }
    },
    handleAbapActivateMultiple
  )
}
