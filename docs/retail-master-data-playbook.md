# Retail Master Data on S/4HANA — Creation Playbook & Gotchas

Reusable knowledge from building an IS-Retail org structure + sample master data on an
S/4HANA 2025+ **Customizing client** (CCCATEGORY='C') headlessly via abap-config-mcp.

**TL;DR — the scope boundary that actually holds on this kind of box:**

| Layer | Right tool | Headless via this MCP? |
|---|---|---|
| Org structure & customizing (company, company codes, purch/sales orgs, channels, divisions, merchandise categories, site profiles, tax procedure) | abap MCP engine + standard FMs/ECOP | ✅ Yes — this is the sweet spot |
| Transactional master data (sites, articles, assortments, listing) | **Migration Cockpit** ("Migrate Your Data") | ❌ No — use the guided upload tool |

Greenfield creation of **sites and articles** is systematically blocked through every
programmatic channel on a validation-heavy best-practice client. Don't fight it — the
guided tools (Migration Cockpit; for one-off config, OMS9) sail through. Sample upload
files: [`docs/retail-samples/`](retail-samples/).

---

## 1. What works headlessly (use these)

- **Org-unit copy** — `org_copy` tool → `ECOP_ORG_UNITS_IN_THE_DARK` (the dark/no-dialog
  engine behind EC01/EC02/EC04/EC05/EC06/EC13). Copies a whole company code / plant /
  sales org / channel / division / purch org with all dependent customizing, records on a
  Customizing transport. **Runs in a background job (engine ≥ 0.9.13)** so the copier
  executes with `sy-batch='X'` — the FI after-copy logic (`FI_ECOP_BUKRS_AFTERCOPY`, a GUI
  `MESSAGE I`) and the dialog-bound number-range step (`NUMBER_RANGE_SUBOBJECT_COPY` →
  `CALL SCREEN 300`) are then **batch-safe** (message logged, dialog skipped) instead of
  aborting the copy the way they did in the synchronous ICF context. A company-code copy
  now completes end-to-end (verified: `BUKRS Z100 → ZT`, 76 dependent tables, 2570 object
  keys recorded). If the job outlives the short poll the tool returns a `run_id` — poll
  with `customizing_status`. EKORG/VKORG/VTWEG/SPART copies were always clean (no number
  ranges → no dialog).
  - *Historical fallback (engine < 0.9.13, when the copy aborted mid-flight):* run the
    remaining steps from a $TMP class — copy `NRIV` (NRLEVEL=0) + `TNRGT` for the org
    unit's number-range objects (`TNRO` where `DTELSOBJ` is the **domain** of the key, e.g.
    BUKRS — `ANLAGENNR` uses `BUKRSN`, excluded), then `cl_fins_versn_conf_sync`
    (copy_bukrs + update_transport_order) and
    `cl_faa_cmp_factory_static=>ecop_postprocessing_bukrs`.
  - *Delete caveat:* `org_copy action=delete` for a **company code** can be vetoed by an
    application `global_check_failed` (a configured BUKRS needs its assignments removed
    first); channel/division/sales-org deletes run clean.
- **Customizing writes** — the engine's SM30 view runtime
  (`VIEW_MAINTENANCE_SINGLE_ENTRY`) with `values` field overrides: T880 (company), T001
  (company code, via `V_T001`/`V_001_Y` for RCOMP), T024E, TVKO, site profiles `TWRF2`,
  tax procedure assignment (`V_005_E` → KALSM). Texts live in dedicated text tables
  (T023T/TVKOT/TVTWT/TSPAT) — write them directly, **not** via a view UPDATE (which blanks
  them).
- **Merchandise categories** — `MERCHANDISE_GROUP_MODIFY` (FUGR WWGR) with
  `PI_UPDATE='1'`: creates the class-026 dark (`CLMA_CLASS_CREATE`), inserts T023/T023T,
  change docs, commits. Header-line TABLES params → call from a REPORT, not OO.
- **Classes/characteristics** — `CLMA_CLASS_CREATE` + **`CLVM_CLASS_BOOK` + COMMIT**
  (the create alone buffers; book persists it).

---

## 2. What does NOT work headlessly — and the exact walls

### 2a. Sites (retail) — no headless greenfield API exists on this FPS
- **All RFM site APIs are copy-from-reference** (`RFM_SITE_COPY_FROM_REFSITE_RFC`,
  `IF_RFM_SITE_MD~COPY_MASTER_DATA_BULK`) — and there are **zero existing retail sites**
  to copy from (every `T001W.VLFKZ` is blank), so the copy path can't bootstrap the first.
- **`C_SiteMasterMigrtn`** (Migration Cockpit BO, `CL_RFM_SITE_MASTER_MIGRTN`) has a real
  public `create`, but raw EML create → **`BEHAVIOR_CONTRACT_VIOLATION` dump** (framework-
  bound; not callable as a plain API).
