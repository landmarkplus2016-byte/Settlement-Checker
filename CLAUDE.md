# CLAUDE.md — Settlement Checker
> This file is Claude Code's persistent memory for this project.
> Read this at the start of every session before writing any code.

---

## What We Are Building

A two-role web app that replaces the Excel workbook coordinators currently use to settle field **expense** and **fuel** claims. Instead of editing a spreadsheet by hand and emailing it to a manager, the coordinator records his entries in an Excel-like grid inside the app, the app validates them, and he confirms. Managers then review every coordinator's confirmed entries in one consolidated place, approve them entry by entry, and extract the finance Excel files that go to the finance team.

- **Coordinators (several):** Record expense and fuel entries in a grid, validate, and confirm. Each coordinator writes to **his own Google Sheet**. A coordinator only ever sees and touches his own data.
- **Managers (several):** See every coordinator's confirmed entries **consolidated across all coordinator sheets**, approve or return each entry, and export finance files per team and period. Managers also manage shared config (teams, the Site→Job-Code lookup, and people). Any manager can act on any coordinator's data.
- **1 developer (project owner):** The only person with direct Google Sheet and Apps Script access. Everyone else uses the app.
- Hosted on **GitHub Pages** (static site — no server).
- **Google Sheets** as the sole database: one shared **config spreadsheet** plus **one spreadsheet per coordinator**, all reached through a **single Google Apps Script Web App**.
- **No Firebase. No npm. No build tools. No frameworks.** Pure HTML, CSS, and vanilla JavaScript, served as-is. Third-party libraries (xlsx-js-style) via CDN only.

---

## What's Different From the Old Workbook

This is not a digitised copy of the spreadsheet. It is a rebuild of the *workflow* the spreadsheet was carrying by hand.

| Concern | Old workbook | Settlement Checker (this repo) |
|---|---|---|
| Where data lives | An Excel file emailed around | Google Sheets — one config sheet + one sheet per coordinator |
| Coordinator's tool | Types into the workbook | Excel-like grid in the app, validated as he types |
| Getting to the manager | Emails the file | Confirms in the app; the manager sees it consolidated instantly |
| Manager review | Opens the file, edits, re-sends | Approves or returns each entry in the app, stamped with who decided |
| Old vs new sites | A "New" label typed in the header | Driven by the Site→JC lookup's `period`; routes each row to its own Tracking# |
| Two tracking numbers | Managed by hand | One settlement holds an **old** and a **new** Tracking# that move independently |
| Finance export | Manual copy/filter/save | App extracts per team + period, mirrors the template, and stamps rows so nothing settles twice |
| Per-site cost split | Done by hand, if at all | A per-site export explodes multi-site lines and divides the amount automatically |
| Double-settlement | Caught (or missed) by eye | Server-side dedup: an exported row can never be pulled into a second file |

The old workbook stays in use until the app reaches parity for one coordinator. Cut over one coordinator at a time.

---

## Tech Stack — Plain HTML/CSS/JS, No Build Tools

Intentionally framework-free and build-tool-free, exactly like the OHS Platform and LMP Attendance:

- **No npm, no package.json, no node_modules, no bundler.**
- **No React, no Vue, no framework** — UI is plain JS functions that return HTML strings (template literals) inserted via `innerHTML`.
- **No Tailwind** — plain CSS files using CSS custom properties (design tokens) in `css/tokens.css`.
- **Third-party libs via CDN only** — **xlsx-js-style** (the `XLSX` global) is loaded with a pinned `<script src="https://cdn...">` in `index.html`. Nothing else. It is SheetJS with cell styling: the free SheetJS build silently drops fonts, fills and borders on write, which made the finance file look nothing like the preview it mirrors (7.2). Same API, so both the export and the Site→JC import run on it.
- **Routing** — hash-based (`#/dashboard`, `#/settlement/<id>`, `#/approvals`, `#/export`, `#/admin/teams`), read from `location.hash`.
- **i18n** — plain JS objects with `en` and `ar` keys. Every visible string goes through `t('key')`.
- **Backend** — a single Google Apps Script Web App deployment, reached only through `js/api.js`.

### Deployment

GitHub Pages serves the repo root directly. No build, no `gh-pages` branch, no `dist/`. Editing a file and pushing to `main` is the entire deploy. The Apps Script is deployed once from the Apps Script editor; its Web App URL lives in `localStorage` as `sc_script_url` on each device — **never in code, never committed**.

**Bump `APP_VERSION` in `service-worker.js` in the same push.** A browser only checks the worker file for changes, so that one line is what tells an already-open app that a new version exists; `js/updates.js` then offers a Reload button instead of leaving people on stale code until they think to hard-refresh. Forgetting the bump ships the files and tells nobody.

---

## User Roles — Quick Reference

| Role | Device | Sees | Key permissions |
|---|---|---|---|
| Coordinator | Desktop (mainly) | Only his own settlements | Create/edit/confirm entries in his own sheet. Cannot see other coordinators. No admin. |
| Manager | Desktop | All coordinators, consolidated | Approve / return any entry. Export finance files. Manage teams, Site→JC lookup, and people. |
| Developer | — | Google Sheets + Apps Script editor | Only person with direct Sheet/Script access. Never uses the Sheets as a data-entry surface. |

