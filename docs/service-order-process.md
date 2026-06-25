# SAP Service Order Process — Configuration Guide

Customizing reference for service-order processes on S/4HANA, covering **both** the
recommended greenfield path and the legacy brownfield path. Driven headlessly via the
**abap-config-mcp** in-system engine. Follows the same table-grounded, IMG-linked style
as the retail and POS-DTA config guides.

---

## ⚠️ Greenfield recommendation: use S/4HANA Service Management, not classic CS

> **For any greenfield S/4HANA implementation SAP's official recommendation is to use
> S/4HANA Service Management** (module `S4SM`, formerly "Advanced Service Management" /
> "CRM-based Service") **instead of the classic Customer Service (CS) component.**

Classic CS (`IW31`/`IW32`, PM order type `SM*`) is still shipped and supported, but SAP
positions it as **legacy** for customer-facing service processes. The CRM-based engine is
the strategic product and receives all new feature investment (Field Service & Dispatch
Management, Subscription Billing, Outcome-Based Service, S/4HANA Cloud parity).

### When to use which

| Scenario | Recommended path |
|---|---|
| **Greenfield** — new S/4HANA system, customer-facing service | **S/4HANA Service Management** (CRM-based, `S4SM`) |
| **Greenfield** — internal plant maintenance only, no customer billing | Classic PM (`PM01`/`PM02`) — still the standard path for pure maintenance |
| **Brownfield / system conversion** from ECC with existing CS customizing | Classic CS can be retained; migration to S4SM is a separate project |
| **Two-tier** (S/4HANA Cloud Public Edition) | S/4HANA Service is the only option (classic CS is not available in PCE) |

---

## Part A — S/4HANA Service Management (CRM-based, greenfield path)

### What it is

S/4HANA Service Management is built on the S/4HANA embedded CRM foundation
(`CRM_S4`, formerly "SAP CRM on S/4HANA"). Its core objects are:

| Object | Transaction / app | Description |
|---|---|---|
| **Service Order** | `SMEN_UI_SRVO` / Fiori "Manage Service Orders" | The central work document (replaces CS order `IW31`) |
| **Service Request** | Fiori "Manage Service Requests" | Inbound request / ticket (replaces PM notification) |
| **Service Contract** | Fiori "Manage Service Contracts" | Periodic / value-based agreements |
| **Installed Base** | Fiori "Manage Installed Bases" | Replaces PM functional location / equipment hierarchy |

### Key organisational objects

| Object | Table / domain | Meaning |
|---|---|---|
| **Service Organisation** | `CRMD_ORGMAN` / `HRP1000` (org unit) | The org unit that performs service (maps to a company code + plant) |
| **Service Team** | `HRP1001` (org unit relationship) | Group within the service org |
| **Business Partner** | `BUT000` / `KNA1` | Customer, sold-to, requester |
| **Product (service)** | `MARA` (`MTART='DIEN'`) | Service product billed on the order |

S/4HANA Service uses the **HR organisational model** (`PPOC_OLD`, OM-module) for its
service organisation, not the classic PM planning-plant model.

### Key customizing tables (S4SM)

All are delivery class `C` and can be read / described / copied via the engine.

| Table | IMG path | Content |
|---|---|---|
| `CRMC_PROC_TYPE` | Customer Management → Transactions → Define Transaction Types | **Transaction types** (service-order type, service-request type, contract type) — the S4SM equivalent of PM order types |
| `CRMC_PROC_TYPET` | — | Transaction type texts |
| `CRMC_ITEM_CAT` | … → Item Categories → Define Item Categories | Item categories (spare parts, labour, travel) |
| `CRMC_ITEM_CAT_A` | … → Item Categories → Assign Item Categories | Item-category determination (transaction type + item type → item category) |
| `CRMC_PARTNER_FCT` | … → Partner Processing → Define Partner Functions | Partner functions (sold-to, contact, service engineer) |
| `CRMC_PARF_PROC` | … → Partner Processing → Define Partner Determination Procedure | Partner determination procedures |
| `CRMC_STATUS_PRO` | … → Status Management → Define Status Profile | Status profiles (open, in process, completed, …) |
| `CRMC_ORGMAN` | … → Organisational Management | Service organisation structure assignment |
| `CRMC_BPGRP` | … → Business Partner → Define BP Groupings | BP groupings used for service partners |