- **`UI_RFM_SITE_MAINTAIN`** OData ("Manage Sites") = **edit-only** (`R_SiteMasterTP` has
  `internal create`; DPC class `CL_RFM_SITE_OP_DPC_EXT` has no create-deep-entity). Only
  `CopyFromRefRetailSite` — useless with no reference site.
- **WB01 batch input** reaches the *final* validation but is blocked two ways: WITH a
  reference site → an interactive classification confirm popup (`SAPLSPO1/0100`, then the
  `SAPLCLCA` classification transaction) that `CALL TRANSACTION MODE 'N'` can't drive;
  WITHOUT a reference → the mandatory material-ledger field `TCKM2-MATLED` sits on tabstrip
  subscreen 2150 and the save (`=UPDA`/`=BU`) never commits (other tabs' mandatory fields
  empty). The **site address lives on the Business Partner** — that's why WB01 0401 has no
  address fields; pre-create the BP with `BAPI_BUPA_CREATE_FROM_DATA` (extern number = site
  ID, category '2', grouping S110 store / S100 DC) + `BAPI_BUPA_ROLE_ADD_2` roles
  `BPSITE`, `FLCU00`, `FLCU01` (customer roles → CVI builds the site customer; without them
  WB01 errors WN 453 "no customer assigned"). Site profile `BETRP` is **CHAR4**
  (ZSTO/ZDC/ZPLA — the spec's 6-char ZSTORE/ZDC/ZPLANT don't fit). Profiles must be
  classified (class type 035, OBTAB=BETR) or WB01 warns WN 112.
- **→ The BP + CVI-customer layer a site needs IS creatable headlessly** (verified) — see
  **§6**. `BPSITE` turned out unnecessary; `FLCU00`/`FLCU01` alone make CVI build the
  customer. Only the `T001W` site/plant record itself still needs the GUI (eCATT, §6.2).

### 2b. Articles — field-selection mandatory fields with no BAPI slot (a cascade)
- `BAPI_MATERIAL_MAINTAINDATA_RT` (the retail article BAPI behind MM41) creates fine
  through header/number/UoM/EAN, but the article type's **field selection** makes
  client-level fields mandatory that the BAPI has **no structure field for**: first
  `MARA-TAKLV` (tax classification), then `MAW1-WLADG` (loading group), … a cascade across
  multiple field references. Relaxing them in OMS9 unblocks one at a time.
- RAP EML on **`A_Product_2`** (the `API_PRODUCT` BO, real public create) →
  **`CX_ABAP_BEHV_COMMIT_FAILED`** inside an AUnit test context, and a plain background job
  **ABENDs** — RAP create only runs cleanly in its **OData runtime**.
- OData **`API_PRODUCT`** (V4) — see §3 (customizing-client publish guard + V4 group not
  generating).

### 2c. Field selection (OMS9) storage is opaque — don't write it directly
- Maintained via view **`V_T130A_FLREF`** = `T130A-FAUSW` (groups 1-128) **+
  `T133F-FAUSW` + `T133U-FAUSW`** (higher groups). Each FAUSW is 128 chars; group numbers
  run to ~247; the group→(table,position) mapping is **not** linear (`MARA-TAKLV`=grp186,
  `MAW1-WLADG`=grp173, and the obvious `group−128` position did not hold). Status code for
  "required" is **not** `'+'` in the SAPR strings either. **Conclusion: only OMS9 can
  reliably set these** — direct table writes are unsafe. The mandatory entry is also
  multi-reference: a baseline reference **`SAPR`** (applies to all material maintenance)
  plus the article-type reference (`HAWA`, from `T134-FLREF` for FOOD & HAWA).

---

## 3. Customizing-client / gateway constraints (environmental)

