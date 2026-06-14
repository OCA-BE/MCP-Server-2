import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ADTClient, TextElement, TextElementCategory } from "abap-adt-api"
import { ensureConnected, dropSessionLocks, isInvalidLockError, isEditingError, editingConflictHint, log } from "../connections"

const CATEGORIES = ["selections", "symbols", "headings"] as const

function formatElements(elements: TextElement[], category: TextElementCategory): string {
  if (elements.length === 0) return `No ${category} text elements found.`
  const rows = elements.map(e => {
    const maxLen = e.maxLength ? `  (max ${e.maxLength})` : ""
    const ddic = e.ddicReference ? `  [DDIC: ${e.ddicReference}]` : ""
    return `  ${e.id.padEnd(32)} ${e.text}${maxLen}${ddic}`
  })
  return `${category} (${elements.length}):\n${rows.join("\n")}`
}

export async function handleGetTextElements(args: {
  objectType: string
  objectName: string
  category?: TextElementCategory
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const url = ADTClient.textElementsUrl(args.objectType, args.objectName)

  if (args.category) {
    const result = await client.getTextElements(url, args.category)
    return {
      content: [{
        type: "text" as const,
        text: `Text elements for ${result.programName}:\n\n${formatElements(result.textElements, args.category!)}`
      }]
    }
  }

  const [sel, sym, hdr] = await Promise.all(
    CATEGORIES.map(cat => client.getTextElements(url, cat).catch(() => ({ textElements: [], programName: args.objectName })))
  )

  const programName = sel.programName || sym.programName || hdr.programName || args.objectName
  const sections = [
    formatElements(sel.textElements, "selections"),
    formatElements(sym.textElements, "symbols"),
    formatElements(hdr.textElements, "headings"),
  ]

  return {
    content: [{
      type: "text" as const,
      text: `Text elements for ${programName}:\n\n${sections.join("\n\n")}`
    }]
  }
}

export async function handleSetTextElements(args: {
  objectType: string
  objectName: string
  objectUrl?: string
  category: TextElementCategory
  elements: Array<{ id: string; text: string }>
  transport?: string
  connectionId?: string
}, extra?: { signal?: AbortSignal }) {
  const client = await ensureConnected(args.connectionId)
  const textUrl = ADTClient.textElementsUrl(args.objectType, args.objectName)

  // If the MCP client abandons the call mid-flight (it cancels and stops waiting
  // for our response), the lock we acquired below would otherwise leak server-side
  // until our 30 s HTTP timeout fires — by which time the session may be wedged.
  // Drop the session immediately on cancellation to release any held enqueue while
  // the connection is still healthy.
  if (extra?.signal) {
    extra.signal.addEventListener("abort", () => {
      log("WARN", `set_text_elements on ${args.objectName} cancelled — dropping session to release locks`)
      dropSessionLocks(args.connectionId).catch(() => { /* best-effort */ })
    }, { once: true })
  }

  // Text elements are a SEPARATE enqueue resource (REPT text pool) from the program
  // source (TRDIR).  The lock must be taken on the text-elements URL, not the program
  // object URL — a program-source lock does not cover REPT, so SAP rejects the write
  // with "Resource REPT … is not locked".  The lock lifecycle is fully self-contained
  // here: acquire on textUrl, write, always release (text goes to the inactive buffer,
  // activation does not need the lock held).
  const elements: TextElement[] = args.elements.map(e => ({ id: e.id, text: e.text }))

  const doWrite = async (handle: string) =>
    client.setTextElements(textUrl, args.category, elements, handle, args.transport)

  const lockResource = async (): Promise<string> => {
    try {
      const r = await client.lock(textUrl)
      return r.LOCK_HANDLE
    } catch (lockErr) {
      // lock() may have timed out after SAP took the enqueue — drop session to clean up
      try { await dropSessionLocks(args.connectionId) } catch { /* best-effort */ }
      if (isEditingError(lockErr)) {
        throw new Error(editingConflictHint(lockErr, args.objectName))
      }
      throw lockErr
    }
  }

  const unlockResource = async (handle: string, reason: string) => {
    try {
      await client.unLock(textUrl, handle)
    } catch (e) {
      log("WARN", `Failed to release text-element lock for ${args.objectName} (${reason}) — dropping session`, e)
      try { await dropSessionLocks(args.connectionId) } catch (e2) {
        log("WARN", `Session drop also failed for ${args.objectName}`, e2)
      }
    }
  }

  let lockHandle = await lockResource()
  try {
    await doWrite(lockHandle)
  } catch (err) {
    if (isInvalidLockError(err)) {
      // Stale handle (session re-established) — release it, re-acquire fresh, retry once.
      // Releasing first prevents a self-conflict ("currently editing" against our own lock).
      log("WARN", `Stale text-element lock on ${args.objectName} — releasing, re-acquiring, retrying`)
      await unlockResource(lockHandle, "stale before re-acquire")
      let freshHandle: string | undefined
      try {
        freshHandle = await lockResource()
        await doWrite(freshHandle)
        lockHandle = freshHandle
      } catch (retryErr) {
        if (freshHandle) await unlockResource(freshHandle, "re-acquire retry failure")
        throw retryErr
      }
    } else {
      await unlockResource(lockHandle, "write error")
      if (isEditingError(err)) {
        throw new Error(editingConflictHint(err, args.objectName))
      }
      throw err
    }
  }

  // Success — always release the text-element lock so nothing leaks in SM12.
  await unlockResource(lockHandle, "success")

  const rows = elements.map(e => `  ${e.id.padEnd(32)} ${e.text}`).join("\n")
  return {
    content: [{
      type: "text" as const,
      text: `✅ ${args.category} text elements written for ${args.objectName} (${elements.length} element(s)):\n${rows}\n\nUse abap_activate to compile and activate.`
    }]
  }
}

export function registerTextElementTools(server: McpServer): void {
  server.registerTool(
    "get_text_elements",
    {
      title: "Get Text Elements",
      description:
        "Read text elements for an ABAP program or class: selection screen texts (PARAMETERS / SELECT-OPTIONS labels), " +
        "text symbols (TEXT-001 etc.), and list headings. " +
        "Omit category to retrieve all three at once.",
      inputSchema: {
        objectType: z.string().describe("ADT object type, e.g. PROG/P, CLAS/OC, FUGR/F"),
        objectName: z.string().describe("Object name, e.g. ZCAR_MM_ORDERS"),
        category: z.enum(["selections", "symbols", "headings"]).optional()
          .describe("Which category to read: selections (selection screen), symbols (TEXT-xxx), headings. Omit for all three."),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleGetTextElements
  )

  server.registerTool(
    "set_text_elements",
    {
      title: "Set Text Elements",
      description:
        "Write text elements for an ABAP program or class. " +
        "Covers selection screen texts (PARAMETERS / SELECT-OPTIONS labels), text symbols, and list headings. " +
        "If the object is already locked by a prior write_abap_object_source call, the existing lock is reused automatically. " +
        "The object stays locked after writing — use abap_activate to activate and unlock. " +
        "Use get_text_elements first to see existing ids before writing.",
      inputSchema: {
        objectType: z.string().describe("ADT object type, e.g. PROG/P, CLAS/OC, FUGR/F"),
        objectName: z.string().describe("Object name, e.g. ZCAR_MM_ORDERS"),
        objectUrl: z.string().optional().describe("Deprecated/optional — text elements are locked on their own ADT resource derived from objectType+objectName; this is no longer required"),
        category: z.enum(["selections", "symbols", "headings"])
          .describe("Which category to write: selections (selection screen texts), symbols (TEXT-xxx), headings"),
        elements: z.array(z.object({
          id: z.string().describe("Element id — for selections: the parameter/select-option name; for symbols: the 3-digit number e.g. '001'; for headings: 'S' (short), 'M' (medium), 'L' (long), 'H' (header)"),
          text: z.string().describe("The label text to display")
        })).describe("Text elements to write. Existing elements not listed here are left unchanged."),
        transport: z.string().optional().describe("Transport request number — required for transportable packages"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleSetTextElements
  )
}