Inspect transaction types on the live system:

```sql
SELECT process_type, ddtext, process_mode
  FROM crmc_proc_type
 ORDER BY process_type
```

Describe the maintenance object for a transaction-type table:

```
customizing_describe table: "CRMC_PROC_TYPE"
```

Copy a delivered transaction type into a custom Z-type:

```
customizing_apply
  table: "CRMC_PROC_TYPE"
  action: "copy"
  sourceKey: "SRVP"
  targetKey: "ZSRV"
  transport: "DEVK900NNN"
  commit: true
```

> **Note:** `SRVP` is the standard S/4HANA Service service-order transaction type.
> Verify the delivered key on your box with `customizing_read table: "CRMC_PROC_TYPE"`.

### Item categories — the service product link

In S4SM, an **item category** (not a PM work-centre activity) drives how a line is
costed and billed. Key item-category types for service:

| Item category | Meaning |
|---|---|
| `SRVO` | Service (labour / activity) |
| `SRVP` | Spare part / product |
| `SRVT` | Travel |

The item-category determination (`CRMC_ITEM_CAT_A`) maps:
`transaction type` + `item object type` → `item category`.

### SLA / response times

Response profile tables (class `C`, engine-writable):

| Table | Content |
|---|---|
| `CRMC_SLA_PROF` | Response profile header |
| `CRMC_SLA_PROF_T` | Response profile texts |
| `CRMC_SERV_PROF` | Service profile (calendar + response profile) |

### Settlement and billing

S/4HANA Service uses **Revenue Accounting and Reporting (RAR)** or **SD billing**
depending on the contract type:

- **Time & Material orders**: items are billed directly via SD (billing request → SD billing
  document); the `CRMC_PROC_TYPE.BILLING_TYPE` field controls which SD billing type is used.
- **Fixed-price / periodic contracts**: billing plan on the service contract; same
  `TFPLA` / `TFPLP` tables as classic SD.
- **Outcome-based / subscription**: requires RAR (module `FARR`).

---

## Part B — Classic CS/PM (legacy / brownfield path)

> Use this path only when **retaining existing ECC/CS customizing** in a system
> conversion, or for **pure internal plant maintenance** (no customer billing).
> For greenfield customer-facing service, use Part A above.

### What a classic service order is

A **PM/CS service order** (`AUFK`, `AFKO`) is an internal or customer-facing work order that:

- captures labour, materials and services consumed during maintenance or repair,
- drives settlement of costs to a cost object (cost centre, WBS, contract, …), and
- optionally integrates with SD for customer billing (service-product items, billing plan).

Order types gate every behaviour: which settlement rule is allowed, whether a billing document
is created, which catalogs apply, and so on. Most customizing is therefore per **order type**.

---

### Configuration sequence (dependency order) — classic CS/PM

| # | Step | Object / table | IMG path |
|---|---|---|---|
| 1 | **Maintenance planning plant** | `T001W` (plant), `T399A` (planning-plant config) | Plant Maintenance → Master Data → Technical Objects → Define Maintenance Planning Plant |
| 2 | **Order types** | `T003O` | PM/CS → Maintenance Orders → Order Types → Define Order Types |
| 3 | **Order type ↔ plant assignment** | `TOCS` (settlement parameters per order type / plant) | … → Order Types → Define Settlement Parameters |
| 4 | **Notification types** | `T356` (priority types), `QMLG` (notification type config) | PM/CS → Notifications → Notification Types → Define Notification Types |
| 5 | **Catalogs & code groups** | `T370` (catalog header), `T370A` (code groups), `T370C` (individual codes) | … → Notifications → Notification Creation → Set Up Catalogs |
| 6 | **Activity types / work-centre categories** | `KA01` (CO activity types via AM), `V_TC24` (work-centre category), `T006` (units) | Controlling → Cost Centre Accounting → Master Data → Activity Types |
| 7 | **Partner functions** | `TVPT` (partner function), `TVPB` (partner determination procedure), `TVPBT` (texts) | PM/CS → Notifications → Partner Determination → … |
| 8 | **SD integration — service products** | `MARA`/`MVKE` (material master), `TVAK` (SD order/contract type) | PM/CS → Customer Service → Service Order Management → Integration SD |
| 9 | **Billing plan type** (for contracts) | `TFPLA` (billing plan type), `TFPLP` (billing plan types per item category) | SD → Billing → Billing Plans → Define Billing Plan Types |

