/**
 * Export.gs — the two manager-only export actions (CLAUDE.md 3.7).
 *
 * This file owns the dedup guarantee. Everything else in the app can be redone:
 * a draft can be retyped, an approval can be returned, a settlement's Tracking#
 * can be corrected and every row follows it (6.2). An export cannot. Once a row
 * is stamped `exported` it is locked (rule 13), and the reason it is locked is
 * that it is now sitting in a finance file that somebody is going to pay.
 *
 * So the split between the two actions is deliberate and is the whole design:
 *
 *   - `export_query` READS. It never writes anything. The client renders it,
 *     previews it, and builds the .xlsx from it (7.2). A manager can run it as
 *     many times as he likes and nothing has happened yet.
 *   - `export_commit` CLAIMS. It re-runs the selection SERVER-SIDE — it does not
 *     take a list of row ids from the client — and stamps what it finds in one
 *     pass while holding the script lock (rule 16). Two managers exporting the
 *     same team at the same instant cannot both claim a row: the first one takes
 *     it, the second one re-selects and finds it gone.
 *
 * That is why the commit takes a PREDICATE and not a list. A client-supplied
 * list would be a snapshot of what the manager saw a minute ago, and a row that
 * changed in between — returned by another manager, edited back to `confirmed`
 * by its coordinator (rule 12) — would be settled anyway. The server selects
 * what is true at the moment of the claim, or nothing.
 *
 * This is the ONLY place in the app that writes `exported` / `export_batch_id` /
 * `exported_at`, and the only place that appends to `ExportLog` (rule 9.3).
 *
 * What this file does NOT do: the per-site explosion (6.4). That is a pure
 * transform of the rows returned here — split the slash-joined sites, divide the
 * money, copy the KM — and 3.7 puts it client-side in `js/utils/explode.js`,
 * where the same numbers that go into the preview go into the file. The server
 * has no opinion about which of the two report types a batch was rendered as
 * beyond recording it in the log.
 */

/** The two report types of 7.1. Recorded on the batch; not a selection criterion. */
var EXPORT_REPORT_TYPES = ['normal', 'persite'];

/**
 * Ceiling on one commit.
 *
 * The claim holds the script lock across a read of every coordinator's two tabs
 * and a write back to each. A batch big enough to run past the Apps Script
 * execution limit would die mid-flush, with some coordinators stamped and others
 * not — the one failure mode that produces a row nobody can tell the state of.
 * A team-month is a few hundred rows; anything near this cap is a filter that
 * was meant to be narrower.
 */
var MAX_EXPORT_ROWS = 2000;

/** Only `approved` rows are ever claimed. `exported` is offered back read-only. */
var EXPORT_CLAIMABLE_STATUSES = ['approved'];

/** How many ExportLog batches `list_export_log` returns by default. */
var DEFAULT_EXPORT_LOG_LIMIT = 50;
var MAX_EXPORT_LOG_LIMIT = 200;

/* ================================================================== *
 * The predicate
 * ================================================================== */

/**
 * Normalise the export selection (3.7).
 *
 * Unlike `list_pending`'s filter, where every field is optional, all three of
 * team / month / period are REQUIRED here. An export is one file for one team,
 * one month and one period (7.1) — a missing field would not widen the search,
 * it would produce a file whose header block and Tracking# do not describe its
 * own contents.
 *
 * The result is shaped to match `readPendingFilter()`'s output (with an empty
 * `coordinator`) so it can be handed straight to `entryMatchesFilter()`. The two
 * screens then agree by construction about what "team Ashraf, August, new" means
 * — an export that selected differently from the approvals list it was built out
 * of would be very hard to notice and very expensive to be wrong about.
 *
 * @param {Object} body the payload.
 * @return {Object} { team, coordinator, period, month, exclude_exported }
 * @throws {Object} appError('validation_failed') with per-field errors.
 */