- **OData service-binding publish is forbidden in a Customizing client.** Publishing a
  Local Service Endpoint returns `RAP_SERVICES_ADT 021` "(Un-)Publishing of SRVB … in
  Customizing Client not allowed". The only blocking attribute is the **client role**
  (`T000-CCCATEGORY='C'`); cross-client changes (`CCNOCLIIND` blank) and auto-recording
  (`CCCORACTIV='1'`) are fine. **Fix:** in SCC4 flip the client role **Customizing → Test**
  (`C`→`T`), publish (it's a one-time activation that persists), flip back. Don't use
  Production (also blocks).
- `API_PRODUCT` is an **OData V4** binding (contract C2 but the ADT detail references
  `/sap/bc/adt/businessservices/odatav4/…`). Publish via the **V4** endpoint
  (`/sap/bc/adt/businessservices/odatav4/publishjobs?servicename=API_PRODUCT&serviceversion=0002`
  — version **0002** is RELEASED, 0001 deprecated). After publish the V4 URL goes 404→403
  with "Service … repository SRVD is not assigned to group" and the service group stays
  `published="false"` / `created="false"` — i.e. the runtime service didn't generate. This
  needs further V4 service-group admin not resolved here; treat OData create as not viable
  on this client without more gateway setup.
- Gateway catalog (`/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection`) is capped
  ~185 rows in the default page — absence there is not proof a service is unpublished.

---

## 4. The correct way — Migration Cockpit ("Migrate Your Data")

For sites, articles, assortments, listing — use the **Migration Cockpit** (the Fiori app
**"Migrate Your Data"**). It owns all the field-selection / validation logic, so none of
the §2 walls apply.

> **Naming note.** "Migration Cockpit" / "Migrate Your Data" is the **current** S/4HANA
> tool (semantic object `DataMigration`). It is **not** the legacy *Legacy System
> Migration Workbench* (LSMW, semantic object `MigrationWorkbench`, tcode `LSMW`) — that
> one is not the path for S/4 master data. Use the cockpit below.

### 4.0 Launching the cockpit (start here)

> **Detection-first (works on any release).** The forward-compatible constant is the
> **Fiori app "Migrate Your Data"** (semantic object `DataMigration`) — present on every
> modern S/4 release and, on recent releases, **the only way to migrate**. The SAP GUI
> transaction `LTMC` still exists but is **release-dependent and increasingly locked**:
> probe the box (`SELECT … FROM tstc WHERE tcode LIKE 'LTM%'`) but don't assume it can
> create projects. **Verified on this demo box (S/4HANA 2025, S4CORE 109 / SAP_BASIS 816,
> SID `A4H`):** `LTMC` opens but is **display-only** — it states *"It is no longer possible
> to migrate data using transaction LTMC … use the app Migrate Your Data."* So on 2025 the
> **Fiori app is mandatory** (route B); LTMC (A) is only good for *viewing* existing
> projects, and LTMOM for object modeling.

Routes below: **B (Fiori) is the real path on 2025+**; A is view-only here.

**A. SAP GUI transactions** — type in the GUI command field (prefix `/n`):

| Tcode | Program | What it opens |
|---|---|---|
| `/n LTMC`  | `DMC_WDA_MC` | Migration Cockpit UI — **on 2025 this is display-only** (view existing projects; *cannot* create/upload/migrate). Older releases: full cockpit. |
| `/n LTMOM` | `DMC_MC` | **Migration Object Modeler** — inspect/extend a migration object's structures, field mappings, rules; add custom objects. Optional, for tailoring. |

**B. After Fiori Launchpad (FLP) login:**

1. Open the launchpad: `https://<host>:<https-port>/sap/bc/ui2/flp` (HTTP variant
   `http://<host>:<http-port>/sap/bc/ui2/flp`). `<host>` is the same SAP host as the GUI;
   ports are the ICM services — HTTPS `443<inst>`, HTTP `80<inst>` (check in `SMICM →
   Goto → Services`). Log in with your SAP user/client.
2. Find the app. Look for a **"Migrate Your Data"** tile, usually in a **Data Migration**
   space/page. If you don't see a tile, open the **App Finder** (the *navigation/compass*
   icon, top-left ⇒ "App Finder") and **search `Migrate`** — the App Finder resolves the
   app by intent even when no tile is pinned. Open **"Migrate Your Data – Migration
   Cockpit"**.

**C. Direct deep link (skip tiles):** append the app's intent to the FLP URL —

```
https://<host>:<https-port>/sap/bc/ui2/flp#DataMigration-manage
```

The semantic object `DataMigration` is confirmed on this box. If the exact action segment
differs on your FPS and the deep link lands empty, use the **App Finder** (B2) — it always
navigates to the correct target mapping.

### 4.1 What if it's not shown / not available

Work down this list; the first one that applies is usually it:

1. **Business role not assigned (most common).** The cockpit is delivered by business role
   **`SAP_BR_CONFIG_EXPERT_DATA_MIG`** ("Configuration Expert – Data Migration", confirmed
   present) — it brings the *Migrate Your Data* app, the Data Migration space, and `LTMOM`.
   Assign it:
   - Fiori app **"Maintain Business Roles"** → add the role to your user, **or**
   - `PFCG` → role `SAP_BR_CONFIG_EXPERT_DATA_MIG` → **User** tab → add your user →
     **User comparison** (or run `PFUD`) so the profile is pushed. Re-login / refresh FLP.
2. **Role is assigned but no tile shows.** The FLP space/page may not be assigned — the
   **App Finder** (B2) launches it regardless of tiles, so use that immediately; assign the
   space later if you want a permanent tile.
3. **App opens blank / "service not available" / 404.** The OData/UI services or ICF nodes
   aren't active:
   - Activate the app's OData services in **`/IWFND/MAINT_SERVICE`** (Gateway service
     maintenance) — add & activate the migration cockpit services.
   - Activate ICF nodes in **`SICF`**: `/sap/bc/ui2/flp`, `/sap/bc/ui5_ui5/*`, and the
     app's BSP. (`SICF` → *Execute* → right-click → *Activate Service*.)
   - If FLP itself was never set up, run the Fiori setup task lists in **`STC01`**:
     `SAP_FIORI_LAUNCHPAD_INIT_SETUP` and `SAP_GATEWAY_BASIC_CONFIG` /
     `SAP_GATEWAY_ACTIVATE_ODATA_SERV`.
