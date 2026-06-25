# SAP CS/PM Service Order Process — Configuration Guide

Customizing reference for the **Plant Maintenance (PM) / Customer Service (CS)** service-order
process on an S/4HANA system, driven headlessly via the **abap-config-mcp** in-system engine.
Follows the same table-grounded, IMG-linked style as the retail and POS-DTA config guides.

---

## What a service order is

A **PM/CS service order** (`AUFK`, `AFKO`) is an internal or customer-facing work order that:

- captures labour, materials and services consumed during maintenance or repair,
- drives settlement of costs to a cost object (cost centre, WBS, contract, …), and
- optionally integrates with SD for customer billing (service-product items, billing plan).

Order types gate every behaviour: which settlement rule is allowed, whether a billing document
is created, which catalogs apply, and so on. Most customizing is therefore per **order type**.

---

## Configuration sequence (dependency order)

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

## Step-by-step details

### 1. Maintenance planning plant

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

### 2. Order types (`T003O`)

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

### 3. Settlement parameters (`TOCS`)

Settlement parameters define how order costs are settled (percentage vs. equivalence numbers,
allowed cost-object categories). One record per order-type / plant combination.

Key table: `TOCS` — fields `AUART` + `WERKS` (key), `ABKRS` (settlement profile).

> The settlement profile itself lives in CO customizing (`T811A`); the `TOCS` record just
> assigns a profile to the order-type/plant combination.

### 4. Notification types

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

### 5. Catalogs, code groups and codes

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

### 6. Activity types and work centres

PM work centres (`T024W`, CAPP) are cross-client master data; activity types (`KA01` in CO)
are client-dependent. The linkage:

- `CRHD` (work centre header) → `CRCO` (cost centre assignment) → CO activity type.
- Activity type unit governs how labour confirmations are posted.

Work-centre categories (cross-client config, not transported as customizing) are in `T006`.

### 7. Partner functions

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

### 8. SD integration — service products and order types

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

### 9. Billing plan type (for service contracts)

For periodic billing (maintenance contracts), a billing plan type is assigned to the SD item
category. Key tables:

| Table | Content |
|---|---|
| `TFPLA` | Billing plan type |
| `TFPLT` | Billing plan type texts |
| `TFPLP` | Billing plan type ↔ item category |

---

## Using the MCP tools

### Discovery

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