function readExportFilter(body) {
  var raw = body || {};
  var fieldErrors = {};

  var team = normalizeKey(raw.team);
  if (!team) fieldErrors.team = 'required';

  var month = normalizeKey(raw.month);
  if (!month) fieldErrors.month = 'required';

  var period = normalizePeriod(raw.period);
  if (!period) fieldErrors.period = 'must_be_old_or_new';

  if (Object.keys(fieldErrors).length) {
    throw appError('validation_failed', 'invalid_export_filter', fieldErrors);
  }

  /*
   * Default TRUE (rule 15): "nothing that has been exported is ever offered
   * again unless the manager explicitly asks to re-include". The absent field
   * is not an ask.
   */
  var excludeExported = (raw.exclude_exported === undefined || raw.exclude_exported === null)
    ? true
    : normalizeBoolean(raw.exclude_exported);

  return {
    // Lowercased: these four are the MATCH keys entryMatchesFilter() compares.
    team: team.toLowerCase(),
    coordinator: '',
    period: period,
    month: month.toLowerCase(),

    // As the manager sees them. What goes on the ExportLog row and back to the
    // screen — a log that recorded "team ashraf" would not match the Teams tab.
    team_label: team,
    month_label: month,

    exclude_exported: excludeExported
  };
}

/**
 * Which statuses this pass looks at.
 *
 * `approved` is the export's real input (rule 15). `exported` joins it only when
 * the manager has explicitly unticked exclude-exported, and only for READING:
 * that is the "finance lost the file, show me what was in it" case from 7.3.
 * Those rows are never claimable again — see handleExportCommit().
 *
 * @param {Object} filter from readExportFilter().
 * @return {Array<string>}
 */
function exportStatusesFor(filter) {
  return filter.exclude_exported
    ? EXPORT_CLAIMABLE_STATUSES
    : EXPORT_CLAIMABLE_STATUSES.concat(['exported']);
}

/* ================================================================== *
 * The sweep, shared by query and commit
 * ================================================================== */

/**
 * Walk every active coordinator and collect the rows matching the predicate.
 *
 * Rows are read through `openRowBlock()` rather than `readAllRows()` even for
 * the query, which needs no offsets. It costs the same read, and it means the
 * commit's selection runs through exactly this function — one predicate, one
 * implementation. A second, subtly different selection path is how a row ends up
 * in a file it was never claimed for.
 *
 * @param {Object} filter from readExportFilter().
 * @param {Array<string>} statuses which statuses to take.
 * @return {{expenses:Array<Object>, fuel:Array<Object>, claims:Array<Object>,
 *           total:number, sweep:Object}}
 *         `claims` carry the in-memory blocks and offsets; nothing is written.
 */
function sweepExportRows(filter, statuses) {
  var expenses = [];
  var fuel = [];
  var claims = [];

  var sweep = forEachCoordinator(function (userRow, ss) {
    var settlements = readSettlementMap(ss);

    for (var k = 0; k < ENTRY_KINDS.length; k++) {
      var kind = ENTRY_KINDS[k];
      var block = openRowBlock(ss, entrySheetName(kind));
      var rows = block.rows();
      var offsets = [];

      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];

        var status = normalizeKey(row.status).toLowerCase() || 'draft';
        if (statuses.indexOf(status) === -1) continue;

        var settlementId = normalizeKey(row.settlement_id);
        var settlement = settlements[settlementId] || null;

        if (!entryMatchesFilter(filter, row, settlement)) continue;

        var entry = toManagerEntry(
          kind, row, settlement || missingSettlement(settlementId), userRow
        );

        if (kind === 'fuel') fuel.push(entry);
        else expenses.push(entry);

        // Only a claimable row is offered to the commit. An `exported` row that
        // the manager asked to see again is in the lists above — so the preview
        // shows it — and deliberately not here (rule 13).
        if (EXPORT_CLAIMABLE_STATUSES.indexOf(status) !== -1) offsets.push(row._offset);
      }

      if (!offsets.length) continue;

      claims.push({
        block: block,
        kind: kind,
        offsets: offsets,
        user_id: normalizeKey(userRow.user_id),
        display_name: normalizeKey(userRow.display_name)
      });
    }
  });

  expenses.sort(compareExportEntries);
  fuel.sort(compareExportEntries);

  return {
    expenses: expenses,
    fuel: fuel,
    claims: claims,
    total: expenses.length + fuel.length,
    sweep: sweep
  };
}

/**
 * File order.
 *
 * Coordinator first, because the template's header block names one person and a
 * file that interleaves two coordinators' lines is unreadable; then day, which
 * is how the workbook has always been read; then entry id to make the order
 * total, so two runs of the same query produce byte-identical files.
 *
 * @param {Object} a
 * @param {Object} b
 * @return {number}
 */