---

### Step-by-step details

#### 1. Maintenance planning plant

Every service order is assigned to a **planning plant** — the organisational unit that maintains
the technical objects and work centres.

Key table: `T399A` — the planning plant's configuration record (ties `T001W.WERKS` to its settings).

```sql
SELECT werks, name1, vkorg
  FROM t001w
 WHERE werks IN ('Z100', '…')
```

Headless via engine: storage locations and plant-level parameters are set through
`customizing_create` / `customizing_apply` against `T001W`, `T001K`, and `T399A`.

#### 2. Order types (`T003O`)

Order types are the primary configuration gate. Delivered examples:

| AUART | AUTYP | Description |
|---|---|---|
| `PM01` | PM | Preventive maintenance |
| `PM02` | PM | Corrective maintenance |
| `SM01` | CS | Service order (customer) |
| `SM02` | CS | Service order (in-house repair) |

Key fields in `T003O`:

| Field | Meaning |
|---|---|
| `AUART` | Order type (key) |
| `AUTYP` | Order category (`05`=PM, `06`=CS in older releases; blanks differ by version) |
| `ILEVL` | Initial priority |
| `KALSM` | Costing sheet |
| `PABKR` | Settlement profile |
| `PRKOS` | Default account-assignment category |
| `ANLKL` | Asset class (for investment orders) |

Inspect on the live system:

```sql
SELECT auart, bezei, autyp, pabkr
  FROM t003o
 WHERE autyp IN ('PM', 'CS')
 ORDER BY auart
```

To copy an existing order-type row into a custom Z-type (`ZM01`) via the engine:

```
customizing_apply
  table: "T003O"
  action: "copy"
  sourceKey: "PM01"
  targetKey: "ZM01"
  transport: "DEVK900NNN"
  commit: true
```

#### 3. Settlement parameters (`TOCS`)

Settlement parameters define how order costs are settled (percentage vs. equivalence numbers,
allowed cost-object categories). One record per order-type / plant combination.

Key table: `TOCS` — fields `AUART` + `WERKS` (key), `ABKRS` (settlement profile).

> The settlement profile itself lives in CO customizing (`T811A`); the `TOCS` record just
> assigns a profile to the order-type/plant combination.

#### 4. Notification types

A **PM/CS notification** (`QMEL`) precedes or accompanies a service order. Notification types
group the breakdown/malfunction/service-request variants. Customizing lives in a mix of tables:

| Table | Content |
|---|---|
| `T356` | Priority types (used by both PM notifications and QM) |
| `T357H` | Notification type header settings (partner, screen layout flags) |
| `T357Q` | Object part/damage catalog assignment per notification type |
| `T357S` | Response time profiles |

Inspect delivered notification types:

```sql
SELECT qmart, kurztext, qmkat
  FROM t357h
 ORDER BY qmart
```

#### 5. Catalogs, code groups and codes

PM/CS catalogs (`T370` / `T370A` / `T370C`) are the pick-lists for damage, cause, task, and
activity codes on notifications and confirmations.

| Table | Delivery class | Content |
|---|---|---|
| `T370` | C | Catalog type (key `KATALOGART`) — e.g. `B`=damage, `C`=cause, `5`=tasks |
| `T370A` | C | Code group (KATALOGART + CODEGRUPPE) |
| `T370B` | C | Code group texts |
| `T370C` | C | Individual codes (KATALOGART + CODEGRUPPE + CODE) |
| `T370D` | C | Code texts |

All four are class `C` (customizing), so the engine records them on a Customizing transport.

Example — describe catalog-code table to see the maintenance object:

```
customizing_describe table: "T370C"
```

Create a Z code group for task catalog `5`:

```
customizing_create
  table: "T370A"
  rows: [{ KATALOGART: "5", CODEGRUPPE: "ZRET", KURZTEXT: "Retail service tasks" }]
  transport: "DEVK900NNN"
  commit: true
```

#### 6. Activity types and work centres

PM work centres (`T024W`, CAPP) are cross-client master data; activity types (`KA01` in CO)
are client-dependent. The linkage:

- `CRHD` (work centre header) → `CRCO` (cost centre assignment) → CO activity type.
- Activity type unit governs how labour confirmations are posted.

Work-centre categories (cross-client config, not transported as customizing) are in `T006`.

#### 7. Partner functions

Partner functions on service orders/notifications drive who is notified, who must approve, and
who is billed. Configuration sits in:

| Table | Content |
|---|---|
| `TVPT` | Partner function definition |
| `TVPB` | Partner determination procedure |
| `TVPBT` | Procedure texts |
| `TVPPA` | Procedure ↔ partner function assignment |
| `TVPPP` | Object ↔ partner determination procedure assignment (e.g. order type → procedure) |

All are class `C` — transport-recorded via the engine.

#### 8. SD integration — service products and order types

When a CS service order is to be **billed to a customer**, it needs:

1. A **service material** (`MARA.MTART = 'DIEN'`, industry sector `D` or `M`).
2. Sales-org views (`MVKE`) for the relevant sales orgs / distribution channels.
3. An **SD order type** (`TVAK.AUART`) or service-contract type that triggers billing.
4. An item-category determination (`TVAP`, `T184`) that routes the service line to billing.

Inspect SD service document types already in the system:

```sql
SELECT auart, bezei, autyp
  FROM tvak
 WHERE autyp IN ('G', 'TA', 'WA')   -- contracts, orders, returns
 ORDER BY auart
```

> **Note:** Creating service materials via this MCP engine is blocked by the same
> article-validation rules as retail articles — use the Migration Cockpit
> ("Migrate Your Data" → Product) for bulk loads; use `MM01`/`MM41` for one-off creation.

#### 9. Billing plan type (for service contracts)

For periodic billing (maintenance contracts), a billing plan type is assigned to the SD item
category. Key tables:

| Table | Content |
|---|---|
| `TFPLA` | Billing plan type |
| `TFPLT` | Billing plan type texts |
| `TFPLP` | Billing plan type ↔ item category |

---

## Using the MCP tools

### Discovery — S/4HANA Service (Part A)

```
img_search keyword: "service order"               # S4SM IMG activities
img_search keyword: "transaction type"
customizing_describe table: "CRMC_PROC_TYPE"      # maintenance object, key fields, transport object
customizing_read table: "CRMC_PROC_TYPE"          # all transaction types in the system
customizing_read table: "CRMC_ITEM_CAT"           # item categories
```

### Discovery — classic CS/PM (Part B)

```
img_search keyword: "service order"          # find IMG activities
img_search keyword: "notification type"
customizing_describe table: "T003O"          # maintenance object, key fields, transport object
customizing_read table: "T003O"              # all rows in the system
```

### Inspect existing config

```
customizing_diff table: "T003O" sourceKey: "PM01" targetKey: "ZM01"   # what differs?
customizing_plan_change table: "T003O" sourceKey: "PM01" targetKey: "ZM01"  # dry-run
```

### Apply config

```
# Copy order type PM01 → ZM01 (dry-run first, then commit: true)
customizing_apply table: "T003O" action: "copy"
  sourceKey: "PM01" targetKey: "ZM01"
  transport: "DEVK900NNN"
  commit: false   # preview

# Create catalog code group
customizing_create table: "T370A"
  rows: [{ KATALOGART: "5", CODEGRUPPE: "ZRET", KURZTEXT: "Retail service tasks" }]
  transport: "DEVK900NNN"
  commit: true
```

---

## Delivery-class reference for key tables

### S/4HANA Service (Part A)

