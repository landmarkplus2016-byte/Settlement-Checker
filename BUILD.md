# BUILD.md — Settlement Checker
> Your step-by-step manual for building the app from zero to live.
> Work through this top to bottom. Check off every item as you go.
> Never skip a test. Never move to the next stage if a test fails.
> **No npm. No build step. Ever.** Every file is loaded directly by the browser.

---

## Before You Write a Single Line of Code

### One-time setup checklist
- [ ] Create a GitHub repository — name it `settlement-checker` (private is fine)
- [ ] Enable GitHub Pages: Settings → Pages → Deploy from `main`, root folder
- [ ] Create the **config** Google Sheet — name it `Settlement Config DB` — save its URL
- [ ] Create **one coordinator** Google Sheet to start — e.g. `Settlement — Mahmoud Shaarawy` — save its URL (you'll add more coordinators later, one sheet each)
- [ ] Create a new Apps Script project **standalone** (script.google.com → New project) — it will open every sheet by ID, so it is not bound to any one of them
- [ ] Create your project folder locally: `settlement-checker`
- [ ] Drop `CLAUDE.md` and `BUILD.md` into the root
- [ ] Create a `design/` folder and drop `Settlement_App.html` into it (the approved visual reference)
- [ ] Create an `apps-script/` folder (empty — Stage 2 fills it)
- [ ] Open the folder in VS Code and connect it to the GitHub repo
- [ ] **Do not run `npm init`, `npm install`, or any npm command at any point**

### How to preview while building
- VS Code **Live Server** (right-click `index.html` → Open with Live Server), or
- `python -m http.server 8000` from the project root → `http://localhost:8000`

### First message to Claude Code — copy and paste this exactly:
```
Read CLAUDE.md first and confirm you understand the project before writing any code.
Confirm this is a plain HTML/CSS/JS project — no npm, no build tools, no React, no
Tailwind, ever. Confirm the backend is Google Sheets reached only through a single
Apps Script Web App, and that js/api.js is the only frontend file that talks to it.

Open the visual reference in a browser: design/Settlement_App.html
Confirm you understand it defines the look (indigo #3d5af1 accent, deep navy #0f1942
structure, warm off-white #faf9f5 background, navy-tinted shadows).

Describe in your own words:
  - what this app does
  - the difference between a coordinator and a manager
  - what a "settlement" is, and why it holds TWO tracking numbers (old and new)
  - the status machine: draft → confirmed → approved → exported, plus returned
  - why editing an approved entry reverts it to confirmed
  - how a coordinator is prevented from ever touching another coordinator's sheet
  - how per-site export divides money but never KM
  - why an exported row can never be exported again

Then create the empty folder and file structure exactly as in Section 9.1 of CLAUDE.md.
Empty files only, no code yet. Do not write any logic until I confirm the structure.
```

### After structure is created — verify:
- [ ] All folders exist per CLAUDE.md 9.1: `css/`, `js/i18n/`, `js/utils/`, `js/components/`, `js/auth/`, `js/coordinator/`, `js/manager/`, `js/admin/`, `design/`, `apps-script/`, `icons/`
- [ ] Every file listed in 9.1 exists and is empty
- [ ] `CLAUDE.md`, `BUILD.md` in root; `Settlement_App.html` in `design/`
- [ ] No `package.json`, no `node_modules`, no bundler config anywhere
- [ ] No code written yet

---

# Stage 1 — The Google Sheets

**Goal:** The config sheet and one coordinator sheet exist with the exact tabs and headers from CLAUDE.md Section 2. Nothing else.

**Prompt:**
```
Read CLAUDE.md Section 2. We are on Stage 1.

I have two Google Sheets: 'Settlement Config DB' and 'Settlement — Mahmoud Shaarawy'.

1. For 'Settlement Config DB', give me the exact tab list and the exact row-1
   headers to paste into each, in order:
   Config, Users, Sessions, Teams, SiteJC, Lists, ExportLog.

2. For 'Settlement — Mahmoud Shaarawy', the same for:
   Settlements, Expenses, Fuel.
   (Expenses and Fuel share the same envelope columns; list Fuel's full column set
   including start_km, end_km, fuel_amount, area, driver, city, karta_amount.)

3. For the Config tab, the initial key/value rows (app_name, company_name,
   primary_language=en, session_expiry_hours=12, fiscal_new_from_year=2026).

4. For the Lists tab, initial rows for: projects (POC3, roll out, EXP, ROT, ML,
   Survey, NFM, Fiber, MTX), categories (Labor, Material, Transportation, Internet,
   Medical, Allowance, Accommodation, Site Guard, Other), areas (Cairo, Delta, Alex,
   Upper Egypt), months (Jan…Dec).

5. For SiteJC (columns: site_id, job_code, task_date, period, updated_at,
   updated_by — the key is site_id + job_code, so a site may repeat), a few seed
   rows so I can test autofill. task_date is ISO; period is derived from its year
   against fiscal_new_from_year, and these already agree with 2026:
   K3666→CABH559 2026-02-11 new, 377→CABH783 2025-08-03 old,
   K1286→CABH762 2025-11-19 old, K6105→CABH748 2026-01-06 new,
   k3799→CABH795 2026-03-22 new, 442→CABH789 2026-01-14 new,
   J2722→ABD168 2025-09-23 old, 6270→ABD151 2025-12-07 old,
   and — to exercise the multi-JC picker — a SECOND row for K3666:
   K3666→CABH611 2026-05-30 new.

6. For Users, one manager and one coordinator row. Leave password_hash blank for now
   (I'll paste a SHA-256 hex in Stage 2). Put the coordinator sheet's ID in the
   coordinator row's coordinator_sheet_id; leave it blank for the manager.

Do not write any app code. This stage is data entry into the Sheets only.
```

**Tests for Stage 1:**
- [ ] Config sheet has 7 tabs with correct headers
- [ ] Coordinator sheet has 3 tabs with correct headers
- [ ] `Lists`, `SiteJC`, `Config` seeded
- [ ] One manager + one coordinator in `Users`; the coordinator row has a sheet ID

---

# Stage 2 — Apps Script Skeleton

**Goal:** Apps Script deployed; health check and dispatcher work; auth and the registry resolver work. No business actions yet.

## Step 2.1 — Utils, Sheets helper, dispatcher

**Prompt:**
```
Read CLAUDE.md Sections 2, 3.1, 3.8, 9.1 (Apps Script file map).

Build three Apps Script files:

1. apps-script/Utils.gs
   - jsonResponse(obj), okResponse(data),
     errResponse(code, message, fieldErrors)
   - nowIso(), todayIso(), generateUuid()
   - normalizeBoolean(v) → true only if v===true or 'TRUE'
   - normalizeIsoDate(v) → 'YYYY-MM-DD' or '' (handle Sheet date serials)
   - nextId(prefix, existingIds) → zero-padded next id

2. apps-script/Sheets.gs — low-level helpers that take a SPREADSHEET as first arg
   (because we open many spreadsheets by id):
   - openById(id) → Spreadsheet (throws if missing)
   - getSheet(ss, name), readAllRows(ss, name),
     readRowByKey(ss, name, keyCol, keyVal),
     appendRow(ss, name, obj), updateRowByKey(ss, name, keyCol, keyVal, updates),
     deleteRowByKey(ss, name, keyCol, keyVal)
   - Cache each sheet's header row per request.
   - A CONFIG_SS_ID constant at the top of the file holds the config sheet id.
     This is the ONLY sheet id that appears in code, and it lives here in the Apps
     Script only — never in the frontend.

3. apps-script/Main.gs — the dispatcher:
   - doGet(e) → okResponse({service:'Settlement Checker API', version:'1.0'})
   - doPost(e): try/catch → server_error on throw; parse JSON (validation_failed
     'malformed_json' on failure); read action/token/payload; missing action →
     validation_failed 'missing_action'. Switch on action; for Stage 2 only 'ping'
     returns okResponse({pong:true, at:nowIso()}); everything else →
     validation_failed 'unknown_action'.

Do not implement real actions yet.
```

**Tests for 2.1:**
- [ ] Deploy → New deployment → Web App, "Execute as: Me", "Anyone" access; copy the URL
- [ ] GET the URL → `{"ok":true,"data":{"service":"Settlement Checker API","version":"1.0"}}`
- [ ] POST `{"action":"ping"}` → `{"ok":true,"data":{"pong":true,...}}`
- [ ] POST `{"action":"nope"}` → `unknown_action`
- [ ] POST `not json` → `malformed_json`

## Step 2.2 — Config, Auth, Session, Registry

**Prompt:**
```
Read CLAUDE.md Sections 3.2, 3.3, 3.8, 4, and 2.4.

Build:

1. apps-script/Config.gs
   - getConfigMap() reads the config sheet (CONFIG_SS_ID) Config tab into an object
   - handleGetConfig() → app_name, company_name, primary_language,
     session_expiry_hours only. No token.
   - handleUpdateConfig(session, payload) → manager-only, whitelisted keys.

2. apps-script/Auth.gs
   - validateSession(token) → {session, user} or throw {code:'unauthenticated'}.
     Read Sessions by token (config sheet); check expires_at; read Users by user_id;
     check active. Attach role.
   - requireManager(session) → throw {code:'forbidden'} unless user.role==='manager'.
   - handleLogin(payload): validate username+password_hash; case-insensitive match in
     Users; delete all existing Sessions for the user_id; create token row with
     expires_at = now + session_expiry_hours; set last_login_at; return
     {token, user:{user_id, display_name, display_name_ar, role}, must_change_password}.
     NEVER return coordinator_sheet_id.
   - handleLogout(session) → delete session row.

3. apps-script/Registry.gs
   - resolveCoordinatorSheet(session): reject unless role==='coordinator'; read the
     session user's coordinator_sheet_id from Users; openById it; return the
     Spreadsheet. The id comes from the SESSION user row only — never from payload.
   - forEachCoordinator(fn): read all active coordinator Users, openById each,
     call fn(user, ss). Used by manager/export actions.

4. Update Main.gs: wire get_config, login (no token); for all other actions call
   validateSession first, catch {code} → errResponse. Wire logout, update_config.

Hashing is client-side SHA-256; Apps Script only compares hash strings.
```

**Tests for 2.2:**
- [ ] Put a SHA-256 hex of a test password into the manager's `password_hash` (use an online SHA-256 tool)
- [ ] POST `login` with that manager → returns a token; a second login returns a new token and leaves one Sessions row
- [ ] POST `logout` → `{ok:true}`; the token no longer validates
- [ ] Wrong hash → `unauthenticated`

---

# Stage 3 — Frontend Shell + Login

**Goal:** The browser opens the app, asks once for the Apps Script URL, hits `get_config`, and shows a working login that talks to Apps Script and routes by role.

## Step 3.1 — index.html, tokens, base, main, api, i18n

**Prompt:**
```
Read CLAUDE.md Sections 5, 8, 9.1.

Build:
1. index.html — loads css/tokens.css, base.css, components.css (grid.css and
   template.css can be linked but empty for now); loads SheetJS from a pinned CDN
   <script>; loads js as ES modules ending with js/main.js. A single <div id="app">.
2. css/tokens.css — EXACTLY the :root token block from CLAUDE.md Section 8.3. No other
   colors anywhere in the project reference hex directly.
3. css/base.css + components.css — buttons, cards, badges (incl. badge-old amber /
   badge-new blue), inputs, selects, modal, toast, using tokens only. Logical
   properties only. Match the reference's feel: 8px radii, navy-tinted shadows.
4. js/i18n/en.js, ar.js, i18n.js — t(key), setLang(lang) sets <html dir>. Seed keys
   for the chrome and login.
5. js/api.js — reads sc_script_url from localStorage (prompt once if missing),
   api.call(action, payload) POSTs {action, token, payload}, injects the in-memory
   token, returns data or throws typed errors. Never caches.
6. js/state.js — in-memory session {token, user}; getLang/setLang; the localStorage
   DRAFT cache helpers (sc_draft_*). Token is memory-only; never in localStorage.
7. js/auth/login.js — renderLogin + bindLoginEvents: hashes the password with
   js/utils/hash.js (SHA-256), calls login, stores session in memory, routes to
   #/dashboard (or change-password if must_change_password).
8. js/main.js — boot: ensure script url, get_config, setLang(primary_language),
   show login; then hand off to js/router.js (stub that renders a placeholder
   dashboard per role for now).

Every visible string via t(). No hardcoded hex outside tokens.css.
```

**Tests for 3.1:**
- [ ] First load prompts for the Apps Script URL, stores it in `localStorage.sc_script_url`
- [ ] Login screen renders in the new look (indigo button, navy brand, warm bg)
- [ ] Logging in as the manager routes to a placeholder manager dashboard; a coordinator routes to a placeholder coordinator dashboard
- [ ] EN/AR toggle flips the whole UI to RTL
- [ ] Wrong password shows an inline error, not a crash

## Step 3.2 — Change-password + session refresh

**Prompt:**
```
Read CLAUDE.md Section 4.

Build js/auth/changePassword.js (renderChangePassword + bind): on force_password_change,
require a new password, hash client-side, call reset_user_password for self, clear the
flag, continue to dashboard. On refresh with no in-memory token, return to login. A
coordinator's cached grid drafts (sc_draft_*) must survive the refresh.
```

**Tests:**
- [ ] A user with `force_password_change=TRUE` is forced through the screen before anything else
- [ ] Refresh returns to login (token was memory-only); any cached draft is still in `localStorage`

---

# Stage 4 — Router, Shells, and Admin plumbing

**Goal:** Real routing and the two role shells. Manager sidebar + coordinator top bar. Admin tabs reachable.

**Prompt:**
```
Read CLAUDE.md Sections 5, 8.4, 9.1.

Build:
1. js/router.js — hash routes from CLAUDE.md 5.2. Redirect cross-role routes to
   #/dashboard. Call the right render+bind for each route.
2. js/components/topbar.js — coordinator top bar (brand, name, lang, sign out).
3. js/components/sidebar.js — manager sidebar (Dashboard, Approvals, Export, Admin
   with sub-tabs Teams / Site→JC / People / Lists). Active-route highlight.
4. js/manager/dashboard.js and js/coordinator/dashboard.js — real-ish dashboards
   (stats can be placeholder until their data actions exist).

No business logic beyond navigation yet.
```

**Tests for Stage 4:**
- [ ] Manager sees the sidebar; coordinator sees the top bar
- [ ] A coordinator typing `#/approvals` in the URL is bounced to `#/dashboard`
- [ ] Admin sub-tabs route correctly
- [ ] RTL mirrors the sidebar to the right

---

# Stage 5 — Admin data (Teams, Site→JC, People, Lists)

**Goal:** Managers can manage the shared config the coordinator grid depends on — build this before the grid so autofill and dropdowns have real data.

## Step 5.1 — Apps Script admin actions

**Prompt:**
```
Read CLAUDE.md Section 3.4.

Build apps-script/Admin.gs with all manager-only actions (requireManager at the top):
- list_users, create_user, update_user, reset_user_password, deactivate_user
  (cannot deactivate the last active manager; create/update set coordinator_sheet_id
  for coordinators only)
- list_teams, create_team, update_team (toggle active; never delete)
- list_site_jc, upsert_site_jc, bulk_import_site_jc (array of {site_id, job_code,
  task_date}, keyed on site_id + job_code, period DERIVED from task_date, replaces
  the tab by default), delete_site_jc (optional job_code)
- list_lists, update_lists
Wire them all into Main.gs.
```

**Tests:** POST each action as the manager; confirm reads/writes land in the config sheet; confirm a coordinator token gets `forbidden`; confirm the last-manager guard.

## Step 5.2 — Admin frontend

**Prompt:**
```
Read CLAUDE.md Sections 3.4, 8. Build the four admin screens:
- js/admin/teams.js — list, add, activate/deactivate
- js/admin/siteJc.js — table with old/new badges and task dates; add/edit a row;
  "Upload Excel" that parses the Site ID-JC tracking .xlsx client-side with
  xlsx-js-style (js/utils/xlsx.js), splits its combined `Site ID-JC` cell on the
  last hyphen into {site_id, job_code, task_date} rows, previews added/changed/
  removed, and calls bulk_import_site_jc (full replace); flip period inline
- js/admin/users.js — the registry: list people, add/edit (coordinator rows take a
  sheet id), deactivate; reset password
- js/admin/lists.js — edit projects/categories/areas/drivers/months
All strings via t(); old=amber, new=blue badges from tokens.
```

**Tests:** Add a team → it appears for coordinators later. Upload a small SiteJC xlsx → rows upsert. Add a coordinator with a sheet id → they can log in.

---

# Stage 6 — The Coordinator Grid (the core)

**Goal:** A coordinator opens a settlement and records expense/fuel entries in an Excel-like grid with all five behaviours, validated live, saved and confirmed per track. Build this in sub-steps and test each.

## Step 6.1 — Apps Script coordinator actions

**Prompt:**
```
Read CLAUDE.md Sections 3.5, 6.1, 6.2, 6.3.

Build apps-script/Coordinator.gs (each action: validateSession, reject unless
role==='coordinator', resolve the sheet via Registry.resolveCoordinatorSheet(session)):
- get_my_settlements → Settlements + a status roll-up per period (old/new) derived
  from that period's entries
- create_settlement {month, account, old_tracking_no, new_tracking_no}
- update_settlement — only while that track has no exported rows
- list_entries {settlement_id, kind}
- save_entries {settlement_id, kind, rows[]} — bulk upsert of draft rows; reject any
  row whose stored status is 'exported'; for any row currently 'approved' whose
  meaningful fields changed, set status='confirmed' and clear approved_by/at
  (rule 12); set audit fields server-side
- delete_entry {settlement_id, kind, entry_id} — only if status is 'draft' or
  'returned' (DELETABLE_STATUSES); delete_entries takes a list and refuses the rest
  by name rather than failing the batch
- confirm_track {settlement_id, period} — set that period's draft rows to confirmed;
  refuse if the matching tracking number is unset, or if any row of that period fails
  validation (use Validate.gs)

Also build apps-script/Validate.gs mirroring CLAUDE.md 6.3 (missing site, zero amount,
missing required field, fuel KM continuity as a warning, unknown-site warning). Flags
block confirm; warnings do not.
Wire into Main.gs.
```

**Tests for 6.1:** create a settlement; save a couple of draft rows; confirm new track → rows become confirmed; try confirming with a zero amount → refused; edit an (manually set) approved row via save_entries → it reverts to confirmed.

## Step 6.2 — Grid render + in-place editing

**Prompt:**
```
Read CLAUDE.md Sections 5.3, 6.5, 6.6, 8.

Build js/coordinator/settlement.js (renderSettlementPage): the settlement header
(month, account, old/new tracking inputs) + a grid host with Expenses/Fuel tabs, a
live total, validation banner, and Save / Confirm Old / Confirm New buttons.

Build js/coordinator/grid.js (renderGrid + bindGridEvents) and css/grid.css:
- Editable table; inputs for text/number cells, selects for project/category/area/
  team/period. Columns per CLAUDE.md 2.2.
- Cell edits update an in-memory row model and mirror to localStorage
  (sc_draft_<settlement_id>_<kind>) on every change. DO NOT re-render on every
  keystroke; update cells in place. Only re-render on add/delete row, and restore
  focus + caret afterward.
- Add row / delete row. New row carries down team, project, month, day, period from
  the row above (rule 6.6.2).
- Keyboard: Enter → same column, next row (add a row if at the end).
- Live validation via js/utils/validate.js; flag rows red, warn rows amber; banner
  lists issues. Total in the footer.
Seed the grid from list_entries, then overlay any newer localStorage draft.
```

**Tests for 6.2:** type entries; refresh mid-edit → draft restored from localStorage; Enter adds/moves rows; delete works; total updates; a zero amount flags the row and the banner.

## Step 6.3 — Autofill + paste

**Prompt:**
```
Read CLAUDE.md Section 6.6.

Build js/coordinator/gridAutofill.js: on Site ID change, look up SiteJC (fetched once
per session); fill job_code and period; for a slash-joined Site ID, look up each
segment and join job codes in order; flag any unknown segment (leave its jc blank,
warn). A site may hold several job codes — pick the one whose task_date is latest on
or before the entry's day (fiscal_year + month + day), offer the rest in the cell, and
re-pick when month or day changes. A coordinator may override period or job code, and
once he does, autofill leaves that field alone.

Build js/coordinator/gridPaste.js: a paste of tab-separated rows (from Excel) appends
multiple rows, mapping columns in the documented order, running autofill per row. Also
support a "Paste from Excel" button that opens a textarea for the same.
```

**Tests for 6.3:** type `K3666` → `CABH559` + new; type `377/442` → `CABH783/CABH789`, old (first known segment wins period); paste three rows → three rows added with JCs filled.

## Step 6.4 — Save / Confirm wiring

**Prompt:**
```
Read CLAUDE.md Sections 3.5, 6.1.

Build js/coordinator/confirm.js and wire the buttons:
- Save draft → save_entries for the active kind; toast success; clear the matching
  localStorage draft once the server confirms the write.
- Confirm Old / Confirm New → save then confirm_track for that period; refuse client-
  side if that tracking number is blank or flags remain, with a clear message.
Refresh the header roll-up after confirm.
```

**Tests for 6.4:** Save persists to the sheet; Confirm New moves only new rows; old rows stay draft; confirming with a blank New tracking number is refused.

---

# Stage 7 — Manager Approvals

**Goal:** A manager sees every coordinator's confirmed entries consolidated and approves or returns each, stamped with who decided; old and new move independently.

## Step 7.1 — Apps Script manager actions

**Prompt:**
```
Read CLAUDE.md Section 3.6.

Build apps-script/Manager.gs (requireManager):
- list_pending {team?, coordinator?, period?, month?} → forEachCoordinator, collect
  confirmed/approved/returned entries, attach coordinator display name and the
  resolved Tracking# (from that coordinator's settlement by period). Paged.
- approve_entry {coordinator_user_id, kind, entry_id} → resolve that coordinator's
  sheet from the registry, set approved + approved_by/at.
- return_entry {coordinator_user_id, kind, entry_id, note} → set returned + return_note.
- approve_batch {filter} → approve all matching confirmed rows.
Reject exported rows in all three. Wire into Main.gs.
```

**Tests:** as the manager, list_pending returns the coordinator's confirmed rows; approve one → approved + your name; return one with a note; both reject an exported row.

## Step 7.2 — Approvals frontend

**Prompt:**
```
Read CLAUDE.md Sections 3.6, 8. Build js/manager/approvals.js: a consolidated table
(coordinator, entry, site, jc, category/fuel, amount, team, period+Tracking#, status)
with Approve / Return per row, filters (team / coordinator / period / month), and a
"Approve all pending" action. Return opens a note modal. Old=amber, new=blue badges.
Approved rows stamped with the approving manager's name.
```

**Tests:** approve/return update the row and the coordinator sees the return note back in his grid; filters work; approving new leaves old untouched.

---

# Stage 8 — Export

**Goal:** A manager exports per team + period, Normal or Per-site, mirroring the template, with server-side dedup so nothing settles twice.

## Step 8.1 — Apps Script export actions

**Prompt:**
```
Read CLAUDE.md Sections 3.7, 6.4, 7.

Build apps-script/Export.gs (requireManager):
- export_query {team, month, period, exclude_exported} → forEachCoordinator, collect
  approved rows matching team+month+period (exclude exported unless told otherwise),
  attach coordinator name and the period's Tracking#. Return expenses and fuel rows
  separately.
- export_commit {team, month, period, report_type} → RE-SELECT the same predicate
  server-side, stamp each row exported + export_batch_id + exported_at (atomic pass),
  append an ExportLog row, return {batch_id, row_count}. This is the only writer of
  exported=TRUE.
Wire into Main.gs.
```

**Tests:** query returns approved, un-exported rows; commit stamps them and logs a batch; a second query no longer returns them; two quick commits don't double-stamp (second returns 0 rows).

## Step 8.2 — Export frontend + template + per-site

**Prompt:**
```
Read CLAUDE.md Sections 6.4, 7, 8.

Build:
- js/utils/explode.js — explodeRow(row, kind): split slash-joined site_id/job_code
  into ordered pairs; divide amount (expense) or fuel_amount + karta_amount (fuel)
  across n with divideAmount (round to 2dp, remainder on the last site); COPY
  start_km/end_km unchanged; single-site rows pass through. Include unit tests in a
  testExplode() you can run in the console: 200 across 5 → 40×5; 200 across 3 →
  66.67, 66.67, 66.66.
- js/manager/exportTemplate.js — build the Expenses Tracking and Fuel Tracking sheet
  data with the header block (Name, Account, Total), the big Old/New marker, and the
  Arabic footer (المدير المسؤل / مدير الحسابات / إعتماد) with the Tracking# and date.
- js/utils/xlsx.js — SheetJS: turn the template sheet data into a workbook and trigger
  a download named e.g. TeamAshraf_NEW_T26_Aug2026.xlsx.
- js/manager/export.js — the screen: pick team + month + report type (Normal /
  Per-site) + "exclude already-exported"; Generate calls export_query, renders a
  preview for each period (old and new) as a styled template (css/template.css), and
  offers Download + Confirm export. Confirm calls export_commit then re-queries.
  Show the ExportLog below.
```

**Tests for Stage 8:**
- [ ] Normal export downloads a workbook with the two sheets, header, footer, correct Tracking# per period
- [ ] Per-site export explodes the 200/5 line into five 40 rows; KM columns unchanged
- [ ] Confirm export makes those rows vanish from the next query and adds an ExportLog row
- [ ] Old and new produce separate files with their own tracking numbers

---

# Stage 9 — Bilingual + RTL Audit + Deploy

## Step 9.1 — Audit

**Prompt:**
```
Read CLAUDE.md Section 8. Audit the whole app:
- Every visible string goes through t() and exists in both en.js and ar.js.
- No physical CSS properties anywhere (grep for margin-left/right, padding-left/right,
  left:, right:, text-align:left/right) — replace with logical properties.
- No hardcoded hex outside css/tokens.css.
- In AR mode: numbers, Site IDs, Job Codes, money stay LTR (.num), the grid and the
  export template read correctly RTL, the sidebar mirrors.
List every violation and fix it.
```

**Tests:** toggle AR on every screen; confirm the grid, approvals table, and export template are usable and correct in RTL.

## Step 9.2 — Deploy

**Prompt:**
```
Confirm manifest.json + service-worker.js follow the LMP PWA pattern: cache the app
shell and JS/CSS with stale-while-revalidate, and NEVER cache any response from the
Apps Script Web App or any non-GET request. Bump APP_VERSION on every deploy — it
names the cache AND is what makes an open app offer its "new version" reload prompt
(js/updates.js), since a browser only watches service-worker.js for changes.
Then confirm push-to-main is the only deploy step and GitHub Pages serves root.
```

**Tests:** installable PWA; offline it opens the shell (coordinator's cached draft is readable); the Apps Script URL prompt appears on a fresh device; bump APP_VERSION, push, and an already-open tab offers Reload within half an hour (or immediately when its tab is brought back to the front).

---

# Stage 10 — Full QA Checklist

**Auth & sessions**
- [ ] Login issues a token; a second login invalidates the first
- [ ] Token is memory-only; refresh returns to login; cached grid draft survives
- [ ] `force_password_change` is enforced first
- [ ] Wrong password → `unauthenticated`, clean error

**Isolation & roles**
- [ ] A coordinator action never reaches another coordinator's sheet, even with a forged `user_id`/sheet id in the payload
- [ ] A coordinator token gets `forbidden` on every approval/export/admin action
- [ ] Last active manager cannot be deactivated

**Settlement & grid**
- [ ] Two tracking numbers per settlement; old and new confirm independently
- [ ] Autofill fills JC + period; multi-site cells join JCs in order and flag unknowns
- [ ] Paste and carry-down and keyboard nav all work
- [ ] Zero amount / missing site block confirm; KM gap warns but doesn't block
- [ ] Editing an approved row reverts it to confirmed and clears the approval
- [ ] An exported row is locked against edit, re-approve, re-export

**Approvals**
- [ ] Consolidated across all coordinators; approve/return stamped with the manager
- [ ] Return note reaches the coordinator's grid

**Export**
- [ ] Per team + period; only approved, un-exported rows; exclude-exported respected
- [ ] Template header/marker/footer/Tracking# correct for old and new
- [ ] Per-site divides money (expense + fuel + karta), never KM; remainder on last site; rows re-sum exactly
- [ ] Commit is atomic; a row can never appear in two files; ExportLog written

**Bilingual & cross-cutting**
- [ ] EN/AR on every screen; RTL correct; numbers/IDs stay LTR
- [ ] No hardcoded hex outside tokens.css; logical CSS only
- [ ] `js/api.js` is the only file calling Apps Script; no Sheet id in the frontend

---

# Stage 11 — Cutover

## Step 11.1 — Onboard coordinators one at a time
- [ ] For each coordinator: create their Google Sheet (Settlements/Expenses/Fuel tabs), add a `Users` row with `role=coordinator` and that sheet's id in `coordinator_sheet_id`
- [ ] Have them run one real month in the app alongside the old workbook and reconcile the two finance files before trusting it
- [ ] Populate `SiteJC` fully (upload the real Site ID-JC tracking file) before wide use, so autofill and the old/new split are correct. Re-upload it whenever a new export is issued — the upload replaces the tab, and the task dates in it are what decide old vs new

## Step 11.2 — Go live
- [ ] Once one coordinator's month reconciles to the workbook, cut that coordinator over and stop their workbook
- [ ] Add remaining coordinators the same way; the app is unchanged as each joins — only a new sheet and a `Users` row
- [ ] Managers work entirely from Approvals + Export; the workbook is retired per coordinator as they cut over