function compareExportEntries(a, b) {
  var coordA = a.coordinator.user_id;
  var coordB = b.coordinator.user_id;
  if (coordA !== coordB) return (coordA < coordB) ? -1 : 1;

  var dayA = (a.day === null || a.day === undefined) ? 99 : a.day;
  var dayB = (b.day === null || b.day === undefined) ? 99 : b.day;
  if (dayA !== dayB) return dayA - dayB;

  if (a.entry_id !== b.entry_id) return (a.entry_id < b.entry_id) ? -1 : 1;
  return 0;
}

/* ================================================================== *
 * The header block (7.2)
 * ================================================================== */

/**
 * Everything the template's header and footer need, derived from the rows.
 *
 * Derived rather than asked for: the Tracking# in the footer must be the number
 * the selected rows actually resolve to (6.2), not a number the client typed
 * into the export screen. Same for the account in the header block.
 *
 * All four of `tracking_numbers`, `accounts`, `months` and `fiscal_years` are
 * ARRAYS of the distinct values found. In the normal case each holds exactly one
 * value and the template prints it. More than one means the batch spans
 * settlements that disagree — two coordinators on the same team with different
 * Tracking#s for the same period — and the screen has to show that rather than
 * silently print the first one into a finance file.
 *
 * @param {Array<Object>} expenses
 * @param {Array<Object>} fuel
 * @return {Object}
 */
function buildExportHeader(expenses, fuel) {
  var trackingNumbers = [];
  var accounts = [];
  var months = [];
  var fiscalYears = [];
  var coordinators = [];
  var seenCoordinator = {};

  var missingTracking = [];
  var seenMissing = {};

  var expenseTotal = 0;
  var fuelTotal = 0;
  var kartaTotal = 0;

  var all = expenses.concat(fuel);

  for (var i = 0; i < all.length; i++) {
    var entry = all[i];

    if (entry.tracking_no === null) {
      var key = entry.settlement_id + '::' + entry.coordinator.user_id;
      if (!seenMissing[key]) {
        seenMissing[key] = true;
        missingTracking.push({
          coordinator: entry.coordinator,
          settlement_id: entry.settlement_id
        });
      }
    } else {
      pushDistinct(trackingNumbers, entry.tracking_no);
    }

    pushDistinct(accounts, entry.settlement.account);
    pushDistinct(months, entry.settlement.month);
    pushDistinct(fiscalYears, entry.settlement.fiscal_year);

    if (!seenCoordinator[entry.coordinator.user_id]) {
      seenCoordinator[entry.coordinator.user_id] = true;
      coordinators.push(entry.coordinator);
    }
  }

  for (var e = 0; e < expenses.length; e++) {
    expenseTotal += numberOr(expenses[e].amount, 0);
  }
  for (var f = 0; f < fuel.length; f++) {
    fuelTotal += numberOr(fuel[f].fuel_amount, 0);
    kartaTotal += numberOr(fuel[f].karta_amount, 0);
  }

  return {
    tracking_numbers: trackingNumbers,
    accounts: accounts,
    months: months,
    fiscal_years: fiscalYears,
    coordinators: coordinators,

    /*
     * A row whose settlement has no Tracking# for this period cannot be settled:
     * the footer of 7.2 would go out blank. Reported here so the export screen
     * can say which settlement to fix, and refused outright by the commit.
     */
    missing_tracking: missingTracking,

    totals: {
      expense_amount: roundMoney(expenseTotal),
      fuel_amount: roundMoney(fuelTotal),
      karta_amount: roundMoney(kartaTotal),
      expense_rows: expenses.length,
      fuel_rows: fuel.length
    }
  };
}

/**
 * Append `value` if it is meaningful and not already present.
 * @param {Array} list
 * @param {*} value
 */
function pushDistinct(list, value) {
  if (value === null || value === undefined || value === '') return;
  if (list.indexOf(value) === -1) list.push(value);
}

/** @return {number} `value` when it is a finite number, else `fallback`. */
function numberOr(value, fallback) {
  var n = toFiniteNumber(value);
  return (n === null) ? fallback : n;
}

/**
 * Two decimal places. Money is stored as a plain EGP number (2.3) and the totals
 * here are only a roll-up for the header block — the per-site division and its
 * remainder rule live client-side in explode.js (6.4).
 * @param {number} value
 * @return {number}
 */
function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

/**
 * The single value of a distinct-list, for a log column that holds one.
 * A batch that spans two months or two years writes them joined rather than
 * dropping one — the log is the record of what actually went out.
 * @param {Array} values
 * @return {string}
 */
function joinDistinct(values) {
  return values.join('/');
}

