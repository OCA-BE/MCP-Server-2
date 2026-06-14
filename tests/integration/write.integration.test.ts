/**
 * Integration tests — Write, activate, and lock registry
 *
 * WARNING: This suite creates, writes, activates, and deletes a real ABAP object
 * on the SAP system.  It targets the $TMP local package (non-transportable) and
 * cleans up after itself even on failure.
 *
 * Requires a live SAP connection AND opt-in env var:
 *   SAP_TEST_CONNECTION=CAR SAP_TEST_WRITE=1 npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { requireConnection, CONNECTION_ID } from "./helpers"
import { handleCreateAbapObject, handleWriteAbapObjectSource, handleDeleteAbapObject } from "../../src/tools/write"
import { handleAbapActivate } from "../../src/tools/activate"
import { handleSetTextElements, handleGetTextElements } from "../../src/tools/textelements"
import { handleCreateTestInclude } from "../../src/tools/quality"
import { dropSessionLocks } from "../../src/connections"

const WRITE_ENABLED = !!process.env.SAP_TEST_WRITE

// Unique name so parallel runs don't collide
const TEST_PROG = `ZMCP_LOCK_TEST_${Date.now().toString(36).toUpperCase()}`
// ADT URL pattern for programs
const TEST_URL = `/sap/bc/adt/programs/programs/${TEST_PROG}`

// Separate class for the test-include lock check
const TEST_CLASS = `ZCL_MCP_LOCK_${Date.now().toString(36).toUpperCase()}`
const TEST_CLASS_URL = `/sap/bc/adt/oo/classes/${TEST_CLASS.toLowerCase()}`

let created = false
let classCreated = false

beforeAll(() => {
  requireConnection()
  if (!WRITE_ENABLED) {
    console.log("Write integration tests skipped — set SAP_TEST_WRITE=1 to enable")
  }
})

afterAll(async () => {
  if (!WRITE_ENABLED) return
  // Best-effort cleanup regardless of test outcome
  if (created) {
    try {
      await handleDeleteAbapObject({ url: TEST_URL, connectionId: CONNECTION_ID })
      console.log(`Cleaned up test program ${TEST_PROG}`)
    } catch (e) {
      console.warn(`Cleanup of ${TEST_PROG} failed — delete it manually: ${e}`)
    }
  }
  if (classCreated) {
    try {
      await handleDeleteAbapObject({ url: TEST_CLASS_URL, connectionId: CONNECTION_ID })
      console.log(`Cleaned up test class ${TEST_CLASS}`)
    } catch (e) {
      console.warn(`Cleanup of ${TEST_CLASS} failed — delete it manually: ${e}`)
    }
  }
  // Release any residual E_ABAP_GENPH / author locks that deleteObject doesn't clear
  try { await dropSessionLocks(CONNECTION_ID) } catch { /* best-effort */ }
})

describe("write → activate lock registry smoke test [integration]", () => {
  it("creates, writes, and activates a program without lock conflict", async () => {
    if (!WRITE_ENABLED) return

    // 1. Create
    const createResult = await handleCreateAbapObject({
      objectType: "PROG/P",
      name: TEST_PROG,
      description: "MCP lock-registry smoke test — safe to delete",
      packageName: "$TMP",
      connectionId: CONNECTION_ID,
    })
    expect(createResult.content[0].text).toContain("✅")
    created = true

    // 2. Write source — this acquires a lock and tracks it in the registry
    const source = `REPORT ${TEST_PROG}.\nWRITE 'MCP lock test OK'.`
    const writeResult = await handleWriteAbapObjectSource({
      url: TEST_URL,
      source,
      connectionId: CONNECTION_ID,
    })
    expect(writeResult.content[0].text).toContain("✅")
    expect(writeResult.content[0].text).toContain("still locked")

    // 3. Activate — must auto-release the held lock first, then activate
    //    Before the lock-registry fix this would fail with "User is currently editing"
    const activateResult = await handleAbapActivate({
      url: TEST_URL,
      connectionId: CONNECTION_ID,
    })
    const activateText = activateResult.content[0].text
    // Accept success or warnings (e.g. ATC findings); reject hard failure
    expect(activateText).not.toContain("currently editing")
    expect(activateText).not.toMatch(/❌.*Activation failed/i)
    expect(activateText).toContain(TEST_PROG)
  })

  it("write → activate → write again works (lock re-acquired)", async () => {
    if (!WRITE_ENABLED || !created) return

    const source2 = `REPORT ${TEST_PROG}.\nWRITE 'second write OK'.`
    const writeResult = await handleWriteAbapObjectSource({
      url: TEST_URL,
      source: source2,
      connectionId: CONNECTION_ID,
    })
    expect(writeResult.content[0].text).toContain("✅")

    const activateResult = await handleAbapActivate({
      url: TEST_URL,
      connectionId: CONNECTION_ID,
    })
    expect(activateResult.content[0].text).not.toContain("currently editing")
    expect(activateResult.content[0].text).not.toMatch(/❌.*Activation failed/i)
  })
})

