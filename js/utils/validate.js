/**
 * validate.js — the grid's live validation (CLAUDE.md 6.3).
 *
 * This is the CLIENT half of a pair. `apps-script/Validate.gs` computes the same
 * answers on save and confirm, and the two must agree: the codes here are the
 * codes the server returns, so a row the grid paints red is the same row
 * `confirm_track` refuses. When one side changes, the other changes with it.
 *
 * One warning is client-only — `mixed_period`, see checkMixedPeriod(). It reads a
 * per-site answer that only exists where the entry's date has been resolved
 * against the lookup, and being a warning it blocks nothing, so no rule ends up
 * enforced on one side alone.
 *
 * The split that matters is FLAG versus WARNING:
 *
 *   - A **flag** is a row that cannot be settled — no Site ID, no amount, a
 *     missing required field. Flags block Confirm.
 *   - A **warning** is a row that is probably wrong but might not be — a KM
 *     reading that does not follow on, a site the lookup has never heard of.
 *     Warnings are shown in amber and block nothing, because 6.3 is explicit
 *     that an unknown site still confirms.
 *
 * Nothing here blocks typing. A draft is allowed to be half-finished; that is
 * what a draft is.
 */

import { isKnownListValue } from './lists.js';

/** Codes that block Confirm. Same list as VALIDATION_FLAG_CODES in Validate.gs. */
export const FLAG_CODES = [
  'missing_site_id',
  'missing_amount',
  'missing_month',
  'missing_day',
  'missing_project',
  'missing_category',
  'missing_item_description',
  'missing_area',
  'missing_driver',
  'missing_city',
  'missing_start_km',
  'missing_end_km',
  'missing_karta_amount',
  'missing_team'
];

/**
 * Every cell that must carry SOMETHING before a row can be confirmed.
 *
 * The project owner's rule is "all fields filled except the comment", and this
 * table is that rule written down. Mirrored by REQUIRED_ENTRY_FIELDS in
 * Validate.gs — when one moves, the other moves with it.
 *
 * Three fields are deliberately NOT here:
 *
 *   - `comment` — excluded by the rule itself. It is the one optional cell.
 *   - `job_code` and `period` — these stay amber (WARNING_CODES). 6.3 is
 *     explicit that a site missing from the Site→JC lookup still confirms, and
 *     both of these are filled FROM that lookup (rule 14). Flagging them would
 *     make a coordinator unable to settle a real expense because an admin has
 *     not imported the site yet — a wall he cannot climb himself.
 *
 * `site_id` and the amount are checked by hand below rather than listed here,
 * because neither is a plain "is it blank" test.
 */
const REQUIRED_TEXT_FIELDS = {
  expense: [
    ['month', 'missing_month'],
    ['day', 'missing_day'],
    ['project', 'missing_project'],
    ['category', 'missing_category'],
    ['item_description', 'missing_item_description'],
    ['team', 'missing_team']
  ],
  fuel: [
    ['month', 'missing_month'],
    ['day', 'missing_day'],
    ['project', 'missing_project'],
    ['area', 'missing_area'],
    ['driver', 'missing_driver'],
    ['city', 'missing_city'],
    ['team', 'missing_team']
  ]
};

/**
 * Numeric cells that must be filled but MAY hold zero.
 *
 * This is the difference between them and `amount` / `fuel_amount`, where zero
 * counts as missing (6.3): an expense that settles nothing is a mistake, but a
 * trip with no karta spend and an odometer that genuinely reads 0 are both real
 * facts. So the test here is "did the coordinator type anything", not "is it
 * greater than zero".
 */
const REQUIRED_NUMBER_FIELDS = {
  expense: [],
  fuel: [
    ['start_km', 'missing_start_km'],
    ['end_km', 'missing_end_km'],
    ['karta_amount', 'missing_karta_amount']
  ]
};

/** Codes that are shown but never block. */
export const WARNING_CODES = [
  'unknown_site',
  'missing_job_code',
  'missing_period',
  'job_code_count_mismatch',
  'mixed_period',
  'unknown_list_value',
  'km_gap'
];

