# REWRITE-PLAN.md — team settlements, auto tracking numbers, one date

> **Temporary.** Delete this file once the build lands and CLAUDE.md has absorbed it (Phase 7, step 31).
> Locked decision record: https://claude.ai/code/artifact/d3badd2d-1d01-4acc-87fc-2b25da2b2c17
> Agreed with the project owner 2026-09-07. Nothing here is open for re-litigation — build it as written.

---

## The two changes

**A — the settlement belongs to a team, and tracking numbers issue themselves.**
**B — one `date` per entry row, replacing `month` + `day`.**

They ship as **one push**: A cannot drop the settlement's month without B's dates to derive one from.

---

## The 33 locked decisions

### Teams
`Teams` gains `code`, `next_tracking_no`, `next_settlement_no`, all editable on Admin → Teams.
Codes are Latin so ids stay LTR in file names and cells (§8.1).

| team_id | code | team | next # |
|---|---|---|---|
| T-001 | MS | محمود الشعراوى فتحى احمد | 21 |
| T-002 | YM | يسرى محمد محمد مصطفى | 7 |
| T-005 | MA | محمود احمد عبد الموجود | 5 |
| T-006 | KW | كريم وليد عبدالرؤوف بدوى | 3 |
| T-007 | MSM | محمد سيد محمود عبد الرازق | 1 |
| T-008 | SD | سعد عبد السميع منصور | 21 |
| T-009 | MSA | مصطفى احمد محمد | 3 |
| T-010 | KM | كرم سيد حسانين محمود | 1 |
| T-011 | EF | ايهاب فايق محمد حسن | 1 |
| T-012 | FA | فاروق عاطف | 1 |
| T-013 | AS | عياد شحات امبابى | 14 |
| T-014 | TA | طاهر عبد الله محمد | 1 |
| T-015 | MW | محمود وحيد عبد الرازق حسن | 7 |
| T-004 | — | Saad Abdelsamiee Mansour — **already deactivated** | — |

The numbers are the highest already issued per team, read from `ExportLog`. The owner types them
after deploy; there is no seed script and none is needed (nothing was in flight at cutover).

### The settlement
1. Belongs to **one team**. Stores `team_id` **and** the team name — the id drives the counters, so a rename can never orphan a settlement (this is the Saad lesson).
2. **No `month`.** Dropped entirely as an input.
3. Team changeable only while every row is `draft`/`returned`.
4. Creation dialog is **Team · Account**. Two fields.
5. Id `S-MS-01`, sequence per team from `next_settlement_no` in the **config** sheet, so it is unique across all coordinators. Never reused.

### Tracking numbers
6. Issued automatically at `confirm_track`, from `next_tracking_no`, under `withScriptLock`.
7. One running sequence per team spanning old and new, in confirm order. Two teams may hold the same number; that is correct.
8. Allocated **only if the track has none** — a top-up confirm reuses the number it already has.
9. Manual override kept: a **Change** link on the settlement header; the counter bumps past it. Blocked once the track is exported.
10. `findTrackingClash` retires — the central counter replaces it, and unlike the old check it works across coordinators.

### The date
11. One `date` column replaces `month` + `day` on both tabs, **appended as a new last column** (readers map by header, so position is irrelevant and appending cannot shift existing data).
12. Typing is **day-first**, rewritten on blur to `11-Aug-26`. See the table below.
13. A date outside the settlement's span goes **amber**, blocks nothing. (Real case: `S-2026-08` legitimately holds Sep 1–3.)
14. Validation warnings suppressed on `exported` rows.

| typed | result |
|---|---|
| `11` | 11 of the **row above's** month and year; today's if there is no row above |
| `11-9` `11/9` `11.9` | 11 Sep, year taken the same way |
| `11-9-26` `11-9-2026` | 11 Sep 2026 |
| `11-sep` `11-SEP-26` `11-sep-2026` | 11 Sep 2026 |
| `2026-09-11` | ISO — four digits first means year first |
| anything else | stays as typed, red, blocks confirm |

Day-first is safe **only because the cell rewrites itself on blur** — that is the mechanism, not a nicety.
Do not make matching fuzzy beyond this.