> ⚠️ Nobody except the developer opens a Google Sheet directly. Coordinators and managers do everything through the app. The Sheets are a silent database.

---

## Non-Negotiable Rules

Everything downstream depends on these. Never break one without confirming with the project owner.

### Backend and data

1. **Never call Google Sheets directly from the frontend.** All reads/writes go through `js/api.js` → Apps Script. No exceptions.
2. **The Apps Script URL is never in code.** It lives in `localStorage.sc_script_url`, set on each device's first launch. Never committed.
3. **No Sheet ID ever leaves the Apps Script.** Not the config sheet's, not any coordinator's. The frontend never knows a spreadsheet ID. It names a coordinator by `user_id`; the Apps Script resolves the ID from the registry.
4. **A coordinator can only ever touch his own sheet.** The server resolves the target spreadsheet from the *session's* `user_id`, never from a sheet ID or user_id in the payload. A coordinator cannot read or write another coordinator's sheet even if he forges the request.
5. **Manager-only actions are enforced server-side.** Approval, export, and all admin actions check `role === 'manager'` at the top of the handler. The frontend hides UI for UX; the server is the gate.
6. **Session token on every call except `login` and `get_config`.** Validated at the top of every handler before anything else.
7. **Passwords are always hashed** — SHA-256 hex, in the browser, before sending. Plain text never travels, never lands in Sheets, never appears in logs.
8. **Every write sets `updated_at` / `updated_by` server-side** from the session, never trusted from the client. Same for `approved_by/at`, `exported_at`, and every audit field.

### The settlement lifecycle (the heart of the app)

9. **A settlement is one coordinator + one month.** It carries an `account` (e.g. VF) and **two** tracking numbers: `old_tracking_no` and `new_tracking_no`.
10. **Old and new are two parallel tracks.** Each entry belongs to a `period` (`old` or `new`); that period routes it to the matching Tracking# and lets it move through the lifecycle independently. Confirming, approving, and exporting old never waits on new, and vice-versa.
11. **The status machine is `draft → confirmed → approved → exported`, with `returned` as a side branch.** Only these transitions exist:
    - Coordinator **confirms** a track → its `draft` rows become `confirmed`.
    - Manager **approves** a `confirmed` entry → `approved` (stamps `approved_by/at`).
    - Manager **returns** any `confirmed` or `approved` entry with a note → `returned` (visible to the coordinator).
    - Export **commits** `approved` rows → `exported` (stamps `export_batch_id`, `exported_at`).
12. **Editing an `approved` entry reverts it to `confirmed` and clears the approval.** A coordinator can edit after confirming; the moment he changes an already-approved row, it drops back to `confirmed` and must be re-approved. This is what stops an amount changing after sign-off.
13. **An `exported` entry is locked.** No edits, no re-approval, no second export. This is the dedup guarantee.
14. **`period` comes from the Site→JC lookup, not free typing.** When a Site ID is entered, its `job_code` and `period` auto-fill. A coordinator may override the period on a row, but the default is always the lookup's answer.

### Export

15. **Export is per team + period, and pulls only `approved` and not-yet-`exported` rows.** Nothing that has been exported is ever offered again unless the manager explicitly asks to re-include.
16. **Committing an export is server-side and atomic.** The server re-selects the same predicate and stamps the rows `exported` in one pass (claim-then-build), so two managers exporting the same team at once cannot double-settle a row.
17. **Every export mirrors the template** — the header block (Name / Account / Total), the big Old/New marker, and the Arabic footer (المدير المسؤل / مدير الحسابات / إعتماد) with the period's Tracking# and the date.
18. **The per-site export divides money, never KM.** A multi-site line (`site_id` joined by `/`) explodes into one row per site; `amount`, `fuel_amount`, and `karta_amount` are split; `start_km` / `end_km` are copied unchanged. See Section 6.4 for the exact rounding.

### Frontend architecture

19. **No backend calls from any file except `js/api.js`.** Pages call `api.call('action', payload)`.
20. **Hash-router only.** GitHub Pages has no server routing.
21. **One file, one job.** See the File Map (Section 9.1).
22. **All UI text through `t('key')`.** Every key exists in both `en.js` and `ar.js`.
23. **No hardcoded hex outside `css/tokens.css`.** Reference the CSS variable.
24. **Logical CSS properties only** (`margin-inline-start`, never `margin-left`) — the app is bilingual and flips to RTL.

### Governance

25. **Cannot deactivate the last manager.** Validated server-side.
26. **User management is manager-only.**
27. **Never add a feature not in this file without confirming with the project owner.**

---

## Non-Goals (Explicit)

- **No field-team import.** For now coordinators type their own entries; no field Excel comes in. The grid's paste-from-Excel is a convenience for the coordinator's own data, not an import pipeline. (When the field app later writes to Sheets, that is a separate project.)
- **No offline admin/manager editing.** Managers have desks. The only local-first surface is the coordinator's grid draft (Section 6.5); confirming still needs connectivity.
- **No real-time collaboration.** Two people editing the same row is last-write-wins.
- **No notifications.** No email/SMS/push. People check the app.
- **No file storage.** The only files produced are the finance `.xlsx` downloads; nothing is uploaded or kept.
- **No Grand Total / JC / Karta / EXP-Final computed tabs.** The app exports the two entry layouts (Expenses Tracking, Fuel Tracking) plus the per-site tab. The finance team builds the rest their own way.
- **No "download everything."** The Sheets are the database.

