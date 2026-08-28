/**
 * Validate.gs — the server's mirror of the grid's live validation
 * (CLAUDE.md 6.3).
 *
 * The grid computes these as the coordinator types, so the coordinator sees a
 * problem the moment they make it. This file re-computes the same answers on
 * `save_entries` and `confirm_track`, because a client-side check is a courtesy
 * and a server-side check is the rule.
 *
 * The distinction that matters is FLAG versus WARNING:
 *
 *   - A **flag** is a row that cannot be settled. Missing Site ID, a zero
 *     amount, a missing required field. `confirm_track` refuses while any flag
 *     remains on the rows it would move.
 *   - A **warning** is a row that is probably wrong but might not be. A KM
 *     reading that does not follow on from the last one, a site that is not in
 *     the lookup. These are surfaced and never block — 6.3 is explicit that an
 *     unknown site still confirms, because the lookup being incomplete is the
 *     lookup's problem, not the coordinator's.
 *
 * `save_entries` blocks on neither. A draft is allowed to be half-typed; that is
 * what a draft is.
 *
 * Every code below is snake_case and shows up in the client through
 * t('valid_' + code), so adding one here means adding a string to en.js and
 * ar.js in the same commit.
 */

/** Codes that block `confirm_track` (CLAUDE.md 6.3). */
var VALIDATION_FLAG_CODES = [
  'missing_site_id',
  'missing_amount',
  'missing_project',
  'missing_category',
  'missing_driver'
];

/** Codes that are surfaced but never block. */
var VALIDATION_WARNING_CODES = [
  'unknown_site',
  'missing_job_code',
  'missing_period',
  'job_code_count_mismatch',
  'km_gap'
];

/* ------------------------------------------------------------------ *
 * The entry point
 * ------------------------------------------------------------------ */

/**
 * Validate a whole tab's worth of entries.
 *
 * Takes ALL rows of one kind rather than only the ones a caller cares about,
 * because one of the checks is not per-row: KM continuity compares a fuel row
 * against the previous row for the same driver, and that sequence runs across
 * the whole settlement. Filtering to one period first would invent gaps that
 * are not there.
 *
 * @param {string} kind 'expense' | 'fuel'.
 * @param {Array<Object>} rows raw entry rows.
 * @param {Object} [options]
 * @param {Object} [options.site_jc_map] from getSiteJcMap(); read once by the
 *        caller when it is validating both kinds.
 * @return {{by_entry: Object, rows: Array<Object>, flag_count: number,
 *           warning_count: number, flagged_entry_ids: Array<string>}}
 */
function validateEntries(kind, rows, options) {
  var opts = options || {};
  var siteMap = opts.site_jc_map || getSiteJcMap();
  var isFuel = (kind === 'fuel');

  var report = {
    by_entry: {},
    rows: [],
    flag_count: 0,
    warning_count: 0,
    flagged_entry_ids: []
  };

  var list = rows || [];

  for (var i = 0; i < list.length; i++) {
    var entryId = normalizeKey(list[i].entry_id);

    var result = {
      entry_id: entryId,
      flags: [],
      warnings: []
    };

    validateEntryRow(kind, list[i], siteMap, result);

    report.rows.push(result);
    if (entryId) report.by_entry[entryId] = result;
  }

  // The one cross-row check (6.3).
  if (isFuel) applyKmContinuity(list, report);

  for (var r = 0; r < report.rows.length; r++) {
    var row = report.rows[r];
    report.flag_count += row.flags.length;
    report.warning_count += row.warnings.length;
    if (row.flags.length && row.entry_id) report.flagged_entry_ids.push(row.entry_id);
  }

  return report;
}

/**
 * Everything that can be judged from one row on its own.
 *
 * @param {string} kind 'expense' | 'fuel'.
 * @param {Object} row a raw entry row.
 * @param {Object} siteMap normalized site_id -> {job_code, period}.
 * @param {{flags: Array, warnings: Array}} result appended to in place.
 */
function validateEntryRow(kind, row, siteMap, result) {
  var isFuel = (kind === 'fuel');

  /* --- Site ID: the one field nothing works without --- */
  var siteCell = normalizeKey(row.site_id);
  if (!siteCell) {
    result.flags.push({ code: 'missing_site_id', field: 'site_id' });
  }

  /* --- the money --- */
  var amountField = isFuel ? 'fuel_amount' : 'amount';
  var amount = toFiniteNumber(row[amountField]);

  // "Zero / empty amount" (6.3) — an entry that settles nothing is a mistake,
  // not a zero-value fact.
  if (amount === null || amount === 0) {
    result.flags.push({ code: 'missing_amount', field: amountField });
  }

  /* --- required fields, per kind (6.3) --- */
  if (!normalizeKey(row.project)) {
    result.flags.push({ code: 'missing_project', field: 'project' });
  }

  if (isFuel) {
    if (!normalizeKey(row.driver)) {
      result.flags.push({ code: 'missing_driver', field: 'driver' });
    }
  } else {
    if (!normalizeKey(row.category)) {
      result.flags.push({ code: 'missing_category', field: 'category' });
    }
  }

  /* --- the lookup: warnings only --- */
  if (siteCell) validateSiteAgainstLookup(siteCell, row, siteMap, result);

  /*
   * A row with no period is not routed to either Tracking# (6.2), so
   * confirm_track will pass it by entirely. That is worth an amber marker, but
   * it is NOT a flag: it is the normal state of a row whose site is missing from
   * the lookup, and 6.3 says such a row still confirms. confirm_track reports
   * these separately as `unrouted` so the coordinator learns they were left
   * behind rather than silently losing them.
   */
  if (!normalizePeriod(row.period)) {
    result.warnings.push({ code: 'missing_period', field: 'period' });
  }
}