### Grid & screens
15. Team column **out** of both grids. The server stamps `team` onto each row from the settlement, so it can never be mistyped — this kills the `unknown_list_value` failure where a row appears in no finance file and on no approvals screen.
16. Expense grid 11 → 9 columns; fuel 14 → 12.
17. Carry-down becomes `project, date, period`.
18. Settlement page **title** is the team name, subtitle `S-MA-01 · Account: VF`. Tracking# boxes read-only: *"Issued when you confirm"* → the number → *"fixed"* once exported.
19. Dashboard groups by team, not month.
20. Export screen becomes **team → settlement → period**. The month filter goes.

### The finance file
21. **Month removed from the header block** — back to Name / Account / Total + the Old/New marker, exactly as §7.2 specifies. (The Month cell was added in code beyond the documented template.)
22. One `Date` column (`05-Aug-26`, **text**) replacing Month + Day.
23. File name `<team> — S-MA-01 — NEW — #4.xlsx`.
24. Batch id `EXP-MA-01-NEW-02` — team, settlement, track, which file for that track.
25. `ExportLog` keeps its `month` column, derived from the earliest row's date. Internal only.
26. **Per-site export unchanged** — same 11 columns, same splitting, same button, and the 15 existing batches must still regenerate byte-identically.

### Fixed on the way
27. Rows sorted by `day` alone, ignoring month — see "Bugs being fixed" below.
28. `confirm_track`'s gate inverts; the "needs tracking" modal goes.
29. `sc_draft_*` gets a schema version + migration.
30. Legacy settlements with no team must have one set before they can be confirmed.

### Added by the conflict check
31. A bare day takes **the row above's** month and year, today's if there is none — `rowDefaults()` read the settlement's month, which no longer exists. This corrects decision 12.
32. Settlement page **title** becomes the team (it rendered `Aug 2026` and would have gone blank); dashboard month column becomes the team; settlements sort by `created_at`, since `S-MS-01` no longer runs in date order.
33. **`fiscal_year` stays on the settlement**, set server-side at creation, never shown. `perSiteTemplate.js` rebuilds legacy rows' dates from it — removing it would stop the 15 existing batches regenerating, against decision 26.

---

## Bugs being fixed (verified, not speculative)

**Rows sort by `day` with no month** — `Export.gs:381` (`compareExportEntries`) and `validate.js:386`
(`applyKmContinuity`). Islam Mousa's `S-2026-08` runs Aug 27–31 then Sep 1–3, so batch
`EXP-2026-AUG-NEW-03` printed **Sep 1, 2, 3 above Aug 27** — 13 of 21 expense rows above the August
ones. No money is wrong (order does not touch values or the total); it is a presentation defect, and
the KM continuity check was comparing the same rows out of order. A real date fixes both by
construction.

**Job-code picking uses the settlement's year, not the row's** — `entryDate(fiscalYear, month, day)`
means a December settlement holding January days resolves those rows against the wrong year, which
can flip the Site→JC pick (§6.6.3) and the old/new period. Live today.

---

## Build order

Dependency order, so the Apps Script is coherent before the UI leans on it.

### Phase 0 — counters
- `Admin.gs`: `Teams` gains the three columns, created on first read (do not ask the owner to add them by hand). `list_teams` returns them, counters manager-only. `create_team`/`update_team` validate `code` — 2–4 chars, `A–Z0–9`, unique among active teams.
- New `allocateTeamNumber(teamId, field)` — read, return, increment, inside `withScriptLock`. Shared by both counters.

### Phase 1 — the settlement (`Coordinator.gs`)
- `handleCreateSettlement` (line ~356): require `team_id`, drop `month`, allocate `S-<CODE>-<nn>`, set `fiscal_year` server-side.
- `handleUpdateSettlement` (~429): team gated on all-draft/returned; month rules deleted; manual tracking override bumps the counter.
- `handleConfirmTrack` (~1538): **lines 1550–1555 are the gate that inverts** — allocate when the track has none, reuse when it has, refuse when the settlement has no team.
- `save_entries`: stamp `team` from the settlement, write `date`. `ENTRY_LIST_FIELDS` (line 86) drops `month` and `team`.
- Delete `buildSettlementId`'s month logic (~684), `isKnownMonthLabel` (~650), `findTrackingClash` (~605).

### Phase 2 — the date, server side
- Ensure the `date` column on `Expenses`/`Fuel`.
- **One shared `entryDateOf(row, settlement)`** — `row.date`, else legacy `month + day + fiscal_year`. Every reader goes through it. This is what keeps old rows working.
- `Validate.gs` `REQUIRED_ENTRY_FIELDS`/`REQUIRED_ENTRY_NUMBERS` swap month+day for date, **in lockstep with `validate.js`** — §6.3 says the two lists move together.
- `Export.gs:381` sorts on that date.
- `Manager.gs:232` `entryMatchesFilter` drops month.