---

# Section 2 — Google Sheets Schema

Two kinds of spreadsheet. Once locked, the API (Section 3), session model (Section 4), and app structure (Section 5) all reference this.

## Design principles

1. **Config is shared; entries are per-coordinator.** One config spreadsheet everyone reads; one entry spreadsheet per coordinator that only he (and managers, via the server) writes.
2. **Every row has a stable primary key.** Never reuse, never rename, never derive from a mutable field.
3. **Status and tracking are stored; totals and per-site splits are derived at export time.**
4. **Deletion is status, not row removal.** Draft rows a coordinator deletes before confirming are the one exception; anything confirmed or later is never hard-deleted — it is returned, or it stays with its status.

## 2.1 The config spreadsheet — `Settlement Config DB`

One spreadsheet, shared, owned by the developer. Tabs:

**`Config`** — key/value platform settings.

| key | example | purpose |
|---|---|---|
| `app_name` | Settlement Checker | |
| `company_name` | Landmark Plus | |
| `primary_language` | en | `en` or `ar` |
| `session_expiry_hours` | 12 | |
| `fiscal_new_from_year` | 2026 | sites dated in this year or later default to `new` (used only when a site is absent from the lookup) |

**`Users`** — accounts **and** the coordinator→sheet registry in one tab.

| Column | Type | Purpose |
|---|---|---|
| `user_id` | text | Primary key (e.g. `U-004`) |
| `username` | text | Login, case-insensitive |
| `password_hash` | text | SHA-256 hex, set client-side |
| `display_name` | text | English name |
| `display_name_ar` | text | Arabic name (shown in AR mode) |
| `role` | text | `coordinator` \| `manager` |
| `coordinator_sheet_id` | text | The coordinator's own spreadsheet ID. **Blank for managers.** Never sent to the client. |
| `active` | boolean | Deactivation instead of deletion |
| `force_password_change` | boolean | First-login reset |
| `last_login_at` | ISO datetime | Server-set |
| `created_at` / `updated_at` / `updated_by` | | Server-set |

**`Sessions`** — active login tokens, cleaned nightly.

| Column | Type | Purpose |
|---|---|---|
| `token` | text | Primary key (UUID) |
| `user_id` | text | FK |
| `role` | text | Cached for fast dispatch |
| `created_at` / `expires_at` | ISO datetime | |
| `device_id` | text | From the client, informational |

**`Teams`** — the fixed, add-to / deactivate-able list of named crews.

| Column | Type | Purpose |
|---|---|---|
| `team_id` | text | Primary key (e.g. `T-003`) |
| `name` | text | Display name (e.g. "Team Ashraf") |
| `active` | boolean | Inactive teams stay off new entries; old entries keep their team |
| `created_at` / `updated_at` / `updated_by` | | Server-set |

**`SiteJC`** — the shared Site ID → Job Code lookup, with period. This is what folds "JC Finder" into entry.

| Column | Type | Purpose |
|---|---|---|
| `site_id` | text | Primary key. A single site, never a slash-joined group |
| `job_code` | text | The site's job code |
| `period` | text | `old` \| `new` — sites before 2026 are `old`, 2026+ are `new` |
| `updated_at` / `updated_by` | | Server-set |

**`Lists`** — dropdown reference data, grouped.

| Column | Type | Purpose |
|---|---|---|
| `list_name` | text | `projects` \| `categories` \| `areas` \| `drivers` \| `months` |
| `value` | text | The option |
| `active` | boolean | |
| `sort_order` | integer | |

**`ExportLog`** — one row per committed export batch.

| Column | Type | Purpose |
|---|---|---|
| `batch_id` | text | Primary key (e.g. `EXP-2026-AUG-NEW-01`) |
| `team` | text | |
| `period` | text | `old` \| `new` |
| `month` | text | |
| `fiscal_year` | text | |
| `tracking_no` | integer | The period's Tracking# |
| `report_type` | text | `normal` \| `persite` |
| `row_count` | integer | |
| `exported_by` | user_id | Server-set from session |
| `exported_at` | ISO datetime | Server-set |

## 2.2 A coordinator spreadsheet — one per coordinator

Named e.g. `Settlement — Mahmoud Shaarawy`, owned by the developer, ID stored in that coordinator's `Users.coordinator_sheet_id`. Tabs:

**`Settlements`** — one row per coordinator-month.

| Column | Type | Purpose |
|---|---|---|
| `settlement_id` | text | Primary key (e.g. `S-2026-08`) |
| `month` | text | |
| `fiscal_year` | text | |
| `account` | text | e.g. `VF` — batch-level, set once |
| `old_tracking_no` | integer | The Old track's Tracking# |
| `new_tracking_no` | integer | The New track's Tracking# |
| `created_at` / `updated_at` / `updated_by` | | Server-set |

**`Expenses`** — one row per expense line.

