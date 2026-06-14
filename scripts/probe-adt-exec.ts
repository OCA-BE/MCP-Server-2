/**
 * Probe whether the ADT program execution endpoint is active on a system.
 *
 * Usage:  SAP_TEST_CONNECTION=CAR npx tsx scripts/probe-adt-exec.ts
 *
 * Steps:
 *   1. Connect using existing connections.json config
 *   2. Create a trivial Z report in $TMP
 *   3. Activate it
 *   4. POST to /sap/bc/adt/programs/programs/<name>/executions
 *   5. Report back HTTP status, headers, and body
 *   6. Delete the report (cleanup)
 */

import { ADTClient, createSSLConfig, session_types } from "abap-adt-api"
import { readFileSync } from "fs"
import { join } from "path"

const CONNECTION_ID = process.env.SAP_TEST_CONNECTION
if (!CONNECTION_ID) {
  console.error("Set SAP_TEST_CONNECTION=<id>  e.g. SAP_TEST_CONNECTION=CAR")
  process.exit(1)
}

const cfgFile = join(process.cwd(), "connections.json")
const allCfg = JSON.parse(readFileSync(cfgFile, "utf-8"))
const cfg = allCfg.connections.find((c: any) => c.id === CONNECTION_ID)
if (!cfg) { console.error(`Connection "${CONNECTION_ID}" not found in connections.json`); process.exit(1) }

const PROG = `ZMCP_EXEC_PROBE_${Date.now().toString(36).toUpperCase()}`
const PROG_URL = `/sap/bc/adt/programs/programs/${PROG}`
const EXEC_URL = `${PROG_URL}/executions`

const isHttps = cfg.url.toLowerCase().startsWith("https:")
const client = new ADTClient(
  cfg.url, cfg.username, cfg.password, cfg.client, cfg.language ?? "EN",
  isHttps ? createSSLConfig(cfg.allowSelfSigned ?? false) : {}
)
const http = (client as any).httpClient   // AdtHTTP with .request()

async function cleanup() {
  try {
    const lock = await client.lock(PROG_URL)
    await client.deleteObject(PROG_URL, lock.LOCK_HANDLE)
    console.log(`\n🗑  Cleaned up ${PROG}`)
  } catch { /* best effort */ }
}