/* ================================================================== *
 * export_query (3.7)
 * ================================================================== */

/**
 * `export_query` — build the preview and the file, write nothing.
 *
 * Returns the expenses and the fuel separately because they are two sheets in
 * the workbook with different columns (7.2), and shaped by `toManagerEntry()` so
 * an export row and an approvals row are the same object — same field names,
 * same coercion, same resolved `tracking_no`.
 *
 * `claimable` is what a commit would actually take right now. It differs from
 * `total` exactly when the manager is looking at already-exported rows he asked
 * to re-include, and the screen needs the difference to label the Confirm button
 * honestly.
 *
 * @param {Object} session auth context; must be a manager.
 * @param {Object} payload { team, month, period, exclude_exported? }
 * @return {Object} { filter, expenses, fuel, header, total, claimable,
 *                    already_exported, coordinators_visited, errors, skipped }
 */
function handleExportQuery(session, payload) {
  requireManager(session);

  var filter = readExportFilter(payload || {});
  var found = sweepExportRows(filter, exportStatusesFor(filter));

  var claimable = 0;
  for (var c = 0; c < found.claims.length; c++) {
    claimable += found.claims[c].offsets.length;
  }

  return {
    filter: {
      team: filter.team_label,
      month: filter.month_label,
      period: filter.period,
      exclude_exported: filter.exclude_exported
    },

    expenses: found.expenses,
    fuel: found.fuel,
    header: buildExportHeader(found.expenses, found.fuel),

    total: found.total,
    claimable: claimable,
    already_exported: found.total - claimable,

    /*
     * Never swallowed (forEachCoordinator's contract). A sheet that could not be
     * read means rows are missing from this preview — and from the file the
     * manager is about to build out of it.
     */
    coordinators_visited: found.sweep.visited,
    errors: found.sweep.errors,
    skipped: found.sweep.skipped
  };
}

/* ================================================================== *
 * export_commit (3.7)
 * ================================================================== */

/**
 * `export_commit` — the atomic claim (rule 16).
 *
 * Re-selects the same predicate server-side and stamps every `approved` row it
 * finds as `exported`, with the batch id and the timestamp, in one pass under
 * the script lock. The client does not send a row list and cannot influence what
 * is claimed beyond the four fields of the predicate.
 *
 * `exclude_exported` is ignored here, on purpose. A manager may ask to SEE rows
 * that already went out (7.3, rebuilding a lost file); he may never claim them a
 * second time. An `exported` row is terminal (rule 13), and re-stamping one would
 * move it into a second batch — the exact double-settlement this whole mechanism
 * exists to make impossible. So the commit only ever looks at `approved`.
 *
 * Three refusals, all of them BEFORE a single cell is written:
 *
 *   - **A coordinator's sheet could not be read.** The sweep is how the claim
 *     knows what exists; a partial sweep would leave that coordinator's rows
 *     unstamped and free to be claimed again by the next export, while the file
 *     the manager already built may well contain them.
 *   - **A row resolves to no Tracking#** (6.2). It would be locked into a batch
 *     whose footer is blank, and `update_settlement` cannot fix the number once
 *     a track has exported rows. Better to refuse and name the settlement.
 *   - **MAX_EXPORT_ROWS.** See the constant.
 *
 * Nothing is written until every check has passed: the blocks are in-memory
 * snapshots until `flush()`.
 *
 * @param {Object} session auth context; must be a manager.
 * @param {Object} payload { team, month, period, report_type }
 * @return {Object} { batch_id, row_count, by_kind, by_coordinator, tracking_no,
 *                    report_type, filter, exported_at, coordinators_visited,
 *                    errors, skipped }
 */