### Phase 3 — export (`Export.gs`)
- `export_query` becomes team + settlement + period.
- `export_commit` writes `EXP-MA-01-NEW-02`; derives the log's `month` and `fiscal_year` from the earliest row date.
- `export_batch_rows` **untouched** — it is what keeps the 15 existing batches regenerating.
- Keep `EXPORT_BATCH_SEPARATOR` (`::`, line 64). Its stated reason weakens once ids are globally unique, but the existing log rows use it and changing it buys nothing.

### Phase 4 — frontend utilities
- `dates.js`: add `parseTypedDate()` (day-first rules + row-above fallback). Keep `entryDate()` for legacy. Keep `parseSheetDate()` for pasted Excel cells — pasted *text* falls back to `parseTypedDate()`.
- `validate.js`: required fields; KM continuity (`applyKmContinuity`, ~371) sorted by date; out-of-span amber; warnings suppressed on exported rows.
- `state.js`: `sc_draft_*` schema version + migration (old shape → `date` via `entryDate()`).

### Phase 5 — coordinator screens
- `dashboard.js`: New settlement = Team · Account (drop the two tracking boxes and the month select); team column; sort by `created_at`. Line 204 stops sending `fiscal_year`; line 374 is the month column.
- `settlement.js`: line 409 `<h1>` becomes the team; `rowDefaults()` (758) rewritten per decision 31; `fiscalYear()` (771) kept for legacy rows; tracking boxes read-only + Change link.
- `grid.js`: `COLUMNS` (52–80) — date cell in, month/day/team out. `CARRY_DOWN_FIELDS` (84).
- `gridPaste.js`, `gridAutofill.js` (stops calling `entryDate()`, reads `row.date`), `gridSplit.js`.

### Phase 6 — manager screens
- `export.js`: filter bar becomes team → settlement → period (`renderSettlementFilter`, ~773, becomes the primary control rather than a narrowing).
- `exportTemplate.js`: `HEADER_LABELS.month` (52) removed; `COLUMNS` (78–96) month+day → one Date; `buildFileName` drops month.
- `perSiteTemplate.js`: line 234 uses `entryDateOf`; everything else untouched.
- `approvals.js`: line 944 (`entry.month || entry.settlement.month`) becomes the date-first chain; date column.

### Phase 7 — admin & finish
- `admin/teams.js`: code + counter columns.
- **Both** i18n dictionaries — every new key in `en.js` *and* `ar.js` (rule 22).
- **`APP_VERSION` bump in `service-worker.js`, same push** — without it nobody is told there is a new version.
- CLAUDE.md: §2.1, 2.2, 3.4, 3.5, 3.6, 3.7, 5.2, 6.1, 6.3, 6.6, 7.1, 7.2, 9.1, and rules 9, 14, 15. Then delete this file.

---

## Constraints that still bind

Everything in CLAUDE.md §9.3 still applies. The ones this build brushes against:

- No npm, no framework, no build step. Third-party via CDN only.
- Every read/write through `js/api.js` → Apps Script. No Sheet ID leaves the script.
- Coordinator actions resolve the sheet from the **session**, never from the payload.
- Timestamps and authorship always server-set.
- No hardcoded hex outside `css/tokens.css`; logical CSS properties only; every string through `t()`.
- Never hard-delete anything but a `draft`/`returned` entry, or a settlement all of whose entries are.
- Never store a Tracking# on an entry — resolve it from the settlement by period (§6.2).
- **Old data is never rewritten.** Legacy rows keep `month`, `day`, `team` and are read through fallbacks.

---

## Cutover

1. Owner deploys the Apps Script from the editor (he is the only one with access); frontend goes live on push to `main`.
2. Owner types the 13 codes and 13 starting numbers on Admin → Teams.
3. One settlement end to end: create → type dates → confirm (**check the issued number matches the counter**) → approve → export → per-site.
4. Regenerate one **old** batch's per-site file and confirm it is unchanged — that is the legacy fallback proving itself.

Nothing was in flight at cutover (owner confirmed), and every pre-existing settlement is exported and
locked. That is what makes the no-migration approach safe.