/**
 * Check a Site ID cell against the lookup.
 *
 * A cell may hold several sites joined by `/` (CLAUDE.md 2.2), so every segment
 * is looked up in turn. Matching ignores case — real site lists carry `k3799`
 * next to `K3666`, and a coordinator typing `K3799` from paperwork must still
 * find the row (the same rule the server applies in Admin.gs).
 *
 * @param {string} siteCell the raw cell.
 * @param {Object} row the entry.
 * @param {Object} siteMap from getSiteJcMap().
 * @param {{flags: Array, warnings: Array}} result appended to in place.
 */
function validateSiteAgainstLookup(siteCell, row, siteMap, result) {
  var sites = splitMultiValue(siteCell);
  var unknown = [];

  for (var i = 0; i < sites.length; i++) {
    if (!siteMap[normalizeSiteId(sites[i])]) unknown.push(sites[i]);
  }

  if (unknown.length) {
    // "warn and leave job_code/period for the coordinator to set. Confirm is
    // allowed; the warning stands." (6.3)
    result.warnings.push({
      code: 'unknown_site',
      field: 'site_id',
      detail: { sites: unknown }
    });
  }

  var jobCell = normalizeKey(row.job_code);

  if (!jobCell) {
    result.warnings.push({ code: 'missing_job_code', field: 'job_code' });
    return;
  }

  /*
   * The per-site export pairs site i with job code i (6.4). If the two cells
   * hold different numbers of segments that pairing is wrong, and the money
   * would be divided against the wrong job codes. Surfaced as a warning because
   * 6.3's blocking list is fixed — but it is the warning most worth acting on.
   */
  var codes = splitMultiValue(jobCell);
  if (sites.length !== codes.length) {
    result.warnings.push({
      code: 'job_code_count_mismatch',
      field: 'job_code',
      detail: { sites: sites.length, job_codes: codes.length }
    });
  }
}

/**
 * KM continuity (6.3): "within one driver, a row's start_km should equal the
 * previous row's end_km; a gap is an amber warning".
 *
 * Rows are grouped by driver and ordered by day, then by their order in the
 * sheet — a driver's odometer is a single running sequence, and the periods and
 * the two Tracking#s have nothing to do with it. A row missing either reading is
 * skipped rather than guessed at, and it does not break the chain: the next row
 * is compared against the last reading actually recorded.
 *
 * @param {Array<Object>} rows all fuel rows, in sheet order.
 * @param {Object} report from validateEntries(); its rows are appended to.
 */
function applyKmContinuity(rows, report) {
  var byDriver = {};

  for (var i = 0; i < rows.length; i++) {
    var driver = normalizeKey(rows[i].driver).toUpperCase();
    if (!driver) continue;          // already flagged as missing_driver

    if (!byDriver[driver]) byDriver[driver] = [];
    byDriver[driver].push({ index: i, row: rows[i] });
  }

  var drivers = Object.keys(byDriver);

  for (var d = 0; d < drivers.length; d++) {
    var group = byDriver[drivers[d]];

    group.sort(function (a, b) {
      var dayA = toFiniteNumber(a.row.day);
      var dayB = toFiniteNumber(b.row.day);
      if (dayA === null) dayA = 0;
      if (dayB === null) dayB = 0;
      if (dayA !== dayB) return dayA - dayB;
      return a.index - b.index;     // sheet order breaks a tie within a day
    });

    var previousEnd = null;

    for (var g = 0; g < group.length; g++) {
      var entry = group[g];
      var startKm = toFiniteNumber(entry.row.start_km);
      var endKm = toFiniteNumber(entry.row.end_km);

      if (previousEnd !== null && startKm !== null && startKm !== previousEnd) {
        report.rows[entry.index].warnings.push({
          code: 'km_gap',
          field: 'start_km',
          detail: { expected: previousEnd, found: startKm }
        });
      }

      // Only a real reading advances the chain; a blank end_km leaves the last
      // known value standing rather than resetting the sequence.
      if (endKm !== null) previousEnd = endKm;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Split a `/`-joined cell into its trimmed, non-empty segments.
 * @param {*} value
 * @return {Array<string>}
 */
function splitMultiValue(value) {
  var raw = normalizeKey(value);
  if (!raw) return [];

  var parts = raw.split('/');
  var out = [];

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (part) out.push(part);
  }

  return out;
}

/**
 * A cell as a number.
 *
 * Returns null — not 0 — for blank or unparseable, because the difference
 * between "no amount typed" and "an amount of zero" is exactly what the
 * missing_amount flag is about. Handles the thousands separators and stray
 * currency text a pasted cell can carry.
 *
 * @param {*} value
 * @return {number|null}
 */
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;

  var raw = String(value).trim();
  if (!raw) return null;

  // Strip grouping commas and anything that is not part of a number.
  var cleaned = raw.replace(/,/g, '').replace(/[^\d.\-+eE]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;

  var parsed = Number(cleaned);
  return isFinite(parsed) ? parsed : null;
}