/**
 * Validate every row of one grid.
 *
 * Takes the WHOLE grid rather than one row, because KM continuity is not a
 * per-row question: a fuel row is compared against the previous row for the same
 * driver, ordered by day. Validating rows one at a time would never find it.
 *
 * Rows are addressed by POSITION, not by entry_id — a row the coordinator has
 * just typed has no id yet, and it still has to be able to go red.
 *
 * @param {string} kind 'expense' | 'fuel'
 * @param {Array<Object>} rows the grid's in-memory row model.
 * @param {Object} [options]
 * @param {Object|null} [options.siteJcMap] uppercased site_id -> Array of
 *        candidate {job_code, task_date, period} (a site holds one per task
 *        raised against it, 2.1). These checks only ask whether a site is there.
 *        When absent, the lookup checks are skipped rather than guessed at — see
 *        checkSiteAgainstLookup().
 * @param {Object|null} [options.listOptions] field -> the reference list that
 *        field's cell must come from, e.g. `{ month: ['Aug', …], team: […] }`.
 *        Built by the grid from its own column definitions. Absent means the
 *        client never loaded the lists and cannot judge — see checkListValues().
 * @return {{rows: Array<{flags: Array, warnings: Array}>, flagCount: number,
 *           warningCount: number, flaggedRows: Array<number>, byCode: Object}}
 */
export function validateRows(kind, rows, options = {}) {
  const list = rows || [];
  const siteJcMap = options.siteJcMap || null;
  const listOptions = options.listOptions || null;

  const report = {
    rows: [],
    flagCount: 0,
    warningCount: 0,
    flaggedRows: [],
    byCode: {}
  };

  for (let i = 0; i < list.length; i++) {
    report.rows.push(validateRow(kind, list[i], siteJcMap, listOptions));
  }

  if (kind === 'fuel') applyKmContinuity(list, report);

  for (let i = 0; i < report.rows.length; i++) {
    const row = report.rows[i];

    report.flagCount += row.flags.length;
    report.warningCount += row.warnings.length;
    if (row.flags.length) report.flaggedRows.push(i);

    // Counted by code so the banner can say "3 rows have no amount" rather than
    // repeating the same sentence three times.
    [].concat(row.flags, row.warnings).forEach(function (issue) {
      if (!report.byCode[issue.code]) {
        report.byCode[issue.code] = { code: issue.code, level: issue.level, count: 0, firstRow: i };
      }
      report.byCode[issue.code].count++;
    });
  }

  return report;
}

/**
 * Everything that can be judged from one row on its own.
 *
 * @param {string} kind 'expense' | 'fuel'
 * @param {Object} row
 * @param {Object|null} siteJcMap
 * @param {Object|null} [listOptions] field -> reference list (6.6.4).
 * @return {{flags: Array<Object>, warnings: Array<Object>}}
 */
export function validateRow(kind, row, siteJcMap, listOptions) {
  const isFuel = kind === 'fuel';
  const flags = [];
  const warnings = [];

  const flag = function (code, field, detail) { flags.push({ code, field, detail, level: 'flag' }); };
  const warn = function (code, field, detail) { warnings.push({ code, field, detail, level: 'warning' }); };

  /*
   * An exported row is locked and has already been settled (rule 13). Judging it
   * now would light up the grid over money that has left the building, and the
   * coordinator could not act on it in any case.
   */
  if (String(row.status || '').toLowerCase() === 'exported') {
    return { flags, warnings };
  }

  /* --- the fields nothing works without --- */
  const siteCell = text(row.site_id);
  if (!siteCell) flag('missing_site_id', 'site_id');

  const amountField = isFuel ? 'fuel_amount' : 'amount';
  const amount = toNumber(row[amountField]);

  // Zero counts as missing (6.3): an entry that settles nothing is a mistake,
  // not a zero-value fact.
  if (amount === null || amount === 0) flag('missing_amount', amountField);

  /* --- everything else the rule says must be filled (except comment) --- */
  (REQUIRED_TEXT_FIELDS[kind] || []).forEach(function (entry) {
    if (!text(row[entry[0]])) flag(entry[1], entry[0]);
  });

  // Filled, but zero is a legitimate value — see REQUIRED_NUMBER_FIELDS.
  (REQUIRED_NUMBER_FIELDS[kind] || []).forEach(function (entry) {
    if (toNumber(row[entry[0]]) === null) flag(entry[1], entry[0]);
  });

  /* --- the lookup: warnings only --- */
  checkSiteAgainstLookup(siteCell, row, siteJcMap, warn);

  /*
   * A row with no period is routed to neither Tracking# (6.2), so Confirm will
   * pass it by. Amber rather than red: this is the normal state of a row whose
   * site is not in the lookup yet, and 6.3 says such a row still confirms.
   */
  if (!period(row.period)) warn('missing_period', 'period');

  checkMixedPeriod(row, warn);
  checkListValues(row, listOptions, warn);

  return { flags, warnings };
}

