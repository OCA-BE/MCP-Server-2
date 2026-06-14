# Customizing Engine — Handoff & Findings

> ## ⏩ LATEST STATUS (2026-06-10 — all pushed to master)
> **Engine v0.9.7.** Canonical reference: **[`docs/customizing-engine.md`](docs/customizing-engine.md)** — read
> that first; this file is the debugging saga / findings history. After any TS/ABAP change: rebuild + restart the
> server + **reconnect the MCP client** (catalog is snapshotted at session start; a restart reconnects the
> transport but does not re-list tools).
>
> **★ Transport recording WORKS (was the long-open hard part).** The SM30-runtime rewrite
> (`VIEW_MAINTENANCE_SINGLE_ENTRY`, `suppressdialog='X'`, in a real `sy-batch` background job) records
> `R3TR VDAT <view>` over the full table set. Proven: `/POSDW/TENDTY` `0001 → ZCSH` recorded into a Customizing
> request, E071K post-commit re-check passes. The old TK495 / "0 E071K" was two bugs — recording the wrong object
> (`R3TR TABU` instead of the view's `VDAT`) and a **false-negative verification** (counting E071K on the request
> header, not the task; CTS records onto the task). Both fixed.
>
> **★ SM30-standard DELETE added (v0.9.4).** `customizing_apply action:"delete"` removes the `targetKey` entry via
> `VIEW_MAINTENANCE_SINGLE_ENTRY action='DEL'`, recording the deletion onto the transport like an SM30 row delete
> (no manual table/E071K surgery). Proven: removed `/POSDW/TENDTY 0001/ZCSH` (base + text gone, deletion recorded).
> Note: the SM30 delete keeps the object key (now an absent-row = export-deletion); stripping it = manual SE10, not done.
>
> **Other proven:** direct (untransported) write for sandbox/test data; governed transport selection
> (reuse session request / list open / create-new opt-in); IMG search via the STREE text index + `img_index_read`.
>
> **★ Read-ABAP-from-disk DONE (v0.9.5).** Engine/writer ABAP now lives in `src/abap/*.abap` (single source of
> truth), read at `customizing_engine_bootstrap` time by `loadSource.ts` (substitutes `{{ENGINE_VERSION}}` /
> `{{HSRCH_AREA_CASES}}`). An ABAP-only edit needs NO `npm build` and NO server restart — just re-bootstrap.
> (A tool-SCHEMA change still needs build + restart + MCP reconnect.)
>
> **★ T000 capability read-on-connect DONE (v0.9.6).** The engine reads the client's change/transport capability from
> `T000` (SCC4) and routes record-vs-direct accordingly instead of assuming every C/G/E change records: `CCCORACTIV='1'`
> → recorded; `''`/`'3'` → written through the SM30 view runtime **without** a transport (no false E071K re-check fault);
> `'2'` → refused; cross-client tables gated by `CCNOCLIIND`. `customizing_engine_ping` now surfaces the capability on
> connect. Proven on CAR: ping reports client 600 = `CCCORACTIV='1'` → auto-record; selftest + live `handle_write`
> dry-run clean. (CAR 600 records, so the non-recording branch can't be live-proven — covered by clean activation.)
>
> **★ View-cluster CDAT spike (v0.9.7) — DATA works, true CDAT recording BLOCKED.** Clusters resolve via VCLSTRUC;
> the engine writes member data and records `R3TR VDAT` (member view) + TABU keys → cluster data transports correctly
> (proven: `/POSDW/GPAP 0010→Z999` into CARK900011). True `R3TR CDAT` recording is blocked: the headless key-level
> recorder `TR_OBJECTS_INSERT` hardcodes `iv_with_dialog='X'` → TK495 even in a background job (same dialog wall that
> killed it for VDAT). A dormant `transport_object='CDAT'` writer path (`no_transport` member write + `record_cdat`)
> exists; re-enable only with a headless recorder (TRINT direct-call, or `VIEWCLUSTER_IMPORT` + staged SLCTR content).
> Goal context: full IMG object-type coverage for the NL→Enterprise-Structure builder (see auto-memory).
>
> **Still open:** a genuinely-headless CDAT recorder (above); number-range (NROB/SNUM) writes; the ES-builder
> orchestration layer (NL description → ordered typed customizing steps → dry-run → apply).

Status of the `customizing_*` capability (ICF-based ABAP "Customizing Engine") as validated end-to-end
against system **CAR** (http://sapcar:8001, user BASIS, client 600), 2026-06-09. Written for the fix
session so it can self-test locally instead of relaying through a human.

Source map (this repo):
- `src/abap/zcl_mcp_cust_engine.ts` — engine class `ZCL_MCP_CUST_ENGINE` (ICF handler, JSON in/out)
- `src/abap/zmcp_cust_write.ts` — background batch writer report `ZMCP_CUST_WRITE`
- `src/tools/customizingEngine.ts` — `customizing_engine_bootstrap` / `_ping` / `_selftest`
- `src/tools/customizing.ts` — `customizing_read` / `_describe` / `_diff` / `_plan_change` / `_apply`
- MCP transport / session layer — wherever the streamable-HTTP server + SAP ADT HTTP client live (Brief 3)

SICF: node `/sap/bc/zmcp_cust`, handler `ZCL_MCP_CUST_ENGINE`, must be **active** (one-time, BASIS).

---

## ✅ Proven WORKING end-to-end
- Bootstrap deploy/activate with **update-in-place** (must update if class exists, not just `create`).
- `ping` (version handshake), `selftest` (dynamic typing, sample read, DDIC-aware E071K TABKEY build —
  verified `'600100*EUR  USD  79989898'` for TCURR).
- `customizing_read` on real customizing (`/POSDW/PROF`).
- `customizing_plan_change` / dry-run `customizing_apply` (correct 1-row plan, `0001→9998`).
- Delivery-class **E** allowed (POSDW tables are all E — guard must permit C/G **and E**).
- S_TABU_DIS auth check; ENQUEUE / ROLLBACK / DEQUEUE discipline.
- **Data write itself**: MODIFY+COMMIT created profiles `9998`/`9997` in `/POSDW/PROF` on CAR.
- **Transport recording** (the long-open hard part): `R3TR VDAT <view>` recorded via the SM30 runtime in a
  background job; E071K post-commit re-check passes. _(See LATEST STATUS above.)_
- **Async `apply`** (run_id + `customizing_status`); **governed transport selection**; **SM30-standard delete**.

> The "Open / not yet proven" list and BRIEF 1–3 below are **historical** — the recording, async, and
> connectivity items are all resolved. Kept as the findings/debugging record; current state is in LATEST STATUS
> and [`docs/customizing-engine.md`](docs/customizing-engine.md).

---

## BRIEF 1 — Transport recording must be rock-solid (the hard part)

### Root cause: execution context, not parameters
The engine runs in an **ICF dialog WP with no GUI and `sy-batch` unset**. Any FM that sends a dynpro is fatal
(`"Sending of dynpro … not possible: No window system type specified"`). We proved:
- **`TRINT_OBJECTS_CHECK_AND_INSERT`** (CTS-internal WBO API): satisfiable assert contract but, once
  satisfied, **does NOT persist E071K** — it's compute/validate-for-remote-orchestrator (in-code comment
  "no support for remote WBO API usage"). **Dead end.**
- **`TR_OBJECTS_INSERT`** (documented EXTERNAL interface, **persists**): pops dynpro `SAPLSTRD 0352` in ICF;
  `IV_NO_SHOW_OPTION/IV_NO_STANDARD_EDITOR/IV_NO_PS='X'` do **not** suppress it. Runs headless **only when
  `sy-batch='X'`** (a real background job).

### Correct architecture (implemented in `zmcp_cust_write.ts` — keep it)
Move the mutating LUW into a **background job**. The batch report, as ONE LUW: `ENQUEUE_E_TABLE` → MODIFY →
`TR_OBJECTS_INSERT` (headless under sy-batch) → **verify E071K has the exact keys; if 0 → ROLLBACK the MODIFY**
→ COMMIT/ROLLBACK → DEQUEUE → write result (status/rows_written/e071k_count/messages) to INDX(`ZR`) by run_id.
ICF returns run_id; status tool polls. **Never report success without re-SELECTing E071K** (false-success bit
us twice → untransported change = unacceptable at a customer).

### `TR_OBJECTS_INSERT` signature ON THIS RELEASE (S/4 FOUNDATION) — varies by release!
- IMPORTING: `WI_ORDER` (type **`E070-TRKORR`** — must be TRKORR-typed, NOT string), `IV_NO_PS`,
  `IV_NO_SHOW_OPTION`, `IV_NO_STANDARD_EDITOR`, `IV_EXTERNALID`, `IV_EXTERNALPS`, `IT_E071K_STR`
  (`E071K_STRTYP`), `IT_OBJ_ENTRIES`, `IV_READ_ACTIVITY_FROM_MEMORY`
- TABLES: `WT_E071K` (E071K), `WT_KO200` (KO200), `TT_TADIR` (TADIR)
- EXCEPTIONS: `CANCEL_EDIT_OTHER_ERROR`, `SHOW_ONLY_OTHER_ERROR`
- NOTE: no `WI_SIMULATION`, no `WT_E071` on this release; `TRINT_OBJECTS_INSERT` does **not exist** here.
  **Don't hardcode** — introspect `FUPARAREF`/`RPY_FUNCTIONMODULE_READ` and bind only existing params; type
  each actual to the formal type.

### Delivery-class routing (dd02l-contflag)
- `A` → application data: direct MODIFY+COMMIT, **no** transport (already implemented).
- `C`/`G`/`E` → customizing/control: transport-record via the batch path. (POSDW = all `E`.)
- `S`/`W`/`L` → refuse by default.
- Provide explicit `record_transport:true|false`. Default true for C/G/E; **false enables a sandbox
  direct-write mode** — which is all the POS-sim test-data builder actually needs (sandbox, never transported).

### Acceptance test
Fresh key → `commit=true` → response `ok` AND `E071K` has the key AND `manage_transport_requests details`
shows the object under the task. Forced failure (e.g. released request) → **0 rows written** (data rolled back).
Class-`A` table → direct write, no transport. Ideally run on ≥2 releases.

---

## BRIEF 2 — `customizing_apply` async + 30s timeout
The job-based commit must not block past the 30s tool HTTP timeout. Submit job → return `run_id` < 30s →
`customizing_status(run_id)` reads INDX(`ZR`). Start the job immediately (`STRTIMMED`), ensure a free bg WP.

---

## BRIEF 3 — Connectivity robustness (server-wide; matters most for a self-testing loop)
Two stale-state problems; the 4-min keep-alive fixes neither.

**Mode A — stale MCP transport session (60s `-32001` hang).** Log proof: request arrives on session X, NO
`← tool` response ever produced, client cancels at 60s, a fresh `initialize` serves the same call in 2ms. The
streamable-HTTP session's response channel dies on idle.
Fixes: (1) deliver request/response on the POST's own HTTP response, not only a long-lived SSE stream that dies
on idle; (2) on lost session return spec **`404`** so client re-inits+replays (never bare `400`, never a 60s
hang); (3) server-side per-request watchdog ~10s → fail fast; (4) heartbeat the MCP session + detect dead stream.

**Mode B — intermittent `400`s.** Either MCP `Mcp-Session-Id` expired/forgotten → bare `400` instead of `404`,
and/or SAP ADT CSRF token + `SAP_SESSIONID` cookie expired → ADT `400/403` until refreshed.
Fixes: (5) auto-refresh CSRF+cookie on any `400/401/403`/"CSRF"/"session expired" and **retry once**
transparently; (6) keep-alive must do a real ADT round-trip (cheap GET validating cookie+token), refresh
proactively before SAP HTTP session-timeout; (7) wrap idempotent reads in retry-with-backoff (2-3).
Also: warm-up only primes SAP login then logs "first call will be fast" (false) — drive a full end-to-end MCP
round-trip at startup or don't print it.

**Acceptance:** idle 5-15 min, one call returns <2s with no `-32001`/`400`/manual-retry, repeatedly; a 50-call
read sweep (E071K/TBTCO/tables) completes with ZERO transient failures.

---

## Self-testing without human relay
Run the fix session **locally in this repo** with `mcp__abap__` configured (CAR) in its `.mcp.json`. Then it
edits AND tests. To make the inner loop painless:
- Have `customizing_engine_bootstrap` read the engine/report ABAP from `src/abap/*` at call time so ABAP
  iteration = edit file → `bootstrap` → `ping`/`selftest`/`apply`/`read` (no Node restart). For Node tool-logic
  changes, run the server under a file-watcher / auto-restart, or reconnect the MCP server between iterations.
- Bootstrap loop: `connected_systems` (warm) → `customizing_engine_bootstrap` → `customizing_engine_ping` →
  `customizing_selftest --transport CARK900019` → `customizing_apply … commit=true … transport CARK900019` →
  `customizing_status` → verify `E071K`/`manage_transport_requests details`.

## Sandbox state on CAR (for context)
`/POSDW/PROF` has 5 rows: `0001`(CAD), `ZAF1`(ZAR), `ZEU1`(EUR), `9998`, `9997` — `9998`/`9997` written by
earlier tests but **untransported** (E071K empty). Transport/task **`CARK900019`** (modifiable customizing task,
parent request `CARK900018`) is the test target. POSDW config tables (`/POSDW/PROF`/`RETTY`/`TAXTY`/`TENDTY`/
`TRANTY`) are all delivery class `E`; `/POSDW/STORE` is class `A`.