| Column | Type | Purpose |
|---|---|---|
| `entry_id` | text | Primary key (e.g. `E-000123`) |
| `settlement_id` | text | FK |
| `month` / `day` | text / int | |
| `project` | text | From `Lists.projects` |
| `site_id` | text | One site, or several joined by `/` |
| `job_code` | text | Auto-filled from `SiteJC`; matching order for multi-site |
| `period` | text | `old` \| `new` — routes to the settlement's tracking number |
| `category` | text | From `Lists.categories` |
| `item_description` | text | Free text (often Arabic) |
| `amount` | number | EGP |
| `comment` | text | |
| `team` | text | From `Teams` (active) |
| `status` | text | `draft` \| `confirmed` \| `approved` \| `returned` \| `exported` |
| `approved_by` / `approved_at` | | Server-set on approve; cleared on revert |
| `return_note` | text | Set on return; the coordinator sees it |
| `exported` | boolean | |
| `export_batch_id` / `exported_at` | | Server-set on commit |
| `created_at` / `updated_at` / `updated_by` | | Server-set |

**`Fuel`** — one row per fuel line. Same envelope columns (`entry_id`, `settlement_id`, `month`, `day`, `project`, `site_id`, `job_code`, `period`, `team`, `status`, `approved_*`, `return_note`, `exported`, `export_batch_id`, `exported_at`, audit) plus the fuel-specific fields:

| Column | Type | Purpose |
|---|---|---|
| `start_km` / `end_km` | number | KM readings — **never split** on per-site export |
| `fuel_amount` | number | EGP — split on per-site export |
| `area` | text | From `Lists.areas` |
| `driver` | text | From `Lists.drivers` |
| `city` | text | |
| `karta_amount` | number | EGP — split on per-site export |

## 2.3 Data-type conventions

- Dates are ISO `YYYY-MM-DD` strings. `day` is a plain integer 1–31; `month` is a three-letter label matching `Lists.months`.
- Booleans are the strings `TRUE`/`FALSE` in Sheets; `normalizeBoolean` coerces on read.
- Money is a plain number in EGP, no currency symbol stored. The symbol is a display concern.
- IDs are prefixed (`U-`, `T-`, `S-`, `E-`, `F-`, `EXP-`) and zero-padded where numeric.

## 2.4 Server-side lookups

The Apps Script keeps a per-request cache of: the config map, the `Users` registry (so it can resolve `user_id → coordinator_sheet_id` and role), the active `Teams`, the `SiteJC` map, and `Lists`. Coordinator sheets are opened by ID **only** via `Registry.resolveCoordinatorSheet(session)` — which reads the ID from the session's user row, never from the payload.

---

# Section 3 — Apps Script API Surface

## 3.1 Transport and envelope

**Single endpoint, action-dispatched.** One `doPost(e)`; the body names an `action`, a `token`, and a `payload`.

**Request shape**
```json
{ "action": "confirm_track", "token": "<uuid>", "payload": { "settlement_id": "S-2026-08", "period": "new" } }
```

**Response envelope**
```json
{ "ok": true, "data": { ... } }
{ "ok": false, "error": "unauthenticated", "message": "...", "field_errors": null }
```

**Fixed error codes:** `validation_failed`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `server_error`.

**`js/api.js` contract:** the only file that talks to Apps Script. Exposes `api.call(action, payload)`, injects the token from the in-memory session, throws typed errors the pages catch. Never caches a response.

## 3.2 Authentication (2)

- **`login`** — `{username, password_hash, device_id}`. Case-insensitive username; compares hashes as strings; deletes any existing Sessions for the user (single active session); returns `{token, user:{user_id, display_name, display_name_ar, role}, must_change_password?}`. **Never returns `coordinator_sheet_id`.**
- **`logout`** — deletes the session row.

## 3.3 Config (2)

- **`get_config`** — no token. Returns `app_name, company_name, primary_language, session_expiry_hours` only.
- **`update_config`** — manager-only; whitelisted keys.

## 3.4 Admin — manager-only (registry, teams, lookup, lists) (11)

- **`list_users`** / **`create_user`** / **`update_user`** / **`reset_user_password`** / **`deactivate_user`** — manage the Users tab (which *is* the registry). `create_user`/`update_user` set `coordinator_sheet_id` for coordinators. Cannot deactivate the last active manager.
- **`list_teams`** / **`create_team`** / **`update_team`** — add or toggle `active`. Never hard-delete.
- **`list_site_jc`** / **`upsert_site_jc`** / **`bulk_import_site_jc`** / **`delete_site_jc`** — the lookup. `bulk_import_site_jc` takes rows parsed from an uploaded Excel (client parses with xlsx-js-style, sends JSON) and upserts by `site_id`. `period` is required on every row.
- **`list_lists`** / **`update_lists`** — dropdown reference data.

## 3.5 Coordinator — own sheet only (7)

Every one resolves the target spreadsheet from the session, and rejects if `role !== 'coordinator'`.

