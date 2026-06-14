# Retail master-data sample upload files

Sample data for the IS-Retail demo build, formatted for the S/4HANA **Migrate Your Data**
(Migration Cockpit) file upload. See [`../retail-master-data-playbook.md`](../retail-master-data-playbook.md)
for the full why/how and the failed-approach catalog.

| File | Object | Rows |
|---|---|---|
| `articles.csv` | Product (article master) | 5 test articles 10000001–10000005 |
| `sites.csv` | Retail Site | 2 template sites (GHST store, GHDC DC) |
| `sites_all_stores_dcs.csv` | Retail Site | all 12 stores + DCs (BE/ZA/LS) |

Column headers name the **field semantics**, not a release-specific template column. When
you download the real Migration Cockpit template (multi-sheet XLSX), paste each value into
the column with the matching meaning.

Notes
- Articles: tax classification is per departure country (BE here); extend with ZA/LS rows
  if you want full tax coverage. GTIN category `HE` = internal EAN (adjust to a valid
  category in your client if needed).
- Sites: `SiteCategory` A = store, B = distribution center. `SiteProfile` ZSTO/ZDC are the
  4-char profiles created in customizing (TWRF2). The site **address** is stored on the
  business partner — the Migration Cockpit Site object creates/links the BP for you.
- Manufacturing plants (GHPL/ANPL/CTPL/JBPL/MSPL/TYPL) are plain plants — create via the
  `org_copy` `WERKS` tool (headless) or the Plant migration object, not the Retail Site
  object.