4. **FLP unreachable entirely (network / not configured).** On older releases `LTMC` (A) is
   the GUI fallback, but **on 2025 there is no GUI migrate fallback** — `LTMC` is display-only
   (item A) — so the Fiori app *must* work: fix FLP reachability (items 6/7) rather than
   reaching for LTMC. `LTMC` is still fine for *viewing* existing projects and `LTMOM` for
   object modeling.
5. **Authorization error inside the cockpit** (project list empty, "not authorized"). Beyond
   the business role, the user needs the data-migration auth objects it carries; if a custom
   user is used, copy the role or use a `SAP_ALL`-equipped admin user on this sandbox.
6. **App/`LTMC` browser window won't load — the generated URL uses a FQDN your client can't
   resolve.** SAP stamps generated *absolute* URLs (the browser window `LTMC` opens, and
   Fiori) with the host from profile parameter **`icm/host_name_full`** (here
   `s4hana2025.sapdemo.com`), **not** the short name you may have in your hosts file — so the
   browser fails to reach the box. Fix on the **client** (preferred — FQDNs keep SSO/cookies
   happy): add the FQDN beside the short name, e.g. `<box-ip> s4hana2025.sapdemo.com
   s4hana2025` (macOS/Linux `/etc/hosts`, needs `sudo`; flush with `sudo dscacheutil
   -flushcache; sudo killall -HUP mDNSResponder`). Or make **SAP** emit the short name: `RZ10`
   → instance profile → `icm/host_name_full = s4hana2025` → restart the ICM (not a dynamic
   parameter) — but that's global and can break SSO/SAML/secure cookies, so prefer the hosts
   fix. (It is **not** a `SICF`/`SMICM` service setting — only `icm/host_name_full`.)
