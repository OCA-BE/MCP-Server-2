/**
 * ABAP batch report: customizing engine write LUW.
 *
 * Runs in a background job (sy-batch = 'X') so the view-maintenance runtime and
 * its transport recording execute headlessly — no SM30 dynpro.
 *
 * Two write paths, selected by the presence of a maintenance VIEW:
 *
 *   1. View path (view_name supplied) — the proper customizing write.
 *      For each planned row we call VIEW_MAINTENANCE_SINGLE_ENTRY with
 *      suppressdialog='X'.  That single SAP-standard call does, internally:
 *        • VIEW_GET_DDIC_INFO   — view metadata (no hand-built VIMNAMTAB)
 *        • VIEW_AUTHORITY_CHECK — S_TABU_DIS / S_TABU_CLI
 *        • VIEW_ENQUEUE         — lock / unlock
 *        • the generated VIEWPROC_<view> — FK/domain checks, maintenance
 *          events, change documents, DB update over the WHOLE view
 *          (base table + text table), and transport recording as
 *          R3TR VDAT <view> via corr_number → e071k.
 *      This is why the old R3TR TABU path recorded the wrong object and 0
 *      E071K entries: customizing is maintained through the view, not the table.
 *
 *   2. Direct path (no view) — class A application data, or a table with no
 *      maintenance view: plain MODIFY inside an ENQUEUE, no transport.
 *
 * Communication with the ICF handler: INDX cluster table areas ZP (params)
 * and ZR (results), keyed by a 22-char run_id generated in the ICF handler.
 *
 * Deployed alongside ZCL_MCP_CUST_ENGINE by customizing_engine_bootstrap.
 */

export const WRITER_REPORT_NAME = "ZMCP_CUST_WRITE"
export const WRITER_REPORT_URL  = `/sap/bc/adt/programs/programs/${WRITER_REPORT_NAME.toLowerCase()}`

import { readAbap } from "./loadSource"

/** The writer report source, read from `zmcp_cust_write.abap` at call time. */
export function getWriterSource(): string {
  return readAbap("zmcp_cust_write")
}