- **`get_my_settlements`** — the caller's Settlements with a derived status roll-up per track (old/new).
- **`create_settlement`** — `{month, account, old_tracking_no, new_tracking_no}`.
- **`update_settlement`** — edit month/account/tracking numbers (only while the relevant track has no `exported` rows).
- **`list_entries`** — `{settlement_id, kind}` → rows for the grid.
- **`save_entries`** — bulk upsert of `draft` rows to the caller's sheet (this is the grid's Save). Rejects any row whose current stored status is `exported`. **If a row being saved is currently `approved` and its values changed, the server reverts it to `confirmed` and clears `approved_by/at`** (rule 12).
- **`delete_entry`** — remove a single `draft` row (the only hard-delete in the app).
- **`confirm_track`** — `{settlement_id, period}` → sets that settlement's `draft` rows of that period to `confirmed`. Requires the matching tracking number to be set.

## 3.6 Manager — consolidated across coordinators (4)

- **`list_pending`** — `{team?, coordinator?, period?, month?}` → loops the registry, opens each coordinator sheet, returns `confirmed` / `approved` / `returned` entries with the coordinator name and resolved Tracking# attached. Paged.
- **`approve_entry`** — `{coordinator_user_id, kind, entry_id}` → `approved`, stamps `approved_by/at`. (Manager may target any coordinator; the server resolves that coordinator's sheet from the registry — the one place a manager action reaches another user's sheet, gated by `role==='manager'`.)
- **`return_entry`** — `{coordinator_user_id, kind, entry_id, note}` → `returned`, stores `return_note`.
- **`approve_batch`** — optional convenience: approve all `confirmed` rows matching a filter in one call.

## 3.7 Export — manager-only (2)

- **`export_query`** — `{team, month, period, exclude_exported}` → the `approved` rows for that team+month+period across all coordinators (excluding `exported` unless told otherwise), plus the resolved Tracking# and the coordinator name for the header. The client renders Normal or Per-site and builds the `.xlsx` with xlsx-js-style. The **per-site explosion is computed client-side** for display and the file (Section 6.4), because it is a pure transform of returned rows.
- **`export_commit`** — `{team, month, period, report_type}` → **re-selects the same predicate server-side**, stamps those rows `exported` + `export_batch_id` + `exported_at`, writes an `ExportLog` row, returns `{batch_id, row_count}`. This is the atomic claim (rule 16). The client only downloads the file it already built; the commit is what makes the rows disappear from future queries.

## 3.8 Cross-cutting rules

- **Timestamps and authorship** are always server-set from the clock and the session. Client audit fields are ignored.
- **ID generation** is server-side, prefixed and zero-padded, allocated under the sheet's lock.
- **Session validation** runs at the top of every action except `login` and `get_config`.
- **Coordinator isolation:** coordinator actions resolve the sheet from `session.user_id` only. A `coordinator_sheet_id` or foreign `user_id` in a coordinator payload is a `forbidden`.
- **Unknown action** → `validation_failed` / `unknown_action`.

---

# Section 4 — Session and Auth Model

## 4.1 Lifecycle

Login issues a UUID token with a fixed expiry (`session_expiry_hours`, default 12). Single active session per user — a new login deletes the old session row. The token is validated server-side on every authenticated call.

## 4.2 Token storage on the client

- **Managers (desktop):** token in memory only. A refresh re-prompts login. (Same posture as the OHS admin.)
- **Coordinators (desktop):** token in memory. The grid's *draft data* is cached in `localStorage` (Section 6.5) so a refresh never loses typing, but the token itself is not persisted.

## 4.3 Passwords

SHA-256 hex in the browser (`js/utils/hash.js`) before the request. `force_password_change` sends the user to the change-password screen before anything else.

## 4.4 Refresh behaviour

On load: read `sc_script_url` (prompt for it once if absent), call `get_config`, then show login. A coordinator with cached draft data sees it restored on the settlement screen after he logs back in.

## 4.5 Nightly cleanup

A time-driven Apps Script trigger deletes expired Sessions rows.

---

# Section 5 — App Structure

## 5.1 Two roles, one shell

After login both roles get the **same shell** — the deep-navy left sidebar beside a content area. Only what the rail lists differs:

- **Coordinator:** Dashboard (his settlements), plus the settlement he currently has open as a sub-item. Screens: **Dashboard**, **Settlement** (the grid).
- **Manager:** Dashboard, Approvals, Export, Admin. Admin has sub-tabs: Teams, Site→JC, People, Lists.

The role comes from the session and is never chosen in the UI. `renderSidebar()` reads it and picks the nav; `paint()` in `router.js` has no role branch.

> The coordinator had a slim white top bar until 2026-08-28, on the reasoning that two screens do not need a nav rail. The project owner asked for one shell so the app reads as one product. `js/components/topbar.js` is gone; `roleLabel()` and `initial()` moved into `sidebar.js`.

**Getting into the grid:** the coordinator dashboard's **New settlement** button (`create_settlement`) is the only way a settlement comes into being, and a settlement row is the only way into `#/settlement/<id>`. Without that button a coordinator with no settlements has no route to the entry grid at all.

## 5.2 Routing

Hash routes, handled in `js/router.js`:

| Route | Role | Screen |
|---|---|---|
| `#/dashboard` | both | role dashboard |
| `#/settlement/<id>` | coordinator | the grid |
| `#/approvals` | manager | consolidated review |
| `#/export` | manager | export builder |
| `#/admin/teams` `#/admin/sitejc` `#/admin/people` `#/admin/lists` | manager | admin tabs |