function handleExportCommit(session, payload) {
  requireManager(session);

  var body = payload || {};
  var filter = readExportFilter(body);

  var reportType = normalizeKey(body.report_type).toLowerCase();
  if (EXPORT_REPORT_TYPES.indexOf(reportType) === -1) {
    throw appError('validation_failed', 'invalid_report_type', {
      report_type: 'must_be_normal_or_persite'
    });
  }

  return withScriptLock(function () {
    // Always the claimable statuses, whatever the payload said about
    // exclude_exported. An exported row is not on the table.
    var found = sweepExportRows(filter, EXPORT_CLAIMABLE_STATUSES);

    if (found.sweep.errors.length) {
      throw appError('conflict', 'coordinator_sheet_unreadable',
        sweepErrorFields(found.sweep.errors));
    }

    var header = buildExportHeader(found.expenses, found.fuel);

    if (header.missing_tracking.length) {
      throw appError('validation_failed', 'tracking_no_missing',
        missingTrackingFields(header.missing_tracking, filter.period));
    }

    var rowCount = 0;
    for (var c = 0; c < found.claims.length; c++) {
      rowCount += found.claims[c].offsets.length;
    }

    if (rowCount > MAX_EXPORT_ROWS) {
      throw appError('validation_failed', 'export_too_large', {
        rows: 'max_' + MAX_EXPORT_ROWS + '_matched_' + rowCount
      });
    }

    /*
     * Nothing to claim is not an error. It is what the SECOND of two racing
     * commits sees, and what a manager sees when he confirms an export twice —
     * both of which are the mechanism working. No batch id is burned and no log
     * row is written for an empty claim.
     */
    if (!rowCount) {
      return {
        batch_id: '',
        row_count: 0,
        by_kind: { expense: 0, fuel: 0 },
        by_coordinator: [],
        tracking_no: joinDistinct(header.tracking_numbers),
        report_type: reportType,
        filter: {
          team: filter.team_label,
          month: filter.month_label,
          period: filter.period
        },
        exported_at: '',
        coordinators_visited: found.sweep.visited,
        errors: found.sweep.errors,
        skipped: found.sweep.skipped
      };
    }

    var configSs = openConfigSpreadsheet();
    var batchId = allocateBatchId(configSs, header, filter.period);
    var stamp = nowIso();

    var byKind = { expense: 0, fuel: 0 };
    var byCoordinator = {};

    for (var i = 0; i < found.claims.length; i++) {
      var claim = found.claims[i];

      for (var o = 0; o < claim.offsets.length; o++) {
        claim.block.patch(claim.offsets[o], {
          status: 'exported',
          exported: true,
          export_batch_id: batchId,
          exported_at: stamp,
          updated_at: stamp,
          updated_by: session.user_id
        });
      }

      claim.block.flush();

      byKind[claim.kind] += claim.offsets.length;

      if (!byCoordinator[claim.user_id]) {
        byCoordinator[claim.user_id] = {
          user_id: claim.user_id,
          display_name: claim.display_name,
          exported: 0
        };
      }
      byCoordinator[claim.user_id].exported += claim.offsets.length;
    }

    /*
     * The log goes in LAST. A logged batch whose rows were never stamped would
     * tell a manager that money went out when it is still sitting in the next
     * export's query; an unlogged batch whose rows ARE stamped is visible on
     * every one of those rows, in `export_batch_id`. Of the two half-states,
     * only the second is recoverable.
     */
    appendRow(configSs, 'ExportLog', {
      batch_id: batchId,
      team: filter.team_label,
      period: filter.period,
      month: joinDistinct(header.months) || filter.month_label,
      fiscal_year: joinDistinct(header.fiscal_years),
      tracking_no: joinDistinct(header.tracking_numbers),
      report_type: reportType,
      row_count: rowCount,
      exported_by: session.user_id,
      exported_at: stamp
    });

    return {
      batch_id: batchId,
      row_count: rowCount,
      by_kind: byKind,
      by_coordinator: Object.keys(byCoordinator).map(function (id) {
        return byCoordinator[id];
      }),
      tracking_no: joinDistinct(header.tracking_numbers),
      report_type: reportType,
      filter: {
        team: filter.team_label,
        month: filter.month_label,
        period: filter.period
      },
      exported_at: stamp,
      coordinators_visited: found.sweep.visited,
      errors: found.sweep.errors,
      skipped: found.sweep.skipped
    };
  });
}

/**
 * Allocate the next batch id (2.1: `EXP-2026-AUG-NEW-01`).
 *
 * Read and allocated inside the commit's script lock, like every other id in the
 * app (3.8), so two commits cannot be handed the same number.
 *
 * The id names the year, month and period but NOT the team, which is what the
 * documented example does. Two teams exported for the same month and period
 * simply take the next two sequence numbers; the team is a column on the log row
 * and on nothing that has to stay short.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} configSs
 * @param {Object} header from buildExportHeader().
 * @param {string} period 'old' | 'new'
 * @return {string}
 */