/**
 * A dropdown cell holding something its list has never heard of (6.6.4).
 *
 * Amber, not red, and one warning per offending cell so the column itself goes
 * amber rather than the coordinator having to hunt for which of six list cells is
 * the wrong one.
 *
 * A warning because two innocent things produce it. An option deactivated after
 * the row was typed still describes what actually happened, and the row must not
 * become unconfirmable because an admin tidied a list; and a team named on paper
 * before it reaches the Teams tab is a real Tuesday. What it is NOT is harmless:
 * the export filters on `team` by value (Manager.gs), so a team that matches no
 * team is a row that quietly appears in no finance file at all. That is exactly
 * the kind of absence nobody notices, which is why it is surfaced here even
 * though it blocks nothing.
 *
 * Case and spacing are not the coordinator's problem — `AUG` against a list that
 * says `Aug` is rewritten to the list's spelling before it ever gets here
 * (utils/lists.js, and Coordinator.gs on the way into the sheet). What reaches
 * this check is a value that genuinely matches nothing.
 *
 * @param {Object} row
 * @param {Object|null} listOptions field -> the list that field comes from.
 * @param {Function} warn
 */
function checkListValues(row, listOptions, warn) {
  if (!listOptions) return;

  Object.keys(listOptions).forEach(function (field) {
    const value = text(row[field]);
    if (!value) return;                       // blank is a different problem

    if (isKnownListValue(value, listOptions[field])) return;
    warn('unknown_list_value', field, { field: field, value: value });
  });
}

/**
 * A multi-site row whose sites do not all belong to the same period.
 *
 * The row settles against ONE Tracking# (6.2), so half of it would be filed
 * under the wrong one — the fix is to split the line, which is the coordinator's
 * call and not something to do behind his back. Amber, therefore, and not red:
 * 6.3's blocking list is fixed, and a line that has to go out today under one
 * number is better than a Confirm that will not run.
 *
 * Read from `__site_periods`, which gridAutofill hangs off the row: the period of
 * a site depends on WHICH job code the row's day picked (6.6.3), and that is
 * resolved where the date is known. This is the one check with no mirror in
 * Validate.gs — the server has no date-resolved candidate to compare — and it
 * blocks nothing, so nothing is enforced only on the client.
 *
 * @param {Object} row
 * @param {Function} warn
 */
function checkMixedPeriod(row, warn) {
  const segments = row.__site_periods || [];
  const seen = [];

  segments.forEach(function (segment) {
    const value = period(segment.period);
    if (value && seen.indexOf(value) === -1) seen.push(value);
  });

  if (seen.length > 1) warn('mixed_period', 'period', { periods: seen });
}

/**
 * Check a Site ID cell against the lookup.
 *
 * A cell may hold several sites joined by `/` (2.2), so each segment is looked
 * up in turn. Matching ignores case — real site lists carry `k3799` beside
 * `K3666`, and a coordinator typing from paperwork must still find the row.
 *
 * When `siteJcMap` is null the site checks are SKIPPED rather than guessed. A
 * coordinator cannot currently read the lookup (`list_site_jc` is manager-only),
 * and warning "unknown site" on every row because the client has no lookup would
 * be worse than saying nothing.
 *
 * @param {string} siteCell
 * @param {Object} row
 * @param {Object|null} siteJcMap
 * @param {Function} warn
 */