A coordinator hitting a manager route (or vice-versa) is redirected to `#/dashboard`. The server enforces the real boundary regardless.

## 5.3 Rendering

Plain functions returning HTML strings, inserted via `innerHTML`, then a matching `bind*Events` wires listeners. The grid is the one screen that manages its own in-place cell updates without a full re-render on every keystroke (Section 6.5).

---

# Section 6 — Settlement Logic

## 6.1 The status machine

```
        confirm_track            approve_entry           export_commit
draft ───────────────► confirmed ──────────► approved ──────────────► exported (locked)
  ▲                        │                     │
  │  edit (save_entries)   │ return_entry        │ return_entry
  └────────────────────────┴─────────────────────┘  ──► returned ──► (coordinator edits) ──► draft
```

- **Old and new run this machine independently.** A `confirm_track` names a period; it only moves that period's rows.
- **Revert on edit of approved (rule 12):** `save_entries` compares each incoming row to stored; if an `approved` row's meaningful fields changed, it becomes `confirmed` and the approval is cleared.
- **Exported is terminal.** `save_entries`, `confirm_track`, `approve_entry`, and `return_entry` all reject an `exported` row.

## 6.2 Tracking-number resolution

For any entry: `period === 'old' → settlement.old_tracking_no`, else `settlement.new_tracking_no`. The Tracking# is never stored on the entry — it is resolved from the settlement at read/export time, so correcting a settlement's number fixes every row at once.

## 6.3 Validation (client, mirrored server-side on save/confirm)

Computed live in the grid and re-checked in `save_entries` / `confirm_track`:

- **Missing Site ID** → row flagged, blocks confirm.
- **Zero / empty amount** (`amount` for expense, `fuel_amount` for fuel) → row flagged, blocks confirm.
- **Missing required field** (project, category for expense; driver for fuel) → flagged.
- **Fuel KM continuity** → within one driver, a row's `start_km` should equal the previous row's `end_km`; a gap is an amber warning (does not block, but is surfaced).
- **Unknown site in lookup** → if a Site ID (or a segment of a multi-site cell) is absent from `SiteJC`, warn and leave `job_code`/`period` for the coordinator to set. Confirm is allowed; the warning stands.

`confirm_track` refuses if any *flag* (not warning) remains on that period's rows.

## 6.4 Per-site explosion (export only)

A line whose `site_id` contains `/` covers several sites. The **per-site** export turns it into one row per site:

- Split `site_id` and `job_code` on `/` into ordered pairs (site *i* ↔ job code *i*).
- Divide the money across `n` sites: `each = round(total / n, 2)`, and put the remainder on the **last** site so the rows re-sum to the original exactly. Example: `200 / 3 → 66.67, 66.67, 66.66`.
- Split `amount` (expenses) and both `fuel_amount` and `karta_amount` (fuel). **Never** split `start_km` / `end_km` — copy them onto each exploded row unchanged.
- A single-site line passes through as one row at its full amount.

This lives in `js/utils/explode.js` and is used only by the export builder. The Normal export keeps the combined line as-is.

## 6.5 The grid — local-first drafts

The coordinator's grid is the one local-first surface:

- Cell edits update an in-memory row model and are mirrored to `localStorage` under `sc_draft_<settlement_id>_<kind>` on every change, so a refresh or crash never loses typing.
- **Save draft** (`save_entries`) pushes the draft rows to the coordinator's sheet. **Confirm** pushes then confirms.
- We do **not** write to Sheets on every keystroke — Apps Script round-trips are ~1–2 s and would make the grid lag. The localStorage mirror is the safety net between saves.
- On load, the grid seeds from the server rows, then overlays any newer localStorage draft.

## 6.6 The five grid behaviours ("easy as Excel")

1. **Paste from Excel** — a paste of tab-separated rows appends multiple rows; `job_code`/`period` auto-fill per row.
2. **Carry-down** — a new row inherits `team`, `project`, `month`, `day`, and `period` from the row above.
3. **Site → JC + period autofill** — entering a Site ID fills `job_code` and `period` from `SiteJC`; multi-site cells look up each segment and join the codes in order, flagging any unknown segment.
4. **Inline dropdowns** — project / category / area / team / period as in-cell selects.
5. **Keyboard nav** — Tab across, Enter moves to the same column in the next row (adding a row at the end).

---

# Section 7 — Export and the Template

## 7.1 The four possible files

Per team + month, each period can produce two report types, so up to four files: **normal-old**, **normal-new**, **persite-old**, **persite-new**. Each is a separate `.xlsx` with its own period's Tracking# and its own dedup — a row can never appear across two of them.

## 7.2 File layout (mirrors the workbook)

Each file reproduces the two entry layouts:

- **Expenses Tracking** sheet: header block (Name, Account, Total) + the big **Old/New** marker; columns Month, Day, Project, Site ID, Job Code, Category, Item Description, Amount, Comment; the Arabic approval footer with **Tracking#** and date.
- **Fuel Tracking** sheet: header (Fuel total, marker); columns Month, Day, Project, Site ID, Job Code, Start KM, End KM, Fuel, Area, Driver, City, Karta; same footer.
- **Per-site** report type: the same two sheets, but every multi-site line is exploded per Section 6.4, with a "split" indicator column.