7. **Tile renders but shows "Error" / "Cannot load tile" and the app only half-loads.** The
   role is fine (the tile is visible); the **UI5 app's OData service isn't activated**. This
   is the wall that actually blocks the cockpit on a fresh box (and on 2025 you can't fall
   back to `LTMC` — it's display-only, item A above).
   - **Find the exact missing service:** open the app → browser **DevTools → Network** →
     reload → the red request. **Grounded on A4H/250:** it failed with *"No service found for
     namespace `/LTB/`, name `MIG_MC_ODATA_SRV`, version `0001`"* — i.e. the cockpit's backing
     service is the **classic V2** service **`/LTB/MIG_MC_ODATA_SRV` (v0001)**, delivered but
     not registered (`TADIR`: present as `IWSV` + `IWPR`). Because it's V2, the
     customizing-client **V4-publish trap does *not* apply** — no SCC4 flip needed.
   - **Activate it** (either route):
     - **`/IWFND/MAINT_SERVICE`** → *Add Service* → System Alias **`LOCAL`** → search
       `*MIG_MC*` → select `/LTB/MIG_MC_ODATA_SRV` → *Add Selected Services* (package `$TMP`
       is fine). Registers the service group + activates the ICF node.
     - **`STC01` task `SAP_GATEWAY_ACTIVATE_ODATA_SERV`** — its service list is **empty by
       design** (an *input* box, not a discovery list): type `/LTB/MIG_MC_ODATA_SRV 0001`
       (name `<SPACE>` version). In the variant, **Processing Mode = "Co-deployed only"**
       (embedded S/4HANA — Gateway + service in one system; the System Alias field is then
       irrelevant). "Routing-based" + `LOCAL` also works.
   - Reload the app — the tile clears. If a *second* `No service found …` appears, the app
     pulls more than one service; activate that one the same way. (`/sap/bc/ui5_ui5/…` or
     `/sap/bc/ui2/…` 404s instead ⇒ activate that **ICF node** in `SICF`.)
8. **A download (e.g. cockpit "Download Template") spins ~30 s then nothing — no file.** The
   cockpit UI works, the download just dies silently. **It is a TLS/server-certificate
   problem, not a cockpit/service/timeout problem** — the download is an **HTTPS** request
   (the ICM HTTPS port `443<inst>`), and the browser is rejecting the SAP server certificate.
   - **Confirm it's TLS, not a backend error:** `ST22` has **no dump** for it and
     `/IWFND/ERROR_LOG` shows **no new entry** at the click time (the `/SSB/`
     `SMART_BUSINESS_RUNTIME_SRV` "Query 2CC… unknown" spam there is unrelated KPI-tile
     noise). The smoking gun is **`SMICM` → Goto → Trace File**: a
     `secussl_read_tls13: SSL_read() … "received a fatal TLS certificate unknown alert from
     the peer"` → `SSLERR_ALERT_CERTIFICATE_UNKNOWN (-127)`, with the server cert shown as
     `Subject == Issuer` (self-signed) and **`SANs: <none>`**.
   - **Why:** the delivered SSL server PSE (`SAPSSLS.pse`, STRUST node **SSL server
     Standard**) is **self-signed and has no Subject Alternative Name** — modern
     Chrome/Brave/Firefox reject CN-only certs outright. **Crucial gotcha:** a browser
     click-through ("Proceed anyway") only covers **top-level navigations**, *never*
     background **XHR/fetch** requests — and a download is an XHR. So visiting the HTTPS URL
     and accepting the cert does **not** fix it (and STRUST's **Subject (Alt.)** field is
     **display-only** — you can't add a SAN in the GUI here).
   - **Quick unblock (dev box):** launch the browser ignoring cert errors — e.g. macOS
     `open -na "Google Chrome" --args --ignore-certificate-errors --user-data-dir=/tmp/insec`.
     This disables validation for XHR too, so the download goes through.
   - **Proper fix:** give the ICM a **trusted** cert **with a SAN**. Two ways:
     - *Self-signed + SAN:* regenerate `SAPSSLS.pse` on the OS as `<sid>adm` —
       `sapgenpse gen_pse -p $SECUDIR/SAPSSLS.pse -x "" -s "<fqdn>" "CN=<fqdn>"` (verify the
       SAN flag via `sapgenpse gen_pse -h`), `seclogin -O <sid>adm`, restart ICM — **then
       still import that cert into every client's trust store** (self-signed = untrusted).
     - *CA-signed (best — no per-client trust step):* get a public cert (e.g. **Let's
       Encrypt via DNS-01**, which needs no inbound access) for a hostname **under a domain
       you control** (`s4hana2025.<your-domain>`); bundle key+cert to PKCS#12
       (`openssl pkcs12 -export …`); import into `SAPSSLS.pse` (STRUST **SSL server Standard
       → PSE → Import**, or `sapgenpse import_p12`); `seclogin`; restart ICM. Set
       **`icm/host_name_full = <fqdn>`** (`RZ10`, restart ICM) and point **DNS** (an A record,
       e.g. to the box's overlay/VPN IP) at it — no `/etc/hosts` needed. The cert validates
       the **name**, not the IP, so a private/overlay IP is fine; a public CA means browsers
       trust it automatically and the XHR download just works.
   - Related: a download URL is built from `icm/host_name_full` (item 6) — keep the FQDN in
     the cert SAN, `icm/host_name_full`, DNS, and the browser URL **all identical**.
   - **✅ Worked recipe (public CA cert into the ICM — verified end-to-end):**
     1. Pick an FQDN under a domain you control (`<host>.<your-domain>`) and set it
        **system-wide via `SAPFQDN` in `DEFAULT.PFL`** (so `SAPLOCALHOSTFULL =
        $(SAPLOCALHOST).$(SAPFQDN)` and every generated URL uses it — cleaner than, and
        removes the need for, a separate `icm/host_name_full`).
     2. **DNS A record** `<host>.<your-domain>` → the box IP (a private/overlay/VPN IP is
        fine — the cert validates the *name*, not the IP — so no `/etc/hosts` anywhere).
     3. Issue the cert with `acme.sh` **DNS-01** (ZeroSSL/Let's Encrypt; DNS-01 needs no
        inbound access). Gotcha: acme.sh defaults to **ECC** → files land in
        `~/.acme.sh/<fqdn>_ecc/` (ECC is fine — CommonCryptoLib 8.5.x serves it; pass
        `-k 2048` only if you want RSA).
     4. **Complete the chain for `sapgenpse`** — acme.sh's `ca.cer` carries only the
        *intermediate*, so `import_p12` fails *"certificate chain is incomplete, need
        certificate of <root CA>"*. Append the root from your client trust store, e.g. macOS
        `security find-certificate -a -c "<root CA CN>" -p
        /System/Library/Keychains/SystemRootCertificates.keychain > root.pem` →
        `cat ca.cer root.pem > fullca.pem`.
     5. Bundle PKCS#12: `openssl pkcs12 -export -inkey <fqdn>.key -in <fqdn>.cer
        -certfile fullca.pem -out sslcert.p12 -passout pass:<p12-pass>`.
     6. Import into the **SSL server PSE** (`$SECUDIR/SAPSSLS.pse`) on the OS as `<sid>adm`.
        **csh gotcha:** no inline `#` comment on the command — csh passes it as args
        ("unrecognized parameters"). `setenv SECUDIR /usr/sap/<SID>/<inst>/sec` →
        `sapgenpse import_p12 -p ./SAPSSLS.pse -x "" ./sslcert.p12` (enter `<p12-pass>`) →
        `sapgenpse seclogin -p ./SAPSSLS.pse -x "" -O <sid>adm`. (A `seclogin: Couldn't open
        PSE` here just means the import hadn't succeeded yet — fix the import first.)
     7. **Reload only the ICM** (`SMICM → Administration → ICM → Exit Soft → Global`) — no
        instance restart needed for a cert swap.
     8. Verify: `curl -v https://<host>.<your-domain>:<https-port>/sap/public/ping` →
        `SSL certificate verify ok`, SAN matches, `HTTP/2 200`. Public CA ⇒ browsers trust it
        ⇒ the cockpit's HTTPS XHR download finally succeeds.
   - **⚠ Restart pitfall (cost us a scare):** if you *do* restart the instance for a profile
     change, bring the **ASCS (message-server) instance up first, then the PAS** —
     `sapcontrol -nr <ascs> -function RestartInstance` then `-nr <pas>` (or `StartSystem`).
     With `system/secure_communication = ON` (default on S/4 2025) internal comms are TLS;
     restarting only the PAS leaves `disp+work` **YELLOW "Server not attached to message
     server"** (`dev_disp`: `NiPConnect … :39<ascs> … Connection refused` to the msg-server
     port). It's not a cert problem — just start the ASCS. (Hostname resolution and
     `icm/host_name_full`/`SAPFQDN` are *not* the cause of that symptom.)

### 4.2 In-app workflow

1. In the cockpit, create a migration **project** with transfer option **"Migrate Data
   Using Files"** (simplest for our sample volume) or **"Migrate Data Using Staging
   Tables"** (DB tables, better for large/automatable loads).
2. Add migration objects:
   - **Product** (covers article master incl. retail data) — for the articles.
   - **Retail Store / Site** (S/4 Retail delivers a site migration object; pick the one
     whose description matches "Site" / "Store") — for the sites.
3. For each object, **Download Template** (multi-sheet XLSX — one sheet per structure:
   Basic Data, Descriptions, Units of Measure, Tax, etc. for Product; Site/Address/Org for
   Site).
4. Paste the values from the sample CSVs (`docs/retail-samples/`) into the matching
   template columns (column technical names vary by release — map by meaning; the CSV
   headers name the field semantics). Articles need: Material, Article type, Merchandise
   category, Base unit, Description, GTIN/EAN, and departure-country tax classification.
   Sites need: Site, Name, Category (store/DC), Profile, Company code, Purchasing org,
   Sales org/Distribution channel/Division, Address, BP grouping.
5. **Upload** the file → **Simulate** (validates without posting; fix any errors) →
   **Migrate** (posts via the standard create logic).

Prerequisites already built headlessly (so the upload validates): company codes
Z100/Z200/Z300, purch org Z100, sales orgs BE01/ZA01/LS01, channels 10/20, divisions
01/02, merchandise categories 0101-0103 / 0201-0203, site profiles ZSTO/ZDC/ZPLA, LS tax
procedure (0TXZA). Manufacturing plants (GHPL/ANPL/CTPL/JBPL/MSPL/TYPL) are plain plants —
create via `org_copy` `WERKS` (headless, §1) or the Plant migration object.

**Manual fallback (few records):** articles via `MM41`, sites via `WB01` (create the BP
first as in §2a). For a one-off field-selection relax (to let the BAPI route work for
articles), OMS9 → *Maintain Field Selection for Data Screens* → field → **Required entry →
Optional entry** (input-validation only; zero runtime impact; reversible).

### 4.3 ✅ Worked recipe — Articles via the **Product** object (staging), verified end-to-end

Loaded the 5 sample articles on A4H/250 (S/4HANA 2025). The exact flow + every wall hit:

**Setup**
1. New migration project → **Staging Tables** (on 2025 "Files" project type is gone), dev
   class **`$TMP`**, add the **Product** migration object. On "predecessor objects"
   (Merchandise category / Profit center / Supplier / Production supply area) **uncheck all**
   — those already exist; you only reference them.
2. Active View = **Standard Scope** (must be *saved/confirmed* — §4.1 item 5).
3. **Mapping Tasks → confirm the 3 control parameters.** Set **"Product, Internal or
   External Numbering" = `Internal`** — the IS-Retail norm; SAP assigns the article numbers.
   *Don't* force external numeric numbers like `10000001` — they fail `M3 565` "ext.
   material no. must not contain only numbers" (FOOD) / `M3 318` "not defined for material
   type" (HAWA), because purely-numeric numbers belong to the internal range. Keep your
   numbers in `PRODUCT` only as the **source correlation key**; SAP maps source→assigned.

**Fill the template (Download Template → CSV; fill only these sheets, rest stay empty):**
| Sheet | Fields | Notes |
|---|---|---|
| **`S_MARA`** (`#FreeText_Mandatory`) | `PRODUCT`, `MTART`, **`MBRSH=1`**, `MATKL`, `MAKTX`, `SPRAS`, `MEINS`, `SPART`, **`EAN11`**, **`NUMTP`** | `MBRSH=1` (=Retail) is **mandatory** (`M3 099` "Enter an industry sector" if blank). The **main GTIN goes here in `EAN11`+`NUMTP`** (category, e.g. `HE`). |
| **`S_MLAN`** (tax) | `ALAND`, `TATYP1`, `TAXM1` | e.g. `BE` / `MWST` / `1`. |
| **`S_MEAN`** | *(leave empty)* | The base-unit main EAN lives in `MARA-EAN11`, **not** here — S_MEAN has no main-flag column, so putting the EAN here triggers "**First specify the main EAN for the unit**". |

**Format gotchas that cost the most time**
- **CRLF line endings are mandatory.** The downloaded template is a single header line with
  **no terminator**; if you save data rows with plain `\n` the cockpit parser merges
  header+data → "**Field "<value>" does not exist in S_MARA**" and the file shows
  "**Not Mapped to Any Data Structure**". Write `\r\n`.
- **EAN-13 needs a valid GS1 check digit** or "**The EAN … has an incorrect check digit**".
  (Recompute the 13th digit; don't trust hand-typed GTINs.)

**Run:** Upload File — **allow browser popups for the host** (the download/upload uses a
window that's popup-blocked by default → "spinner, nothing happens", see §4.1 item 8) →
**Transfer Data to Staging Tables → Prepare → Simulate** (fix field errors, re-upload the
*whole* ZIP so cleared sheets like S_MEAN actually empty in staging) → **Migrate**.
Monitoring shows the SAP-assigned article number per source key.

**The error ladder we climbed** (each fixed in the CSV/task, re-Simulate between):
`M3 099` industry sector → set `MBRSH=1`; `M3 565`/`M3 318` number range → switch to
**Internal**; EAN "incorrect check digit" → valid GS1 digit; "main EAN for unit" → move GTIN
to `MARA-EAN11`+`NUMTP`, empty `S_MEAN` → **green → Migrate**. Sample data:
[`docs/retail-samples/articles.csv`](retail-samples/articles.csv).

---

## 5. Cross-cutting gotchas (save yourself the round-trips)

- **BAPI material errors hide behind `MG 537` "see log nnn"** — set `HEADDATA-NO_APPL_LOG
  = 'X'` to get the real message in `RETURN` (and the app log rolls back with a dry-run
  anyway).
- **Material number needs `ALPHA = IN`** (18-char leading zeros) or `MG 019`.
- **`ROLLBACK ENTITIES` and `BAPI_TRANSACTION_ROLLBACK` also roll back same-LUW TVARVC log
  writes** — collect diagnostics in an in-memory table and flush + `COMMIT WORK` *after*
  the rollback (dry-run pattern).
- **RAP EML never runs under AUnit/`run_unit_tests`** (commit-failed dump) nor cleanly in a
  plain background job — it needs the OData runtime.
- **`PERFORM … USING |string template|` is a syntax error** — assign the template to a
  variable first.
- **AUnit test methods must be `DURATION SHORT`** — `LONG` is silently skipped by the
  default ADT run config (looks like "ran, no output").
- **Headless exec channels for this MCP**: `$TMP` class + AUnit test that `SUBMIT`s a
  report (report runs its own LUW); persist results to `TVARVC` and read back. For
  transport-recording writes use a **background job** (`JOB_OPEN`/`SUBMIT VIA JOB`) so it
  runs with `sy-batch` and outside the AUnit transactional context.
- **Stale enqueues** from aborted dialog BDC runs: `DEQUEUE_ALL` before `CALL TRANSACTION`,
  or read/clear own locks via `ENQUE_READ`/`ENQUE_DELETE` (`SEQG3` line type).
- **WB01 BDC specifics** (if ever revisited): start screen 0101 (`WR02D-LOCNR`,
  `WR02D-BETRP`, `WR02D-REF_WKFIL`), main screen 0401, save okcode `=UPDA`, `T001W-SPART`
  must be the common division `00`, `TCKM2-MATLED='0001'` on subscreen 2150.

## 6. Retail-site Business Partners + CVI customers — headless (verified)

The site **master** (`T001W`) has no headless create (§2a), but the **partner layer** a
site needs — the Business Partner *and* its CVI customer — **is** fully creatable headlessly.
This unblocks the eCATT/WB01 site route (the site references an existing BP) and is the
answer when the cockpit's **Business Partner** object isn't available: that object is offered
**only for direct SAP-to-SAP migration, never for staging-table / file projects**.

**Recipe** (report `ZMCP_BP_CREATE` — one `BAPI_BUPA_CREATE_FROM_DATA` + role-add per site):
- `BUSINESSPARTNEREXTERN` = site ID → external numbering, so BP number = site ID = customer number
- `PARTNERCATEGORY = '2'` (organization)
- `PARTNERGROUP` = `S100` (DC) / `S110` (store) — from `TWRF2.BP_GRP_SITE`
- `CENTRALDATA` — **mandatory parameter even when near-empty** (omit it →
  `CX_SY_DYN_CALL_PARAM_MISSING`); set `PARTNERLANGUAGE` (+ e.g. `SEARCHTERM1`)
- `CENTRALDATAORGANIZATION-NAME1` = site name
- `ADDRESSDATA` = `COUNTRY` / `CITY` / `POSTL_COD1` / `STREET` (the site address lives on the BP)
- then `BAPI_BUPA_ROLE_ADD_2` for **`FLCU00`** + **`FLCU01`** → **CVI auto-generates the
  customer** (`KNA1`, `KUNNR` = site ID, account group derived from the grouping via `TBD001`
  — `0100` here). `BPSITE` is **not** required for this; the two customer roles suffice.
- `BAPI_TRANSACTION_COMMIT WAIT = 'X'` per BP; on any `RETURN` error roll that one back and continue.

Verified end-to-end: `BUT000` (12 type-2 BPs, S100/S110, names+address), `BUT100`
(`FLCU00`+`FLCU01`), `KNA1` (one customer per site, `KUNNR` = site ID).

**`CMD_MIG_BP_CVI_CREATE`** (FUGR `CVI_BP_MIGRATION`, a *released* migration API with
`IV_TEST_RUN` + `ET_KEY_MAPPING`) is the cockpit BP object's backend and the "proper" mass
API — but its input is the deeply-nested `CVIS_EI_EXTERN` MDG structure (describe is
auth-blocked on this box). The flat `BAPI_BUPA` route above yields the same BP+role+CVI
result with a fraction of the code — prefer it unless you specifically need the migration framing.

### 6.1 Headless exec pattern for a committing write (reusable)
- `create_abap_object` needs the **full creatable typeId** — `PROG/P`, `CLAS/OC`, `FUGR/F`,
  `TABL/DT`, …  A bare `PROG`/`CLAS` throws *"Unsupported object type"* from `abap-adt-api`
  (`CreatableTypes.get` misses). *(This MCP now normalises the bare prefix, so either works —
  but the underlying library does not.)* `write_abap_object_source` takes the **object** URL
  (e.g. `/sap/bc/adt/programs/programs/zmcp_bp_create`); it appends `/source/main` itself.
- `run_unit_tests` **does not discover `RISK LEVEL DANGEROUS` test classes** ("No unit test
  classes found"), and a `HARMLESS` test cannot `COMMIT`. To commit headlessly: put the
  logic in a report's `START-OF-SELECTION` (`PARAMETERS p_commit`) and have a **`HARMLESS`
  DURATION SHORT** AUnit test **schedule it as a background job** — `JOB_OPEN` →
  `SUBMIT … WITH p_commit='X' VIA JOB <name> NUMBER <count> AND RETURN` →
  `JOB_CLOSE strtimmed='X'`; the job commits in batch. Log to `TVARVC` and read it back.
  For a no-commit **dry run**, call the same logic with `BAPI_TRANSACTION_ROLLBACK` and
  surface the result via `cl_abap_unit_assert=>fail( msg = … )` (HARMLESS, nothing persists).

### 6.2 The site master (T001W) — eCATT/SECATT recording of WB01
With the BPs/customers in place, create the plants/sites via **eCATT/SECATT** recording of
**WB01** — SAP's recommended route for objects with no Migration Cockpit object. eCATT
drives the GUI like a user, so it clears the classification-popup + multi-tab walls that
defeated the headless BDC (§2a), and the recording just **links the now-existing BP**
(`WR02D-SITE_BP` = site ID) instead of creating one.

**Recording steps** (`SECATT`):
1. Create a test script (e.g. `ZRET_SITE_WB01`) → **record `WB01`** once with the `GHDC` values.
2. **Parameterise** the fields below (name the params `V_*` to match the variant file, or
   rename the CSV header to your params).
3. Create a Test Configuration + **Test Data Container** and import
   `docs/retail-samples/sites_ecatt_variants.csv` (12 variants, `;`-delimited, `VARIANT` first).
4. Run the configuration over all variants → 12 sites.

**Parameter → WB01 field map** (constants `V_SPART=00`, `V_MATLED=0001`, `V_REFSITE` blank):

| eCATT param | WB01 field (screen) | value |
|---|---|---|
| `V_SITE`    | `WR02D-LOCNR` (0101)        | site ID |
| `V_PROFILE` | `WR02D-BETRP` (0101)        | `ZDC` (DC) / `ZSTO` (store) |
| `V_REFSITE` | `WR02D-REF_WKFIL` (0101)    | *blank* — no reference copy |
| `V_SITE_BP` | `WR02D-SITE_BP` (0401)      | = site ID (links the pre-created BP) |
| `V_BUKRS`   | `T001K-BUKRS` (0401)        | Z100 / Z200 / Z300 |
| `V_EKORG`   | `T001W-EKORG` (0401)        | Z100 |
| `V_VKORG`   | `T001W-VKORG` (0401)        | BE01 / ZA01 / LS01 |
| `V_VTWEG`   | `T001W-VTWEG` (0401)        | 10 |
| `V_SPART`   | `T001W-SPART` (0401)        | 00 (common division) |
| `V_MATLED`  | `TCKM2-MATLED` (subscr 2150)| 0001 |

Save with okcode `=UPDA`. Full flat site list (incl. address/city/postal) remains in
`docs/retail-samples/sites_all_stores_dcs.csv`.
