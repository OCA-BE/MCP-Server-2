# Migration Cockpit — "Product" object, filled example (5 retail articles)

A complete, **filled** source-data set for the Migration Cockpit **Product** migration object
("Migrate Your Data" → Staging Tables project), used to create the 5 sample retail articles on
the IS-Retail demo build. Keep this as the template for **creating new articles** — it shows
exactly which sheets to fill and in what shape. See the playbook §0 (loading sequence) and §4.3.

## How to use
1. Re-zip this folder (the cockpit upload is a ZIP whose top folder holds the `S_*.csv` sheets):
   `zip -r "Source data for Product.zip" product-migration-example` (rename the inner folder to
   `Source data for Product` if your project expects that name).
2. In the cockpit: add the **Product** object → **Download Template** once to confirm the sheet
   layout matches your release → **Upload File** → Prepare → Simulate → Migrate.

## Which sheets are filled (the rest are empty template sheets, re-downloadable)
| Sheet | Purpose | Filled with |
|---|---|---|
| `S_MARA#FreeText_Mandatory` | basic data | `PRODUCT`, `MTART`, **`MBRSH=1`** (Retail), `MATKL` (merch. cat.), `MAKTX`, `SPRAS`, `MEINS`, `SPART`, **`EAN11`+`NUMTP`** (main GTIN) |
| `S_MVKE` | **sales views** | one row per **sales org × channel** (BE01/ZA01/LS01 × 10), `VRKME=EA`, **`MTPOS=NORM`** — **required** or the article is basic-only and can't be listed |
| `S_MLAN` | tax classification | per departure country; use the box's real tax category (`TSTL` — here `TTX1`, not `MWST`) |

## Key gotchas (full list in playbook §4.3)
- **Internal numbering** for articles: keep your `PRODUCT` values (e.g. `10000001`) only as the
  **source correlation key**; SAP assigns the real number and records a **key mapping**
  (source → assigned) *in that project*. To extend later, re-run **in the same project** so the
  mapping resolves — a new project won't know the numbers.
- **CRLF line endings** are mandatory; **EAN-13 needs a valid GS1 check digit**; the base-unit
  main EAN goes in `MARA-EAN11` (leave `S_MEAN` empty).
- Fill `S_MARC`/`S_WLK2` too if you want to extend-to-site + list via the cockpit instead of the
  headless listing engine.