Built client-side with xlsx-js-style from the `export_query` rows. `js/manager/exportTemplate.js` owns the header/footer construction **and the file's formatting** — fills, fonts, borders, row heights and the `#,##0.00` money format, with every colour read from `css/tokens.css` at export time so rule 23 holds inside the .xlsx too. `js/utils/xlsx.js` owns the library calls and paints the styles onto the cells.

## 7.3 Dedup and the log

`export_commit` is the only thing that marks rows `exported`. It re-runs the query predicate server-side, stamps the rows, and appends to `ExportLog`. The Export screen shows the log so managers can see what has already gone out and re-issue a batch deliberately if finance loses a file.

---

# Section 8 — i18n, RTL, and Design System

## 8.1 i18n

- Two dictionaries: `js/i18n/en.js`, `js/i18n/ar.js`. Every visible string is `t('key')`. Keys are snake_case.
- Numbers, Site IDs, Job Codes, and money stay LTR even in Arabic (wrap in `.num { direction: ltr; }`).

## 8.2 RTL

- `document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'`.
- **Logical CSS only** — `margin-inline-start`, `padding-inline-end`, `inset-inline-start`. Never `left`/`right` physical properties. This is rule 24 and it is absolute.

## 8.3 Design tokens (the new look — `css/tokens.css`)

Derived from the approved reference (`design/Settlement_App.html`): a vivid indigo action colour over a deep-navy structure, on a warm off-white, with navy-tinted shadows.

```css
:root{
  /* brand / structure */
  --color-navy:#0f1942;          /* sidebar, headers, brand */
  --color-navy-2:#1a1d2e;        /* darkest text */
  --color-navy-3:#232c63;        /* navy accents */

  /* primary action (indigo) */
  --color-primary:#3d5af1;
  --color-primary-hover:#2d47d4;
  --color-primary-light:#dbeafe;
  --color-primary-subtle:#eef0f6;

  /* surfaces */
  --color-bg:#faf9f5;            /* warm off-white app bg */
  --color-surface:#ffffff;
  --color-surface-2:#fafbfd;
  --color-surface-3:#f5f6fa;

  /* text */
  --color-text-primary:#1a1d2e;
  --color-text-secondary:#4a5a72;
  --color-text-muted:#9095b0;
  --color-text-subtle:#aab2d8;
  --color-text-inverse:#ffffff;

  /* borders */
  --color-border:#e2e4ed;
  --color-border-2:#eef0f6;
  --color-border-focus:#3d5af1;

  /* status */
  --color-success:#15803d; --color-success-bg:#dcfce7;
  --color-info:#1e40af;    --color-info-bg:#dbeafe;
  --color-warning:#b45309; --color-warning-bg:#fef3c7; --color-warning-strong:#92400e;
  --color-danger:#991b1b;  --color-danger-bg:#fee2e2;

  /* period markers */
  --color-old-bg:#fef3c7; --color-old-fg:#92400e;
  --color-new-bg:#dbeafe; --color-new-fg:#1e40af;

  /* shadows — navy-tinted, per the reference */
  --shadow-sm:0 1px 2px rgba(16,24,64,.05);
  --shadow-md:0 1px 4px rgba(16,24,64,.10);
  --shadow-lg:0 8px 24px rgba(16,24,64,.14);

  /* radii */
  --radius-sm:6px; --radius-md:8px; --radius-lg:12px; --radius-xl:14px; --radius-pill:999px;

  /* type */
  --font:'Segoe UI',system-ui,-apple-system,'Tahoma',sans-serif;
  --fw-medium:500; --fw-semibold:600; --fw-bold:700; --fw-black:800;

  /* spacing scale: 4 8 12 16 20 24 32 40 */
}
```

- **Coordinator vs manager tint:** no difference. Both use the indigo primary over the same deep-navy sidebar (5.1). No second accent, no per-role tint — spend the boldness on the grid and the export template, keep the chrome quiet.
- **Period colours are semantic** — Old is amber, New is blue, everywhere (badges, markers, export headers).

## 8.4 Components

Buttons, cards, badges, inputs, selects, tables, modal, toast — same primitives as the OHS Platform, restyled to these tokens. The two signature surfaces are the **grid** (`css/grid.css`) and the **export template preview** (styled to look like the workbook). Everything else stays disciplined.

---

# Section 9 — File Map, Naming, What NOT to Do

## 9.1 File map

