# POS DTA (POS Data Management, `/POSDW/`) — Customizing Object Schema

Grounded against the live **CAR** system (http://sapcar:8001, client 600), package
`/POSDW/CUSTOMIZING`, 2026-06-09. Built for the customizing engine so it can route
each write through the correct maintenance runtime and record the correct transport
object. **Status: first pass — to be verified for completeness by the user.**

## Discovery entry point — the IMG index (`CUS_IMGACT`)

**The primary way in is the IMG index, not the package.** `CUS_IMGACT` (SPRAS, ACTIVITY,
TEXT) holds the SPRO activity title in each language; joined to `CUS_ACTOBJ` it yields the
maintenance object + type + tcode **across all packages**. This is strictly better than
package enumeration: it returns the real SPRO vocabulary and catches POS objects that live
outside `/POSDW/CUSTOMIZING` (e.g. `V_BWCUS`, `V_AGPE`, `V_BSTSK`, the `LPA_*`
loss-prevention views, `VC_AGLV`).

```sql
SELECT a~activity, a~text, o~objecttype, o~objectname, o~tcode
  FROM cus_imgact AS a INNER JOIN cus_actobj AS o ON o~act_id = a~activity
 WHERE a~spras = 'E' AND a~activity >= '/POSDW/' AND a~activity < '/POSDW/~'
 ORDER BY a~activity                              -- 97 rows for POS DTA
```

> **System query constraint:** this CAR system's ADT SQL endpoint **rejects `LIKE`**
> (even an indexed prefix like `tabname LIKE 'TVKO%'` → HTTP 400), and a leading-wildcard
> scan also times out. **Range comparisons work** (`activity >= … AND activity < …`).
> So the `img_search` tool scopes by namespace **range** and filters the keyword MCP-side.
> Also: IN-list literals are capped at 255 chars and results at 100 rows; no OFFSET.

## How the rest was derived (sources)

| Source | Gives |
|---|---|
| `CUS_IMGACT` (join `CUS_ACTOBJ`) | **IMG index**: activity title → object, OBJECTTYPE (V/S/C/T/D), TCODE |
| `TADIR` (devclass `/POSDW/CUSTOMIZING`) | the object inventory: VIEW / VCLS / TABL / SHLP |
| `DD25L` | view header: AGGTYPE, **ROOTTAB** (base table) |
| `DD26S` | view → member tables (base + text), TABPOS |
| `VCLSTRUC` | view cluster → member views, hierarchy (OBJPOS/OBJLEVEL) |
| `DD02L` | delivery class (CONTFLAG), maint flag |
| `TVDIR` | view → function group (AREA), maint type |

---

## The maintenance patterns (this is the key finding)

`CUS_ACTOBJ.OBJECTTYPE` is the discriminator. Each maps to a different SAP
maintenance runtime **and a different transport object** — the engine must branch on it.
POS DTA uses **five** object types (V/S/C/T/D), with T covering two sub-cases:

| Type | Meaning | Tcode | Transport object | Write runtime (headless) | Engine support |
|---|---|---|---|---|---|
| **V** | maintenance **view** | SM30 | `R3TR VDAT <view>` (base + text table) | `VIEW_MAINTENANCE_SINGLE_ENTRY` (suppressdialog='X') | ✅ done (v0.6.0) |
| **S** | **single table** maintenance | SM30 | `R3TR TABU <table>` | `VIEW_MAINTENANCE_SINGLE_ENTRY` works for a 1-table view too; or direct MODIFY + `TR_OBJECTS_INSERT` TABU | ✅ wired — resolver returns `transport_object='TABU'`, writer records `R3TR TABU` |
| **C** | view **cluster** | SM34 | `R3TR CDAT <cluster>` (expands to each member view) | `VIEWCLUSTER_MAINTENANCE_CALL` / the SC maintenance runtime | ⚠️ partial — member **data** writes via the member view and records as `R3TR VDAT` (correct & transportable). True `R3TR CDAT` **header** recording is implemented in the writer (`record_cdat`) but **dormant**: headless SM34 is dialog-bound, so the MCP layer routes clusters to VDAT instead. Sufficient unless a cluster enforces cross-view header/detail integrity. |
| **T** | **transaction** — custom maint report | e.g. `/POSDW/CUAN_FILTER` | defined by the transaction's own logic | none generic — app-specific | ❌ out of scope **by design** — app-specific, maintain manually |
| **T** | **transaction** — **number range** (`SNUM`) | `/POSDW/SNUM_AGG`, `/POSDW/SNUM_OUT` | `R3TR NROB <nr-object>` (intervals usually **not** auto-transported) | `NUMBER_RANGE_*` FMs / SNRO | ❌ out of scope **by design** — separate NROB path; intervals are usually local-only |
| **D** | **dummy / doc node** — launches a tcode or doc, no maintenance object | e.g. `/POSDW/BC_POS23` | none | n/a | flag & skip |

Examples on CAR: `IMG_0088` "Define Number Range for Two-Step Processing" → **T / SNUM**
(NROB); `IMG_0142` "Integration with POS 2.3" → **D / IMGDUMMY** (just runs a tcode).

Notes:
- A table can be reachable **both** via its own maintenance view (VDAT) **and** as a
  member of a cluster (CDAT). Writing the leaf view records VDAT and is usually fine;
  drive the **cluster** when the cluster enforces header/detail integrity across views
  (e.g. WKLPAR header + value/weight items, GPAN profile groups).
- Some views are **projection layers**: e.g. `V_GPAC2..6` have ROOTTAB `/POSDW/V_GPAC`
  (a view), which itself roots on table `/POSDW/GPAC`. The write resolves through the
  nested view to the transparent base table.

---

## Pattern C — View clusters (SM34 → `R3TR CDAT`)

20 clusters exist in the package; 17 are IMG-registered. Hierarchy from `VCLSTRUC`
(OBJLEVEL = indent; member objects are themselves maintenance views).

| Cluster | IMG activity | Member views (pos: view → root) |
|---|---|---|
| `/POSDW/VC_COMPG` | IMG_0006 | V_COMP→COMP, V_GPAC4→V_GPAC |
| `/POSDW/VC_EXTMAP` | TLOGF_EXTMAP | V_EXTMAP→EXTMAP, V_DPP_EXT→DPP_EXT |
| `/POSDW/VC_FD_PROF` | IMG_136 | V_FD_PROF→FD_PROF, V_FD_PRST→FD_PRST, VFD_PRSTF→FD_PRSTF |
| `/POSDW/VC_GPAN` | (sub-cluster) | V_GPAP→GPAP, V_GPAN→GPAN, V_GPAV→GPAV, V_GPAG, V_GPAGN→GPAGN |
| `/POSDW/VC_GPAN_2` | IMG_0103 | V_GPAP2, V_GPAN, V_GPAV, V_GPAG2, V_GPAGN |
| `/POSDW/VC_GPAN_3` | IMG_0104 | V_GPAP3, V_GPAN, V_GPAV, V_GPAG3, V_GPAGN |
| `/POSDW/VC_GPAN_4` | IMG_0107 | V_GPAP4, V_GPAN, V_GPAV, V_GPAG4, V_GPAGN |
| `/POSDW/VC_GPAN_5` | IMG_0105 | V_GPAP5, V_GPAN, V_GPAV, V_GPAG5, V_GPAGN |
| `/POSDW/VC_GPAN_6` | IMG_0106 | V_GPAP6, V_GPAN, V_GPAV, V_GPAG6, V_GPAGN |
| `/POSDW/VC_ITMS` | (sub-cluster) | V_ITMC, V_ITMS→ITMS |
| `/POSDW/VC_MECC_C` | MULT_ERP | V_MECC_FG→CUSTOM, CLNMAPERP (table) |
| `/POSDW/VC_OTASK` | IMG_0093 | V_OTASK→OTASK, V_GPAC6→V_GPAC |
| `/POSDW/VC_RULESG` | IMG_0005 | V_RULES→RULES, V_GPAC2→V_GPAC |
| `/POSDW/VC_STOGR` | IMG_0135 | V_STOGR→STOGR, V_STOGRC→STOGRC |
| `/POSDW/VC_STO_SO` | IMG_140 | V_STO_SO→STORE, V_TOLOP→TOLOP, V_TOLWST→TOLWST |
| `/POSDW/VC_TASKSA` | IMG_0091 | V_TASKSA→TASKS, V_GPAC5→V_GPAC |
| `/POSDW/VC_TASKSG` | IMG_0007 | V_TASKS→TASKS, V_GPAC3→V_GPAC |
| `/POSDW/VC_TOLSET` | IMG_137 | V_TOLSET→TOLSET, V_TOLPERC→TOLPERC, V_TOLFLAT→TOLFLAT |
| `/POSDW/VC_WKLPAR` | CUS_TASK_EXCL | V_WKLPAR→WKLPAR, V_WKLPARW→WKLPARW, V_WKLPARV→WKLPARV |

(`VC_GPAN`, `VC_ITMS` exist as clusters but aren't directly IMG-registered — used as
building blocks / reached through the numbered variants.)

---

## Pattern S — Single-table maintenance (SM30 → `R3TR TABU`)

| Table | IMG activity | Delivery class |
|---|---|---|
| `/POSDW/CLNTMAP` | CLNTMAP | C |
| `/POSDW/CUAN_ITYP` | DEFINTFILT | E |
| `/POSDW/EXTMAP` | ZTEST | C |
| `/POSDW/MAPFDCODE` | MAPFDCODE | E |

## Pattern T — Transaction maintenance (custom, not SM30/SM34)

| Object | Tcode | IMG activity |
|---|---|---|
| `/POSDW/CUAN_FILTER` | `/POSDW/CUAN_FILTER` | DEFINTFILT |

---

## Pattern V — Maintenance views (SM30 → `R3TR VDAT`)

The bulk of POS config. Each view → ROOTTAB (transparent base table, delivery class
mostly **E** control table; text table resolved via DD26S). Selected/representative —
full list of ~70 views is in `DD25L` (join TADIR, devclass `/POSDW/CUSTOMIZING`,
object VIEW).

| View | Root table | IMG activity | Config area |
|---|---|---|---|
| `/POSDW/V_PROF` | `/POSDW/PROF` (+ PROFT) | IMG_0001 | **POS Workbench profile** |
| `/POSDW/V_STORE` | `/POSDW/STORE` | IMG_0002 | Store / business unit |
| `/POSDW/V_DEFLT` | `/POSDW/DEFLT` | IMG_0004 | Default values |
| `/POSDW/V_TRANTY` | `/POSDW/TRANTY` | IMG_0012 | Transaction types |
| `/POSDW/V_TRANTG` | `/POSDW/TRANTG` | IMG_0011 | Transaction type groups |
| `/POSDW/V_RETTY` | `/POSDW/RETTY` | IMG_0014 | Receipt/return types |
| `/POSDW/V_RETTG` | `/POSDW/RETTG` | IMG_0013 | Receipt type groups |
| `/POSDW/V_TAXTY` | `/POSDW/TAXTY` | IMG_0018 | Tax types |
| `/POSDW/V_TAXTG` | `/POSDW/TAXTG` | IMG_0017 | Tax type groups |
| `/POSDW/V_TENDTY` | `/POSDW/TENDTY` | IMG_0020 | Tender types |
| `/POSDW/V_TENDTG` | `/POSDW/TENDTG` | IMG_0019 | Tender type groups |
| `/POSDW/V_DISCTY` | `/POSDW/DISCTY` | IMG_0016 | Discount types |
| `/POSDW/V_FITY` | `/POSDW/FITY` | IMG_0022 | Financial transaction types |
| `/POSDW/V_GMTY` | `/POSDW/GMTY` | IMG_0024 | Goods movement types |
| `/POSDW/V_REASON` | `/POSDW/REASON` | IMG_0026 | Reason codes |
| `/POSDW/V_MSGCAT` | `/POSDW/MSGCAT` | IMG_0027 | Message categories |
| `/POSDW/V_MSG` | `/POSDW/MSG` | IMG_0028 | Messages |
| `/POSDW/V_TASKS` | `/POSDW/TASKS` | (in clusters) | Tasks (also via VC_TASKS*) |
| `/POSDW/V_TASKG` | `/POSDW/TASKG` | IMG_0009 | Task groups |
| `/POSDW/V_TGTASK` | `/POSDW/TGTASK` | IMG_0010 | Task-group assignment |
| `/POSDW/V_INBPROF` | `/POSDW/INB_PROF` | IMG_0123 | Inbound profile |
| `/POSDW/V_SOPROF` | `/POSDW/SOPROF` | IMG_138 | Store-order profile |
| `/POSDW/V_SECPROF` | `/POSDW/SEC_PROF` (+ T) | IMG_SECPRF_01 | Security profile |
| `/POSDW/V_CHKPROF` | `/POSDW/CHK_PROF` | IMG_CHKPRF_01 | Check profile |
| `/POSDW/V_LOYALTY` | `/POSDW/LOYALCUST` | IMG_LOYALTY | Loyalty customer |
| `/POSDW/V_WFM_CAT` | `/POSDW/WFM_MCAT` | IMG_WFM_CAT | Workforce mgmt category |
| `/POSDW/V_WFM_INT` | `/POSDW/WFM_INT` | IMG_WFM_GEN | Workforce mgmt integration |
| `/POSDW/V_OOCL2` | `/POSDW/OOCL2` | IMG_0035 | Outbound object class |
| `/POSDW/V_MRPFR` | `/POSDW/MRPFR` | IMG_0033 | MRP filter |
| `/POSDW/V_BADIPA` | `/POSDW/BADIPA` | IMG_0029 | BAdI parameters |

The `VV_TYCCRIT_*` / `VV_EXTCTYC_*` view families (IMG_0108–0121) are the
**typecode-criteria** and **external-typecode** maintenance views, rooting on
`/POSDW/TYCCRIT` and `/POSDW/EXTCTYC` respectively — one SM30 view per type dimension
(RETTY/TAXTY/TNDTY/TXNTY/DISTY/FITY/GMTY).

---

## Engine status against this schema (updated 2026-06-12, engine v0.9.11)

1. **V (VDAT)** — ✅ built & wired (v0.6.0). Resolve table→view→single-entry write.
2. **S (TABU)** — ✅ wired. The resolver returns `transport_object='TABU'` for single-table
   maintenance (`customizing.ts`: `recordObject = view ? "VDAT" : singleTable ? "TABU"`) and
   the writer records `R3TR TABU <table>`.
3. **C (CDAT)** — ⚠️ partial. Cluster **member data** is written through the member view and
   recorded as `R3TR VDAT` — correct and transportable for the common case. The writer also
   contains a true-CDAT recorder (`record_cdat`: `R3TR CDAT` header + member `TABU` keys via
   `TR_OBJECTS_INSERT`), but it is **dormant** because headless SM34 is dialog-bound, so the
   MCP layer deliberately routes clusters to VDAT. **Remaining gap:** activate true `R3TR CDAT`
   header recording for clusters that enforce cross-view header/detail integrity (WKLPAR,
   GPAN groups, tolerance sets) — currently the only known limitation, with a working VDAT
   fallback.
4. **T** — ❌ out of scope by design (app-specific maintenance reports, number ranges); flag
   to the user to maintain manually.

**Resolver** (`resolveMaint()`) resolves table↔view, looks up `CUS_ACTOBJ.OBJECTTYPE` to pick
V/S/C/T, and detects cluster membership (`VCLSTRUC.OBJECT = <view>`).
