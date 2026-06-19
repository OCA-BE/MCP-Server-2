# POS Data Management (PIPE) — the Rule framework, and how a check result becomes Warning vs Error

> Grounded on SAP CAR, client 600 (`/POSDW/` POS Data Management / PIPE). Verified live via ADT:
> table contents, DDIC, domain fixed values, and the rule-engine source. Reusable reference for
> configuring how any POS DM **check** (balancing, credit card, duplicate, …) reacts on failure.

## TL;DR — the answer to "make balancing-check failure a Warning, not an Error"

- A **task** that checks something points at a **rule** (`/POSDW/TASKS.RULECODE`).
- The transaction balancing check is **task `0030`** → **rule `0004`** ("Check Balancing of Totals Transactions").
- At runtime the rule evaluates a **condition** (a BAdI), and on the result runs an **action** (a BAdI).
  The action returns an **`ACTIONRESULT`** that decides the transaction's fate.
- **`ACTIONRESULT` domain values** (`/POSDW/ACTIONRESULT`): ` `=No action, **`1`=Retain (hold back)**,
  `2`=Reject, **`3`=Error**, `4`=Not relevant, **`5`=Warning**, `6`=Process.
- The standard "not balanced" action `/POSDW/CL_IM_ACT_ERR_TRBAL` **hardcodes** message type `E` and
  `ACTIONRESULT = '3'` (Error). **There is no delivered Warning action.**
- **To make failure a Warning** you must supply an **action that returns `ACTIONRESULT = '5'`** (and
  raises its message as type `W`), then point the balancing rule's *no* branch at it. This is a small
  BAdI implementation + one rule field change — see [Recipe](#recipe-balancing-failure--warning).

## Where the rule config lives (only one transparent table)

| Object | Class | Role |
|---|---|---|
| `/POSDW/RULES` | **TRANSP** | The rule customizing (the only persisted table) |
| `/POSDW/RULEST` | **TRANSP** | Rule descriptions (texts) |
| `/POSDW/RULE`, `/POSDW/RULET`, `/POSDW/RULERESULT`, `/POSDW/RULE_PARAMETER`, `/POSDW/CONDITION_NO` | `INTTAB` | **Structures** used by the engine at runtime — *not* data tables |

Maintained in SPRO via **SAP Customer Activity Repository → POS Data Management → Define Rules**
(view `/POSDW/V_RULES`) and **Define Parameters for Rules**.

### `/POSDW/RULES` fields (the knobs on a rule)

| Field | Meaning | Check table |
|---|---|---|
| `RULECODE` | rule id (key) | |
| `TYPE` | rule type (see below) — domain `/POSDW/RULETYPE` | |
| `TASKCODE` | for `TYPE=1`: the task whose "done" status is the condition | `/POSDW/TASKS` |
| `CONDITIONFILTER` | filter value selecting the **condition BAdI** implementation | — (BAdI filter) |
| `ACTIONYESFILTER` | filter value → **action BAdI** to run when condition is **fulfilled** | — (BAdI filter) |
| `ACTIONNOFILTER` | filter value → **action BAdI** to run when condition is **NOT fulfilled** | — (BAdI filter) |
| `ASSOCIATION` | for link types: the associated rule code | `/POSDW/V_ARULE` |
| `MAXERRORFLAG` / `MAXERRORNUMBER` / `MAXERRORPERCENT` | error-count tolerance before the rule trips | |
| `PRIORITY` | evaluation order | |
| `PAR_GROUP` | rule parameter group (generic-parameter framework) | `/POSDW/GPAG` |

The condition/action **filter values have no check table** — they are **BAdI filter values**. Conditions
and actions are coded as BAdI implementations (IMG: *BAdI: Implementation of Conditions (Rules)* /
*BAdI: Implementation of Actions (Rules)*, enhancement spots `/POSDW/CONDITION` and `/POSDW/ACTION`).

### Rule TYPE (`/POSDW/RULETYPE`)

`0`=BAdI (call condition BAdI), `1`=Task Completed (condition = "task already done"),
`2`=AND link, `3`=OR link, `4`=NOT link, `5`=Execute all linked rules. Links combine other rules
via `ASSOCIATION`.

### The 5 standard rules (profile-independent — `/POSDW/RULES` is **not** PROFILETYPE-keyed)

| Rule | Text | TYPE | COND | ACTION-NO | Notes |
|---|---|---|---|---|---|
| `0001` | Balanced Transaction | 0 | 0001 | `0010` | per-transaction balancing |
| `0002` | Check Credit Card Data | 0 | 0002 | `0003` | |
| `0003` | Sales Audit Performed | 1 (task `0002`) | | | "is sales-audit task done?" |
| `0004` | **Check Balancing of Totals Transactions** | 0 | 0004 | **`0003`** | **used by task 0030** |
| `0005` | Calc. for Short/Over Balancing Completed | 1 (task `0060`) | | | |

## How a rule runs (the engine)

Function group `/POSDW/CHECK_TRANSACTION`:

- **`/POSDW/CHECK_RULES`** (orchestrator, per task):
  1. read the rule named in the task (`TASKS.RULECODE`);
  2. call `/POSDW/CHECK_RULE` → get `conditionresult` (`X`=yes / ` `=no) + condition messages;
  3. append condition messages to the transaction process log;
  4. pick the action filter: condition **not** fulfilled → `ACTIONNOFILTER`; fulfilled → `ACTIONYESFILTER`.
     **If `ACTIONNOFILTER` is empty, the default is `o_actionresult = '1'` (Retain / hold back).**
  5. if an action filter is set, **`GET BADI` action filtered by it and `CALL BADI`** → the action returns
     **`o_actionresult`** (the outcome) and optional messages.
- **`/POSDW/CHECK_RULE`** (single rule): for `TYPE=0` it `GET BADI`s the **condition** (filtered by
  `CONDITIONFILTER`) and calls it → returns yes/no + messages; for `TYPE=1` it checks whether the task is
  done; for link types it recurses over associated rules with AND/OR/NOT logic. It also counts
  unfulfilled conditions for the later `MAXERROR*` threshold check.

**So the transaction's status/severity = the `ACTIONRESULT` returned by the action BAdI** (condition just
decides yes/no and emits log messages).

