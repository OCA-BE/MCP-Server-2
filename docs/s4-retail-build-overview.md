# S/4HANA Retail build — overview (A4H, client 250)

Concise inventory of the IS-Retail **customizing + master data** created on the demo
system, and **how** each layer was built. Most of it is headless via the
**abap-config-mcp** in-system engine; a few steps used guided GUI/cockpit where the
box requires interactive dialogs. Companion detail: [retail-master-data-playbook.md](retail-master-data-playbook.md).

System: **A4H / client 250**, S/4HANA 2025 (SAP_BASIS 816 / S4CORE 109), IS-Retail active.

---

## 1. Enterprise structure (customizing)
| Object | Values | How |
|---|---|---|
| Company | **ZRET** (T880, EUR) | engine value-override (V_T880) |
| Company codes | **Z100** Belgium/EUR · **Z200** South Africa/ZAR · **Z300** Lesotho/LSL (RCOMP=ZRET, YCOA) | **headless EC01 org-copy** (`org_copy` → ECOP_ORG_UNITS_IN_THE_DARK) + T001 patches |
| Purchasing org | **Z100** (cross-company); groups 001–003 | engine |
| Sales orgs | **BE01**→Z100 · **ZA01**→Z200 · **LS01**→Z300 | headless org-copy |
| Distribution channels | **10** Retail · **20** Wholesale | org-copy + texts |
| Divisions | **01** Food · **02** Non-Food (+ 00 common) | org-copy + texts |
| Sales areas | org × channel × division (TVTA/TVKOV/TVKOS) | engine |
| LS tax procedure | **0TXZA** (T005-KALSM, OBBG / V_005_E) | engine |

## 2. Merchandise categories (customizing)
6 MCs — Food (div 01): **0101** Dairy · **0102** Bakery · **0103** Beverages; Non-Food (div 02): **0201** Electronics · **0202** Clothing · **0203** Household.
Each = T023 + T023T + class type 026. Built headless via **`MERCHANDISE_GROUP_MODIFY`** ($TMP report + AUnit-scheduled job).

## 3. Sites / plants (master data) — 12
| Country (CC) | Stores (VLFKZ A) | DCs (VLFKZ B) |
|---|---|---|
| Belgium (Z100) | GHST Ghent, ANST Antwerp | GHDC, ANDC |
| South Africa (Z200) | CTST Cape Town, JBST Johannesburg | CTDC, JBDC |
| Lesotho (Z300) | MSST Maseru, TYST Teyateyaneng | MSDC, TYDC |

- **Site BPs + CVI customers:** headless (`BAPI_BUPA_CREATE_FROM_DATA` + roles FLCU00/FLCU01 → KNA1).
- **Sites (T001W/T001K):** headless-generated **WB01 batch-input session `ZSITES`**, processed in **SM35 foreground** (pure `CALL TRANSACTION` dumps on a GUI control). See [[wb01-bdc-headless]].

## 4. Storage locations (master data) — 36
`T001L` 0001/0002/0003 per site — DC = Goods Receipt / Picking / Bulk; Store = Sales Floor / Back Room / Returns. Headless via engine **`customizing_create`** (composite key WERKS+LGORT, per-row values).

## 5. Assortments (master data)
- **12 local** assortments — auto-created with the sites (WRS1 SOTYP **A** store / **B** DC).
- **3 general** — **BE_STD** (BE01/10) · **ZA_STD** (ZA01/10) · **LS_STD** (LS01/10) (WRS1 SOTYP **C**). Engine `customizing_create`.
- **Site assignments (WRSZ):** each general ← its 4 sites (stores SONUT A, DCs SONUT B). Engine.
- **MC dimension (WRS6):** each general × 5 MCs (0101/0102/0103/0201/0202) @ assortment grade **1**. Set in **WSOA2** (GUI).

## 6. Articles (master data) — 5 retail articles
Internal MATNR **156–160**, **ATTYP=00** (retail single articles), MBRSH=1, base UoM EA:
| MATNR | Article | Type | MC |
|---|---|---|---|
| 156 | Milk | FOOD | 0101 |
| 157 | Bread | FOOD | 0102 |
| 158 | Television | HAWA | 0201 |
| 159 | Shirt | HAWA | 0202 |
| 160 | Coffee | FOOD | 0103 |

- Sales views (MVKE) for **BE01/ZA01/LS01 × ch 10**; `LSTFL`/`LSTVZ` = **Z1**, `SSTUF` = 1; loading group `WLADG` = 0003.
- Loaded via **Migration Cockpit "Migrate Your Data" → Product object** (ATTYP=00 essential; load files in [retail-samples/](retail-samples/)). The headless BAPI route is blocked by the article field-reference rules on this box.

## 7. Listing
- **Custom listing procedure `Z1`** (TWLV) — profile-only (`FOLGE1=P`) + `STDVF` auto-list; **no** classification (K) or price (VKP) checks (avoids WM 589/127 on a box without MC classification or prices). Headless `customizing_create`.
- **Listing conditions (WLK1):** 5 articles × 3 general assortments = **15**. ⚠️ **Written directly as a stopgap** — the standard listing engine's parallel WLK1 write logs success but doesn't persist on this box. See [[retail-listing-prereqs]].

## Open items
- **#20** — merchandise-category reference materials (ATTYP 30) per MC, to clear `MH005` (assign in WG22).
- **#21** — make listing persist via the **standard system** (replace the WLK1 direct-write stopgap); the parallel WLK1 commit is defective on this box.

## Tooling used
| Layer | Tool / method |
|---|---|
| Enterprise structure, MCs, slocs, assortments, listing procedure | abap-config-mcp **in-system engine** (`customizing_apply`, `customizing_create`, `org_copy`) |
| Site BPs | headless BAPI in a `$TMP` report + background-job pattern |
| Sites | headless-generated **WB01 BDC** → SM35 foreground |
| Articles | **Migration Cockpit** (Fiori "Migrate Your Data") |
| Assortment MC dimension, article procedure/grade, Fiori service activation | GUI (`WSOA2`, `MM42`, `/IWFND/V4_ADMIN`, `STC01`) |