| Table | Class | Headless path | Transport object |
|---|---|---|---|
| `CRMC_PROC_TYPE` | `C` | SM30 view `CRMC_PROC_TYPE` | `R3TR VDAT CRMC_PROC_TYPE` |
| `CRMC_ITEM_CAT` | `C` | SM30 view `CRMC_ITEM_CAT` | `R3TR VDAT CRMC_ITEM_CAT` |
| `CRMC_ITEM_CAT_A` | `C` | SM30 view `CRMC_ITEM_CAT_A` | `R3TR VDAT CRMC_ITEM_CAT_A` |
| `CRMC_PARTNER_FCT` | `C` | SM30 view `CRMC_PARTNER_FCT` | `R3TR VDAT CRMC_PARTNER_FCT` |
| `CRMC_PARF_PROC` | `C` | SM30 view `CRMC_PARF_PROC` | `R3TR VDAT CRMC_PARF_PROC` |
| `CRMC_STATUS_PRO` | `C` | SM30 view `CRMC_STATUS_PRO` | `R3TR VDAT CRMC_STATUS_PRO` |
| `CRMC_SLA_PROF` | `C` | SM30 view `CRMC_SLA_PROF` | `R3TR VDAT CRMC_SLA_PROF` |

### Classic CS/PM (Part B)

| Table | Class | Headless path | Transport object |
|---|---|---|---|
| `T003O` | `C` | `VIEW_MAINTENANCE_SINGLE_ENTRY` via `V_T003O` | `R3TR VDAT V_T003O` |
| `TOCS` | `C` | SM30 view `VC_TOCS` | `R3TR VDAT VC_TOCS` |
| `T370` | `C` | `V_T370` | `R3TR VDAT V_T370` |
| `T370A` | `C` | `V_T370A` | `R3TR VDAT V_T370A` |
| `T370C` | `C` | `V_T370C` | `R3TR VDAT V_T370C` |
| `TVPT` | `C` | `V_TVPT_PM` (PM version) | `R3TR VDAT V_TVPT_PM` |
| `TVAK` | `C` | `V_TVAK` | `R3TR VDAT V_TVAK` |
| `TFPLA` | `C` | `V_TFPLA` | `R3TR VDAT V_TFPLA` |
| `T399A` | `C` | `V_T399A` | `R3TR VDAT V_T399A` |

> Run `customizing_describe table: "<TABLE>"` to get the live maintenance object and transport
> object for any of these — the answer is read from the live DDIC and is release-independent.

---

## Open items / known limits

### S/4HANA Service (Part A)
- **HR org-model creation** (service organisation, service team) is managed through `PPOC_OLD`
  (Org. Management) — master data, not customizing; not yet covered by a headless engine path.
- **Business Partner creation** for service customers: use `BAPI_BUPA_CREATE_FROM_DATA`
  in a background-job pattern (same approach as the retail site-BP creation).
- **Fiori service activation** (OData services, IAM roles for the "Manage Service Orders" app):
  requires `STC01` task list or `/IWFND/V4_ADMIN` — GUI-only, not an engine write.
- **RAR / subscription billing** configuration is outside the customizing-engine scope.

### Classic CS/PM (Part B)
- **Number ranges for PM orders** (`INRO` object `PM_AUFNR`): maintained via SNRO/`NUMBER_RANGE_*`
  FMs; not supported by the current engine (NROB path is out of scope — see
  [pos-dta-customizing-schema.md](pos-dta-customizing-schema.md)).
- **Work centre creation** (`CRHD`/`CAPP`) is master-data, not customizing — use `CA01`/`IR01`
  or a BAPI (`BAPI_WORKORDER_CREATE`) in a background-job pattern.
- **Service material creation**: use Migration Cockpit or `MM01` — the MCP write path is blocked
  by article/material field-reference validation (same constraint as IS-Retail articles).
- **SD ↔ CS integration config** (object-link type, repair procedure) involves view clusters
  (`SM34`). The engine writes member-view data correctly; true `R3TR CDAT` recording is dormant
  (see [customizing-engine.md § Known limits](customizing-engine.md)).
- **Org-unit copy for PM/CS plants** (`org_copy`, `ECOP_ORG_UNITS_IN_THE_DARK`) supports
  `WERKS` (plant) copies end-to-end; always run in a background job (`STRTIMMED`) so
  number-range and FI after-copy logic execute batch-safely.