## The standard action implementations (BAdI `/POSDW/ACTION`, package `/POSDW/ACTIONS`)

| Class | Effect (returned `ACTIONRESULT`) |
|---|---|
| `/POSDW/CL_IM_ACT_HOLDBACK` | `1` Retain (hold back) |
| `/POSDW/CL_IM_ACT_REJECT` | `2` Reject |
| `/POSDW/CL_IM_ACT_ERROR` | `3` Error (generic) |
| **`/POSDW/CL_IM_ACT_ERR_TRBAL`** | **`3` Error** + message `/POSDW/ACTIONS 010` type **`E`** — the balancing-failure action |
| `/POSDW/CL_IM_ACT_SO_NO_CALC` | Short/Over: no calculation |

`/POSDW/CL_IM_ACT_ERR_TRBAL` in full:

```abap
method /posdw/if_ex_action~call.
  CALL FUNCTION '/POSDW/APPEND_MESSAGE'
    EXPORTING i_messagetype  = 'E'
              i_messageclass = '/POSDW/ACTIONS'
              i_messagenumber = '010'
    CHANGING  ct_message     = ot_message.
  o_actionresult = '3'.  " Error
endmethod.
```

There is **no `...ACT_WARNING` class** — Warning (`5`) is a valid `ACTIONRESULT` but no delivered action
produces it. That is the whole reason this requirement is not pure customizing.

## Recipe: balancing failure → Warning

1. **Create a custom action** — implement the `/POSDW/ACTION` BAdI (SPRO: *BAdI: Implementation of Actions
   (Rules)*). New class, e.g. `Z_CL_IM_ACT_WARN_TRBAL`, implementing `/POSDW/IF_EX_ACTION`:

   ```abap
   method /posdw/if_ex_action~call.
     CALL FUNCTION '/POSDW/APPEND_MESSAGE'
       EXPORTING i_messagetype  = 'W'                 " Warning, not E
                 i_messageclass = '/POSDW/ACTIONS'
                 i_messagenumber = '010'
       CHANGING  ct_message     = ot_message.
     o_actionresult = '5'.  " Warning
   endmethod.
   ```
   Register the implementation with a **new action filter value** (e.g. `Z001`) on the BAdI.

2. **Point the rule at it** — in *Define Rules*, set rule `0004`'s **`ACTIONNOFILTER`** from `0003`
   (the standard Error-balancing action) to your new filter (`Z001`). (Prefer a **Z copy** of the rule +
   task if you want to leave SAP standard untouched, then have task `0030`/your Z-task reference the Z rule.)

3. Result: when a totals transaction does not balance, the condition still detects it, but the action now
   writes a **W** message and returns `ACTIONRESULT 5` → the transaction is flagged **Warning** and keeps
   flowing (not held back / not Error).

> Note: `ACTIONRESULT 1` (Retain/hold-back) and `3` (Error) both stop outbound; `5` (Warning) and
> `6` (Process) let the transaction continue. The default when `ACTIONNOFILTER` is blank is `1` (hold back),
> so simply clearing the action is **not** the way to get a warning.

## Reusability

This `task → rule → condition BAdI → (yes/no) → action BAdI → ACTIONRESULT` chain is the **generic POS DM
check mechanism**. The same recipe changes the reaction of *any* check (duplicate transactions, credit-card,
balanced-transaction `0001`, short/over) — only the rule and its condition/action filters differ. The
outcome vocabulary (`ACTIONRESULT`: Retain/Reject/Error/Warning/Process) is always the lever for severity.

## IMG activities (SPRO → SAP Customer Activity Repository → POS Data Management)

- **Define Rules** — `/POSDW/RULES` (rule wiring: type, condition filter, yes/no action filters, limits)
- **Define Parameters for Rules** — rule parameters (`PAR_GROUP` → generic parameters)
- **BAdI: Implementation of Conditions (Rules)** — enhancement spot `/POSDW/CONDITION`
- **BAdI: Implementation of Actions (Rules)** — enhancement spot `/POSDW/ACTION` (where the custom Warning action goes)