function checkSiteAgainstLookup(siteCell, row, siteJcMap, warn) {
  const jobCell = text(row.job_code);

  if (siteCell && siteJcMap) {
    const sites = splitMulti(siteCell);
    const unknown = sites.filter(function (site) {
      return !siteJcMap[site.toUpperCase()];
    });

    if (unknown.length) warn('unknown_site', 'site_id', { sites: unknown });
  }

  if (!siteCell) return;

  if (!jobCell) {
    warn('missing_job_code', 'job_code');
    return;
  }

  /*
   * The per-site export pairs site i with job code i (6.4). Different counts
   * means the money would be divided against the wrong job codes — the warning
   * here most worth acting on.
   */
  const sites = splitMulti(siteCell);
  const codes = splitMulti(jobCell);

  if (sites.length !== codes.length) {
    warn('job_code_count_mismatch', 'job_code', { sites: sites.length, job_codes: codes.length });
  }
}

/**
 * KM continuity (6.3): within one driver, a row's start_km should equal the
 * previous row's end_km.
 *
 * Grouped by driver and ordered by day, then by position in the grid — an
 * odometer is one running sequence, and the two periods have nothing to do with
 * it. A row missing a reading is skipped rather than guessed at, and does not
 * break the chain: the next row is compared against the last reading actually
 * recorded.
 *
 * @param {Array<Object>} rows all fuel rows, in grid order.
 * @param {Object} report from validateRows(); its rows are appended to.
 */
function applyKmContinuity(rows, report) {
  const byDriver = {};

  rows.forEach(function (row, index) {
    if (String(row.status || '').toLowerCase() === 'exported') return;

    const driver = text(row.driver).toUpperCase();
    if (!driver) return;               // already flagged as missing_driver

    if (!byDriver[driver]) byDriver[driver] = [];
    byDriver[driver].push({ index, row });
  });

  Object.keys(byDriver).forEach(function (driver) {
    const group = byDriver[driver].slice().sort(function (a, b) {
      const dayA = toNumber(a.row.day);
      const dayB = toNumber(b.row.day);
      if ((dayA || 0) !== (dayB || 0)) return (dayA || 0) - (dayB || 0);
      return a.index - b.index;
    });

    let previousEnd = null;

    group.forEach(function (item) {
      const startKm = toNumber(item.row.start_km);
      const endKm = toNumber(item.row.end_km);

      if (previousEnd !== null && startKm !== null && startKm !== previousEnd) {
        report.rows[item.index].warnings.push({
          code: 'km_gap',
          field: 'start_km',
          level: 'warning',
          detail: { expected: previousEnd, found: startKm }
        });
      }

      if (endKm !== null) previousEnd = endKm;
    });
  });
}

/* ------------------------------------------------------------------ *
 * Coercion — shared with the grid, and matching Validate.gs
 * ------------------------------------------------------------------ */

/**
 * A cell as a number.
 *
 * Returns null, not 0, for blank or unparseable: the difference between "no
 * amount typed" and "an amount of zero" is the whole point of missing_amount.
 * Grouping commas and stray currency text are stripped, because a cell pasted
 * from Excel carries them.
 *
 * @param {*} value
 * @return {number|null}
 */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;

  const raw = String(value).trim();
  if (!raw) return null;

  const cleaned = raw.replace(/,/g, '').replace(/[^\d.\-+eE]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;

  const parsed = Number(cleaned);
  return isFinite(parsed) ? parsed : null;
}

/**
 * Split a `/`-joined cell into trimmed, non-empty segments.
 * @param {*} value
 * @return {Array<string>}
 */
export function splitMulti(value) {
  return text(value)
    .split('/')
    .map(function (part) { return part.trim(); })
    .filter(function (part) { return part !== ''; });
}

/**
 * @param {*} value
 * @return {string} trimmed string form.
 */
export function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * @param {*} value
 * @return {string} 'old' | 'new' | ''
 */
export function period(value) {
  const raw = text(value).toLowerCase();
  return (raw === 'old' || raw === 'new') ? raw : '';
}