function allocateBatchId(configSs, header, period) {
  var rows = readAllRows(configSs, 'ExportLog');
  var existing = rows.map(function (row) { return normalizeKey(row.batch_id); });

  var year = normalizeKey(header.fiscal_years[0]) || String(new Date().getFullYear());
  var month = normalizeKey(header.months[0]).toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 3);

  var prefix = 'EXP-' + year + '-' + (month || 'XXX') + '-' + period.toUpperCase() + '-';
  return nextId(prefix, existing, 2);
}

/**
 * Turn a sweep's errors into `field_errors`, keyed by coordinator, so the export
 * screen can name who is missing rather than saying "something failed".
 * @param {Array<Object>} errors
 * @return {Object}
 */
function sweepErrorFields(errors) {
  var out = {};
  for (var i = 0; i < errors.length; i++) {
    out[errors[i].user_id || ('coordinator_' + i)] = errors[i].reason || 'sheet_unreadable';
  }
  return out;
}

/**
 * Turn the missing-Tracking# list into `field_errors`, keyed by settlement, so
 * the manager is told exactly which month of whose sheet to have fixed.
 * @param {Array<Object>} missing from buildExportHeader().
 * @param {string} period
 * @return {Object}
 */
function missingTrackingFields(missing, period) {
  var out = {};
  for (var i = 0; i < missing.length; i++) {
    var key = missing[i].coordinator.user_id + '/' + missing[i].settlement_id;
    out[key] = 'no_' + period + '_tracking_no';
  }
  return out;
}

/* ================================================================== *
 * list_export_log
 * ================================================================== */

/**
 * `list_export_log` — what has already gone out (7.3).
 *
 * 7.3 requires the Export screen to show the log "so managers can see what has
 * already gone out and re-issue a batch deliberately if finance loses a file",
 * but 3.7 lists only the two actions above and none of them can read it. This
 * fills that gap; it is a READ of a tab the manager already writes through
 * `export_commit`, and it adds no capability beyond seeing it.
 *
 * Newest first, because the question a manager brings to this table is always
 * "did this month's file already go?".
 *
 * @param {Object} session auth context; must be a manager.
 * @param {Object} payload { limit? }
 * @return {Object} { batches, total, limit }
 */
function handleListExportLog(session, payload) {
  requireManager(session);

  var body = payload || {};
  var limit = DEFAULT_EXPORT_LOG_LIMIT;

  if (body.limit !== undefined && body.limit !== null && normalizeKey(body.limit) !== '') {
    var asked = toFiniteNumber(body.limit);
    if (asked === null || asked !== Math.floor(asked) || asked < 1) {
      throw appError('validation_failed', 'invalid_limit', { limit: 'must_be_a_positive_number' });
    }
    limit = Math.min(asked, MAX_EXPORT_LOG_LIMIT);
  }

  var rows = readAllRows(openConfigSpreadsheet(), 'ExportLog');
  var batches = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var batchId = normalizeKey(row.batch_id);
    if (!batchId) continue;

    var exportedBy = normalizeKey(row.exported_by);
    var user = exportedBy ? findUserById(exportedBy) : null;

    batches.push({
      batch_id: batchId,
      team: normalizeKey(row.team),
      period: normalizePeriod(row.period),
      month: normalizeKey(row.month),
      fiscal_year: normalizeKey(row.fiscal_year),
      tracking_no: normalizeKey(row.tracking_no),
      report_type: normalizeKey(row.report_type).toLowerCase(),
      row_count: toFiniteNumber(row.row_count),

      exported_by: exportedBy,
      // Resolved here because the registry is already cached for this request
      // (2.4) and the export screen has no other reason to load the user list.
      exported_by_name: user ? normalizeKey(user.display_name) : '',
      exported_by_name_ar: user ? normalizeKey(user.display_name_ar) : '',
      exported_at: toStampString(row.exported_at)
    });
  }

  batches.sort(compareExportBatches);

  return {
    batches: batches.slice(0, limit),
    total: batches.length,
    limit: limit
  };
}

/**
 * Newest batch first. `exported_at` is an ISO string (rule 8), so a string
 * compare is a time compare; the batch id breaks a tie and makes the order
 * total, which matters because two commits in the same second are exactly what
 * a busy month-end looks like.
 *
 * @param {Object} a
 * @param {Object} b
 * @return {number}
 */
function compareExportBatches(a, b) {
  if (a.exported_at !== b.exported_at) return (a.exported_at < b.exported_at) ? 1 : -1;
  if (a.batch_id !== b.batch_id) return (a.batch_id < b.batch_id) ? 1 : -1;
  return 0;
}
