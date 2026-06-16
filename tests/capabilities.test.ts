import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  capsFromPing, requireCaps, getCapabilities, clearCapabilities,
  type PingResponse,
} from "../src/tools/capabilities"

describe("capsFromPing", () => {
  it("null / failed ping → engine not deployed, all caps false", () => {
    for (const r of [null, undefined, { STATUS: "error" } as PingResponse]) {
      const c = capsFromPing(r)
      expect(c.engineDeployed).toBe(false)
      expect(c.hasOrgCopy).toBe(false)
      expect(c.isS4).toBe(false)
    }
  })

  it("ok ping with env flags → parses caps", () => {
    const c = capsFromPing({
      STATUS: "ok", VERSION: "0.9.17",
      DATA_JSON: JSON.stringify({
        IS_S4: "X", HAS_ORG_COPY: "X", HAS_CTS_TASK: "", HAS_MC_GUI: "X",
        SAP_BASIS: "816", S4CORE: "109",
      }),
    })
    expect(c.engineDeployed).toBe(true)
    expect(c.engineVersion).toBe("0.9.17")
    expect(c.isS4).toBe(true)
    expect(c.hasOrgCopy).toBe(true)
    expect(c.hasCtsTask).toBe(false)
    expect(c.hasMcGui).toBe(true)
    expect(c.sapBasis).toBe("816")
    expect(c.s4core).toBe("109")
  })

  it("ok ping without/with bad DATA_JSON → engine deployed, caps default false", () => {
    expect(capsFromPing({ STATUS: "ok" }).engineDeployed).toBe(true)
    expect(capsFromPing({ STATUS: "ok" }).hasOrgCopy).toBe(false)
    const bad = capsFromPing({ STATUS: "ok", DATA_JSON: "{not json" })
    expect(bad.engineDeployed).toBe(true)
    expect(bad.hasOrgCopy).toBe(false)
  })

  it("accepts boolean true as well as 'X'", () => {
    const c = capsFromPing({ STATUS: "ok", DATA_JSON: JSON.stringify({ HAS_ORG_COPY: true }) })
    expect(c.hasOrgCopy).toBe(true)
  })
})

describe("requireCaps", () => {
  const full = capsFromPing({ STATUS: "ok", DATA_JSON: JSON.stringify({ IS_S4: "X", HAS_ORG_COPY: "X" }) })
  it("flags engine not deployed", () => {
    expect(requireCaps(capsFromPing(null))).toMatch(/not deployed/)
  })
  it("flags a missing capability with its label", () => {
    const noEcop = capsFromPing({ STATUS: "ok", DATA_JSON: JSON.stringify({ HAS_ORG_COPY: "" }) })
    expect(requireCaps(noEcop, ["hasOrgCopy"], { hasOrgCopy: "the EC entity copier" }))
      .toMatch(/EC entity copier/)
  })
  it("passes when all required caps are present", () => {
    expect(requireCaps(full, ["hasOrgCopy", "isS4"])).toBeUndefined()
  })
})

describe("getCapabilities cache", () => {
  beforeEach(() => clearCapabilities())

  it("probes once and caches per connection", async () => {
    const ping = vi.fn(async () => ({ STATUS: "ok", VERSION: "v1" } as PingResponse))
    const a = await getCapabilities("S4", ping)
    const b = await getCapabilities("S4", ping)
    expect(a.engineDeployed).toBe(true)
    expect(b).toEqual(a)
    expect(ping).toHaveBeenCalledTimes(1)
  })

  it("force=true re-probes", async () => {
    const ping = vi.fn(async () => ({ STATUS: "ok" } as PingResponse))
    await getCapabilities("S4", ping)
    await getCapabilities("S4", ping, true)
    expect(ping).toHaveBeenCalledTimes(2)
  })

  it("a throwing ping yields (and caches) engine-not-deployed", async () => {
    const ping = vi.fn(async () => { throw new Error("ECONNREFUSED") })
    const c = await getCapabilities("CAR", ping)
    expect(c.engineDeployed).toBe(false)
    await getCapabilities("CAR", ping)
    expect(ping).toHaveBeenCalledTimes(1)   // failure is cached
  })

  it("clearCapabilities forces a fresh probe", async () => {
    const ping = vi.fn(async () => ({ STATUS: "ok" } as PingResponse))
    await getCapabilities("S4", ping)
    clearCapabilities("S4")
    await getCapabilities("S4", ping)
    expect(ping).toHaveBeenCalledTimes(2)
  })
})
