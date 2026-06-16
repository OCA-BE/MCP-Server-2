/**
 * Connected-target capability awareness.
 *
 * Different boxes offer different things: the in-system engine may not be
 * deployed (or be an older version); a stripped ABAP platform (e.g. CAR) has no
 * ECOP entity copier; a non-retail system has no listing engine. To avoid
 * calling something that fails on the target, tools pre-flight against a cached
 * per-connection capability snapshot derived from the engine's ping/env probe,
 * and refuse cleanly ("not available on this system") instead of erroring.
 */

export interface SystemCaps {
  engineDeployed: boolean
  engineVersion?: string
  sapBasis?: string
  s4core?: string
  isS4: boolean
  hasOrgCopy: boolean   // ECOP_ORG_UNITS_IN_THE_DARK present
  hasCtsTask: boolean   // TRINT_INSERT_NEW_COMM present
  hasMcGui: boolean     // tx LTMC present (migration cockpit GUI)
}

/** Shape of the engine ping response we read (uppercase keys from /ui2/cl_json). */
export interface PingResponse {
  STATUS?: string
  VERSION?: string
  DATA_JSON?: string
}

const NO_CAPS: SystemCaps = {
  engineDeployed: false, isS4: false,
  hasOrgCopy: false, hasCtsTask: false, hasMcGui: false,
}

const isX = (v: unknown): boolean => v === "X" || v === "x" || v === true

/** Pure: derive capabilities from an engine ping response (or null on failure). */
export function capsFromPing(resp: PingResponse | null | undefined): SystemCaps {
  if (!resp || resp.STATUS !== "ok") return { ...NO_CAPS }
  const caps: SystemCaps = { ...NO_CAPS, engineDeployed: true, engineVersion: resp.VERSION }
  if (resp.DATA_JSON) {
    try {
      const e = JSON.parse(resp.DATA_JSON) as Record<string, unknown>
      caps.isS4       = isX(e.IS_S4)
      caps.hasOrgCopy = isX(e.HAS_ORG_COPY)
      caps.hasCtsTask = isX(e.HAS_CTS_TASK)
      caps.hasMcGui   = isX(e.HAS_MC_GUI)
      if (typeof e.SAP_BASIS === "string") caps.sapBasis = e.SAP_BASIS
      if (typeof e.S4CORE === "string") caps.s4core = e.S4CORE
    } catch { /* leave defaults */ }
  }
  return caps
}

/**
 * Pre-flight guard. Returns an error string if the engine isn't reachable or a
 * required capability is missing, else undefined. `need` names boolean caps;
 * `labels` provides human descriptions for the message.
 */
export function requireCaps(
  caps: SystemCaps,
  need: (keyof SystemCaps)[] = [],
  labels: Partial<Record<keyof SystemCaps, string>> = {},
): string | undefined {
  if (!caps.engineDeployed) {
    return "the in-system engine is not deployed/reachable on this connection — run customizing_engine_bootstrap (or engine_deploy) first"
  }
  for (const n of need) {
    if (!caps[n]) return `not available on this system: ${labels[n] ?? String(n)}`
  }
  return undefined
}

// ── per-connection cache ──────────────────────────────────────────────────────
const cache = new Map<string, SystemCaps>()
const keyOf = (connectionId?: string) => connectionId ?? "__default__"

/**
 * Cached capability snapshot for a connection. `ping` performs the actual engine
 * ping (injected so this stays unit-testable and free of the HTTP layer). A
 * failed ping yields engineDeployed=false (and is cached so we don't hammer a
 * box without the engine). Pass force=true to re-probe (e.g. after a deploy).
 */
export async function getCapabilities(
  connectionId: string | undefined,
  ping: (connectionId?: string) => Promise<PingResponse>,
  force = false,
): Promise<SystemCaps> {
  const key = keyOf(connectionId)
  if (!force && cache.has(key)) return cache.get(key) as SystemCaps
  let resp: PingResponse | null = null
  try { resp = await ping(connectionId) } catch { resp = null }
  const caps = capsFromPing(resp)
  cache.set(key, caps)
  return caps
}

/** Drop a cached snapshot (or all). Call after a deploy changes capabilities. */
export function clearCapabilities(connectionId?: string): void {
  if (connectionId === undefined) cache.clear()
  else cache.delete(keyOf(connectionId))
}