describe("set_text_elements write + lock-lifecycle regression [integration]", () => {
  it("writes a selection text and reads it back", async () => {
    if (!WRITE_ENABLED || !created) return

    // Selection text on a declared PARAMETER is the canonical always-valid case:
    // the element id (P_TEST) maps directly to a declared parameter, so ADT's
    // text-element consistency check passes.
    const source = `REPORT ${TEST_PROG}.\nPARAMETERS p_test TYPE c LENGTH 10.\nWRITE p_test.`
    await handleWriteAbapObjectSource({ url: TEST_URL, source, connectionId: CONNECTION_ID })
    await handleAbapActivate({ url: TEST_URL, connectionId: CONNECTION_ID })

    const setResult = await handleSetTextElements({
      objectType: "PROG/P",
      objectName: TEST_PROG,
      objectUrl: TEST_URL,
      category: "selections",
      elements: [{ id: "P_TEST", text: "MCP test param" }],
      connectionId: CONNECTION_ID,
    })
    const setText = setResult.content[0].text
    expect(setText).toContain("✅")
    // Must never block on a lock left by the preceding write→activate
    expect(setText).not.toContain("currently editing")

    // Read back to confirm it was actually persisted
    const getResult = await handleGetTextElements({
      objectType: "PROG/P",
      objectName: TEST_PROG,
      category: "selections",
      connectionId: CONNECTION_ID,
    })
    expect(getResult.content[0].text).toContain("MCP test param")
  })

  it("write → activate → set_text_elements loop ×3 never leaks a blocking lock", async () => {
    if (!WRITE_ENABLED || !created) return

    // The original bug: each set_text_elements call leaked a TRDIR enqueue, so the
    // next iteration failed with "currently editing".  A leaked lock would surface
    // here as a "currently editing" error on iteration 2 or 3.
    // Source declares PARAMETERS p_test so the selection-text write passes validation.
    const source = `REPORT ${TEST_PROG}.\nPARAMETERS p_test TYPE c LENGTH 10.\nWRITE p_test.`
    for (let i = 1; i <= 3; i++) {
      const w = await handleWriteAbapObjectSource({
        url: TEST_URL, source, connectionId: CONNECTION_ID,
      })
      expect(w.content[0].text, `write iter ${i}`).toContain("✅")

      const a = await handleAbapActivate({ url: TEST_URL, connectionId: CONNECTION_ID })
      expect(a.content[0].text, `activate iter ${i}`).not.toContain("currently editing")

      const t = await handleSetTextElements({
        objectType: "PROG/P",
        objectName: TEST_PROG,
        objectUrl: TEST_URL,
        category: "selections",
        elements: [{ id: "P_TEST", text: `iteration ${i} label` }],
        connectionId: CONNECTION_ID,
      })
      expect(t.content[0].text, `set_text iter ${i}`).toContain("✅")
      expect(t.content[0].text, `set_text iter ${i}`).not.toContain("currently editing")
    }
  })
})

describe("create_test_include lock + name-vs-URL regression [integration]", () => {
  it("creates a class, adds a test include, with the class lock covering it", async () => {
    if (!WRITE_ENABLED) return

    // Create a throwaway class in $TMP
    const createResult = await handleCreateAbapObject({
      objectType: "CLAS/OC",
      name: TEST_CLASS,
      description: "MCP test-include lock check — safe to delete",
      packageName: "$TMP",
      connectionId: CONNECTION_ID,
    })
    expect(createResult.content[0].text).toContain("✅")
    classCreated = true

    // Minimal valid class so it can be activated
    const classSource =
      `CLASS ${TEST_CLASS.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.\n` +
      `  PUBLIC SECTION.\n  PROTECTED SECTION.\n  PRIVATE SECTION.\nENDCLASS.\n` +
      `CLASS ${TEST_CLASS.toLowerCase()} IMPLEMENTATION.\nENDCLASS.`
    await handleWriteAbapObjectSource({ url: TEST_CLASS_URL, source: classSource, connectionId: CONNECTION_ID })
    await handleAbapActivate({ url: TEST_CLASS_URL, connectionId: CONNECTION_ID })

    // The actual regression: passing the class URL must resolve to the class NAME
    // for the /oo/classes/<name>/includes POST, and the class lock must cover it.
    const incResult = await handleCreateTestInclude({
      classUrl: TEST_CLASS_URL,
      connectionId: CONNECTION_ID,
    })
    const text = incResult.content[0].text
    expect(text).toContain("✅")
    // Must not block on a lock and must not 404 from a URL-encoded name
    expect(text).not.toContain("currently editing")
    expect(text).not.toMatch(/not found|invalid/i)
  })
})

describe("list_all_transports [integration]", () => {
  it("returns transport overview or empty message", async () => {
    if (!WRITE_ENABLED) return

    const { handleListAllTransports } = await import("../../src/tools/transports")
    const result = await handleListAllTransports({
      status: "modifiable",
      connectionId: CONNECTION_ID,
    })
    const text = result.content[0].text
    expect(text).toBeTruthy()
    // Either lists transports or says none found
    expect(text).toMatch(/transport|No open transports/i)
  })
})
