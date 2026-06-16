/**
 * Loader + identity for the Tier-0 read-only diagnostic engine ZCL_MCP_DIAG.
 * Source lives in zcl_mcp_diag.abap (read at call time, like the cust engine).
 */
import { readAbap } from "./loadSource"

export const DIAG_CLASS_NAME = "ZCL_MCP_DIAG"
export const DIAG_CLASS_URL  = "/sap/bc/adt/oo/classes/zcl_mcp_diag"
export const DIAG_ICF_PATH   = "/sap/bc/zmcp_diag"

/** The DIAG class source (self-contained read-only engine). */
export function getDiagSource(): string {
  return readAbap("zcl_mcp_diag")
}
