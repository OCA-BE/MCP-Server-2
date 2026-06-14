/**
 * Governed transport selection — shared by customizing (CTS function 'W') and
 * workbench (CTS function 'K') writes.
 *
 * Policy (enterprise landscapes pre-provision transports via CALM/SolMan, so we
 * NEVER silently mint one):
 *   1. reuse the request used earlier this session for the same CTS function;
 *   2. else present the valid open requests so the caller can pick one;
 *   3. create a new request ONLY on an explicit opt-in (createTransport).
 *
 * This module holds the session memory + the reuse decision. The candidate
 * *source* differs per side: customizing lists open 'W' requests via SQL (it
 * writes through the engine's ICF path, not an ADT object URL); workbench uses
 * the ADT `transportInfo` of the object (which returns the object-specific valid
 * requests, respecting the transport layer).
 */

export type CtsFunction = "W" | "K"

/** Last request used this session, per CTS function. Workbench ('K') and
 *  customizing ('W') reuse are independent, which is correct. */
const sessionLastTransport = new Map<CtsFunction, string>()

export function rememberTransport(fn: CtsFunction, trkorr: string | undefined): void {
  if (trkorr) sessionLastTransport.set(fn, trkorr)
}

export function recallTransport(fn: CtsFunction): string | undefined {
  return sessionLastTransport.get(fn)
}

export interface TransportCandidate {
  trkorr: string
  text: string
  owner?: string
}

export type GovernResult =
  | { kind: "reuse"; trkorr: string; note: string }
  | { kind: "choose"; candidates: TransportCandidate[] }

/**
 * Reuse this session's last request of this CTS function if it is still a valid
 * candidate; otherwise the caller should let the user choose (or opt into create).
 */
export function pickTransport(fn: CtsFunction, candidates: TransportCandidate[]): GovernResult {
  const last = recallTransport(fn)
  if (last) {
    const hit = candidates.find(c => c.trkorr === last)
    if (hit) {
      return {
        kind: "reuse",
        trkorr: last,
        note: `↻ continuing on this session's transport ${last}${hit.text ? ` — ${hit.text}` : ""}`,
      }
    }
  }
  return { kind: "choose", candidates }
}

/** Render candidate requests as a bullet list for a "pick one" prompt. */
export function formatCandidates(candidates: TransportCandidate[], emptyHint: string): string {
  return candidates.length
    ? candidates.map(c => `   • ${c.trkorr}  ${c.text}${c.owner ? `  (${c.owner})` : ""}`).join("\n")
    : `   ${emptyHint}`
}

export interface TransportPromptOptions {
  /** Open modifiable requests of the right CTS function (already filtered). */
  candidates: TransportCandidate[]
  ctsFunction: CtsFunction
  /** Human label for the change, e.g. "a recorded customizing write" / "the entity copier". */
  contextLabel: string
  /** Whether the engine can set the request's short text on create (customizing: yes;
   *  org_copy: no — the entity copier mints its own request with a fixed text). */
  canName: boolean
  /** Optional extra escape hatch, e.g. "recordTransport: false for a direct untransported write". */
  extraDirectOption?: string
  /** Leading notes (deploy/resolve) to keep at the top of the message. */
  prefix?: string
  /** Note about the candidate scope, e.g. "your open requests — pass showAllTransports: true for everyone's". */
  scopeNote?: string
}

/**
 * Build the interactive "choose a transport" prompt returned when a recorded
 * commit has no explicit transport and the caller didn't opt into create. Always
 * lists the usable open requests (flagging the one used earlier this session as a
 * suggestion) AND spells out the create options — so the user picks rather than
 * the engine silently deciding. When no request of the right type exists, the
 * three create paths (engine auto / engine named / SolMan·cALM) are the focus.
 */
export function buildTransportPrompt(o: TransportPromptOptions): string {
  const typeLabel = o.ctsFunction === "W" ? "Customizing" : "Workbench"
  const last = recallTransport(o.ctsFunction)
  const lines: string[] = []
  if (o.prefix && o.prefix.trim()) lines.push(o.prefix.trimEnd())
  lines.push(`🚦 No transport specified for ${o.contextLabel} — choose how to record it:`, "")

  if (o.candidates.length) {
    const scope = o.scopeNote ? ` — ${o.scopeNote}` : ""
    lines.push(`▸ Record into an existing open ${typeLabel} request (CTS function ${o.ctsFunction})${scope}:`)
    for (const c of o.candidates) {
      const flag = last && c.trkorr === last ? "   ← used earlier this session" : ""
      lines.push(`   • ${c.trkorr}  ${c.text}${c.owner ? `  (${c.owner})` : ""}${flag}`)
    }
    lines.push(`     → re-run with  transport: <one of the above>`, "")
  } else {
    const scope = o.scopeNote ? ` (${o.scopeNote})` : ""
    lines.push(`▸ No open ${typeLabel} request (CTS function ${o.ctsFunction}) found${scope}.`, "")
  }

  lines.push(`▸ Or create a new ${typeLabel} request:`)
  lines.push(`   • createTransport: true                                  — engine creates one automatically`)
  if (o.canName) {
    lines.push(`   • createTransport: true + transportText: "<short text>"  — engine creates it with your name`)
  }
  lines.push(`   • create one in SolMan / SAP Cloud ALM, then re-run with  transport: <number>`)

  if (o.extraDirectOption) {
    lines.push("", `▸ Or ${o.extraDirectOption}`)
  }
  return lines.join("\n")
}