async function main() {
  console.log(`Connecting to ${cfg.url} as ${cfg.username} (client ${cfg.client})…`)
  await client.login()
  console.log("✅ Logged in\n")

  // 1. Create
  console.log(`Creating probe report ${PROG} in $TMP…`)
  await client.createObject("PROG/P", PROG, "$TMP", "ADT exec probe — safe to delete",
    "/sap/bc/adt/packages/$TMP")
  // drop create author lock, then restore stateful mode for subsequent lock()
  await client.dropSession()
  client.stateful = session_types.stateful

  // 2. Write source
  const src = [
    `REPORT ${PROG}.`,
    `WRITE: / '{"status":"ok","probe":"adt-exec","report":"${PROG}"}'.`,
  ].join("\n")

  const lock = await client.lock(PROG_URL)
  await client.setObjectSource(`${PROG_URL}/source/main`, src, lock.LOCK_HANDLE)
  await client.unLock(PROG_URL, lock.LOCK_HANDLE)   // release before activate

  // 3. Activate
  console.log("Activating…")
  await client.activate(PROG, PROG_URL)
  console.log("✅ Activated\n")

  // 4. Probe ADT execution endpoint (may not exist on older BASIS releases)
  console.log(`\n── Probe 1: ADT program execution ──────────────────────────`)
  console.log(`POST ${EXEC_URL}`)
  try {
    const resp = await http.request(EXEC_URL, {
      method: "POST",
      headers: {
        "Accept": "text/plain, application/xml, */*",
        "Content-Type": "application/vnd.sap.adt.programs.program.executions+xml",
      },
      data: `<?xml version="1.0" encoding="utf-8"?>
<program:executionConfiguration
  xmlns:program="http://www.sap.com/adt/programs"
  xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReference adtcore:uri="${PROG_URL}"/>
</program:executionConfiguration>`,
    })
    console.log(`HTTP status:  ${resp.status}`)
    const body = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data, null, 2)
    console.log(`Body:\n${body.substring(0, 1000)}`)
    console.log("✅ ADT exec endpoint active — Phase 1 via ADT exec is viable.")
  } catch (err: any) {
    const status = err?.status ?? "?"
    console.log(`HTTP status:  ${status}`)
    if (status === 404) console.log("❌ Not available on this BASIS release.")
    else console.log(`Body: ${String(err?.response?.data ?? err?.message ?? err).substring(0, 500)}`)
  }

  // 5. Probe RFC over HTTP endpoint
  const RFC_URL = "/sap/bc/rfc/"
  console.log(`\n── Probe 2: RFC over HTTP ───────────────────────────────────`)
  console.log(`POST ${RFC_URL}`)
  try {
    // Call a harmless built-in RFC FM to test the endpoint
    const resp = await http.request(RFC_URL, {
      method: "POST",
      headers: {
        "Accept": "application/xml, */*",
        "Content-Type": "application/xml",
        "sap-client": cfg.client,
      },
      data: `<?xml version="1.0" encoding="utf-8"?>
<RFC_FUNCTION_CALL>
  <FUNCTION name="RFC_PING"/>
</RFC_FUNCTION_CALL>`,
    })
    console.log(`HTTP status:  ${resp.status}`)
    const body = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data, null, 2)
    console.log(`Body:\n${body.substring(0, 1000)}`)
    console.log("✅ RFC over HTTP active — Phase 1 via /sap/bc/rfc/ is viable.")
  } catch (err: any) {
    const status = err?.status ?? "?"
    const body   = String(err?.response?.data ?? err?.message ?? err).substring(0, 500)
    console.log(`HTTP status:  ${status}`)
    console.log(`Body: ${body}`)
    if (status === 404) {
      console.log("❌ /sap/bc/rfc/ not active — activate in SICF: default_host → sap → bc → rfc")
    } else if (status === 401 || status === 403) {
      console.log("⚠️  Auth rejected — endpoint exists but user lacks S_RFC authorization.")
    } else {
      console.log(`⚠️  Status ${status} — endpoint may exist, check body above.`)
    }
  }

  // 6. Probe SOAP/WebService endpoint (calls RFC-enabled FMs as SOAP services)
  const SOAP_URL = "/sap/bc/srt/rfc/sap/rfc_ping/600/rfc_ping/rfc_ping"
  console.log(`\n── Probe 3: SOAP / Web Services (/sap/bc/srt/) ─────────────`)
  console.log(`POST ${SOAP_URL}`)
  try {
    const resp = await http.request(SOAP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": "urn:sap-com:document:sap:rfc:functions:RFC_PING:RFC_PINGRequest",
      },
      data: `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:sap-com:document:sap:rfc:functions">
  <soapenv:Header/>
  <soapenv:Body><urn:RFC_PING/></soapenv:Body>
</soapenv:Envelope>`,
    })
    console.log(`HTTP status:  ${resp.status}`)
    const body = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data)
    console.log(`Body:\n${body.substring(0, 500)}`)
    console.log("✅ SOAP endpoint active — can call RFC-enabled FMs via SOAP.")
  } catch (err: any) {
    const status = err?.status ?? "?"
    const body   = String(err?.response?.data ?? err?.message ?? err).substring(0, 500)
    console.log(`HTTP status:  ${status}  ${status === 404 ? "❌ not active" : status === 400 ? "⚠️  active but wrong URL/body" : ""}`)
    console.log(`Body: ${body}`)
  }

  // 7. Probe OData Gateway
  const ODATA_URL = "/sap/opu/odata/"
  console.log(`\n── Probe 4: OData Gateway (/sap/opu/odata/) ────────────────`)
  try {
    const resp = await http.request(ODATA_URL, { method: "GET", headers: { "Accept": "application/json" } })
    console.log(`HTTP status:  ${resp.status}`)
    console.log("✅ OData Gateway active.")
  } catch (err: any) {
    const status = err?.status ?? "?"
    console.log(`HTTP status:  ${status}  ${status === 404 ? "❌ not active" : status === 403 ? "⚠️  active, auth required" : ""}`)
  }

  await cleanup()
}

main().catch(e => { console.error(e); process.exit(1) })