```
settlement-checker/
  CLAUDE.md
  BUILD.md
  index.html
  manifest.json
  service-worker.js
  icons/
    icon-192.png                 # PWA + favicon
    icon-512.png                 # PWA
    maskable-512.png             # Android, art inside the 80% safe zone
    apple-touch-icon.png         # iOS, opaque ground (iOS fills alpha with black)
  assets/
    lmp-logo-white.png           # the company logo, sidebar head
  design/
    Settlement_App.html          # approved visual reference (read-only)
    lmp-logo-white-master.png    # logo master; icons/ and assets/ are derived from these
    app-icon-master.png
  css/
    tokens.css                   # ALL colors/radii/shadows live here
    base.css
    components.css
    grid.css                     # the Excel-like grid
    template.css                 # export template preview
    print.css
  js/
    main.js                      # boot: script url, get_config, login, route
    router.js
    api.js                       # the ONLY file that calls Apps Script
    state.js                     # in-memory session + localStorage draft cache/queue
    updates.js                   # service-worker registration + "new version" prompt
    i18n/  en.js  ar.js  i18n.js
    utils/
      hash.js                    # SHA-256
      dates.js  money.js  dom.js
      validate.js                # grid validation (Section 6.3)
      explode.js                 # per-site split (Section 6.4)
      xlsx.js                    # xlsx-js-style wrappers + cell styling
    components/
      sidebar.js  modal.js  toast.js  badge.js  table.js
    auth/
      login.js  session.js  changePassword.js
    coordinator/
      dashboard.js               # renderCoordinatorDashboard
      settlement.js              # renderSettlementPage (header + grid host)
      grid.js                    # renderGrid + bindGridEvents (in-place cell logic)
      gridPaste.js               # paste-from-Excel
      gridAutofill.js            # Site → JC + period
      confirm.js                 # confirm old / new
    manager/
      dashboard.js
      approvals.js               # renderApprovals + approve/return
      export.js                  # renderExport + query/commit
      exportTemplate.js          # header/footer + sheet construction
    admin/
      teams.js  siteJc.js  users.js  lists.js
  apps-script/
    Main.gs                      # doGet/doPost dispatcher
    Utils.gs
    Sheets.gs                    # low-level row helpers
    Config.gs
    Auth.gs                      # login/logout/validateSession
    Registry.gs                  # resolveCoordinatorSheet(session), loop-all-coordinators
    Coordinator.gs               # the 7 coordinator actions
    Manager.gs                   # list_pending / approve / return
    Export.gs                    # export_query / export_commit + dedup
    Admin.gs                     # users/teams/sitejc/lists
    Validate.gs                  # server mirror of grid validation
```

## 9.2 Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Render functions | camelCase + `render` prefix | `renderSettlementPage`, `renderApprovals` |
| Event binders | camelCase + `bind` prefix | `bindGridEvents` |
| Utilities | camelCase | `explodeRow`, `resolveTracking`, `divideAmount` |
| Sheet column keys | snake_case | `job_code`, `old_tracking_no` |
| Apps Script actions | snake_case | `confirm_track`, `export_commit` |
| Error codes | snake_case | `forbidden`, `validation_failed` |
| i18n keys | snake_case | `confirm_old`, `per_site_export` |
| CSS classes | kebab-case | `.grid-cell`, `.badge-old` |
| Files | camelCase, matches main export | `exportTemplate.js` → `renderExportTemplate` |
| localStorage keys | `sc_` prefix | `sc_script_url`, `sc_draft_S-2026-08_expense` |

## 9.3 What NOT to Do

- Never add `package.json`, `node_modules`, or any npm dependency; never introduce a bundler or build step; never use a framework.
- Never call Sheets directly from the frontend. Every read/write goes through `js/api.js` → Apps Script.
- Never hardcode the Apps Script URL in code. It lives in `localStorage.sc_script_url`.
- Never put a Sheet ID anywhere outside the Apps Script — not the config sheet's, not any coordinator's.
- Never let a coordinator action target a sheet by ID or by a `user_id` in the payload. The server resolves the sheet from the **session**. This is the coordinator-isolation guarantee.
- Never let a non-manager reach approval, export, or admin actions. Server-side `role` check at the top of each.
- Never send a plain-text password. SHA-256 in the browser first.
- Never store the session token in `localStorage`. Memory only. (Draft grid data in `localStorage` is fine; the token is not.)
- Never hard-delete anything except a `draft` entry via `delete_entry`. Confirmed-and-later rows are returned, never deleted.
- Never store a Tracking# on an entry. Resolve it from the settlement by `period` (Section 6.2).
- Never let old and new share a lifecycle step. `confirm_track`, approval, and export each act on one period.
- Never keep an `approved` stamp on a row whose values changed. `save_entries` reverts it to `confirmed` (rule 12).
- Never edit, re-approve, or re-export an `exported` row. It is locked (rule 13).
- Never mark a row `exported` anywhere but `export_commit`, and never non-atomically. The re-select-and-stamp is the dedup (rule 16).
- Never split KM on the per-site export. Only `amount`, `fuel_amount`, `karta_amount` divide; the remainder cent goes on the last site (Section 6.4).
- Never write to Sheets on every keystroke. The grid is local-first; Sheets writes happen on Save and Confirm (Section 6.5).
- Never rebuild the grid via `innerHTML` on every keystroke without restoring focus and caret. Update cells in place; only re-render on structural change (add/delete row), and restore focus after.
- Never hardcode a hex color outside `css/tokens.css`.
- Never use a physical CSS property (`margin-left`, `right`, …). Logical only — the app flips to RTL.
- Never hardcode a visible string in JS. Always `t('key')`, present in both `en.js` and `ar.js`.
- Never deactivate the last active manager. Server-side check on every user mutation.
- Never add a feature not in this file without confirming with the project owner.
