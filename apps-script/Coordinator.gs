/**
 * Coordinator.gs — the seven coordinator actions (CLAUDE.md 3.5).
 *
 * Every handler in this file opens the same way, and the order is the whole
 * isolation guarantee (rule 4 / 3.8):
 *
 *   1. requireCoordinator(session)      — a manager has no business here
 *   2. assertNoSheetTargeting(session, payload)
 *                                       — the payload may not name a sheet or
 *                                         another user
 *   3. resolveCoordinatorSheet(session) — the spreadsheet id is read from the
 *                                         row of the user IN THE SESSION, and
 *                                         from nowhere else
 *
 * coordinatorContext() below does all three, so no handler can forget one. There
 * is deliberately no way to express "act on someone else's sheet" from a
 * coordinator payload: a forged request has nothing to forge.
 *
 * The other thing this file owns is the status machine (6.1). Three transitions
 * live here and each is a rule with teeth:
 *
 *   - `confirm_track` moves ONE period's draft rows to confirmed. Old and new
 *     never share a step (rule 10).
 *   - Editing an `approved` row reverts it to `confirmed` and clears the
 *     approval (rule 12). This is what stops an amount changing after sign-off.
 *   - An `exported` row is refused by everything (rule 13). That is the dedup
 *     guarantee seen from the coordinator's side.
 *
 * A Tracking# is never stored on an entry (rule 9.3). It is resolved from the
 * settlement by the entry's period at read time (6.2), so correcting a
 * settlement's number fixes every row at once.
 */

/** The two entry tabs, as the client names them. */
var ENTRY_KINDS = ['expense', 'fuel'];

/** Ceiling on one save_entries call, so a runaway paste cannot time out. */
var MAX_SAVE_ROWS = 2000;

/**
 * The fields a client may write, per kind, and — the same list — the fields
 * whose change reverts an approval (rule 12).
 *
 * They are one list on purpose. "Meaningful" means "something a manager
 * approved", and that is exactly the set the coordinator can type. Status,
 * audit, approval and export columns are absent because the server owns them
 * (rule 8); a client that sends `status` or `approved_by` is ignored, not
 * obeyed.
 */
var ENTRY_FIELDS = {
  expense: [
    'month', 'day', 'project', 'site_id', 'job_code', 'period',
    'category', 'item_description', 'amount', 'comment', 'team'
  ],
  fuel: [
    'month', 'day', 'project', 'site_id', 'job_code', 'period',
    'start_km', 'end_km', 'fuel_amount', 'area', 'driver', 'city',
    'karta_amount', 'team'
  ]
};

/** Fields returned to the client as numbers rather than raw cells. */
var ENTRY_NUMBER_FIELDS = {
  expense: ['amount'],
  fuel: ['start_km', 'end_km', 'fuel_amount', 'karta_amount']
};

/** English month labels, for building a settlement id (2.2: `S-2026-08`). */
var MONTH_NUMBERS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

/* ================================================================== *
 * The shared opening
 * ================================================================== */

/**
 * Establish that the caller is a coordinator and open THEIR spreadsheet.
 *
 * @param {Object} session auth context from validateSession().
 * @param {Object} payload the request payload, checked for sheet targeting.
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 * @throws {Object} appError('forbidden')
 */
function coordinatorContext(session, payload) {
  requireCoordinator(session);
  assertNoSheetTargeting(session, payload || {});
  return resolveCoordinatorSheet(session);
}

/**
 * @param {*} value
 * @return {string} 'expense' | 'fuel'
 * @throws {Object} appError('validation_failed') for anything else.
 */
function normalizeEntryKind(value) {
  var kind = normalizeKey(value).toLowerCase();
  if (ENTRY_KINDS.indexOf(kind) === -1) {
    throw appError('validation_failed', 'invalid_kind', { kind: 'must_be_expense_or_fuel' });
  }
  return kind;
}

/** @param {string} kind @return {string} the tab name. */
function entrySheetName(kind) {
  return (kind === 'fuel') ? 'Fuel' : 'Expenses';
}

/** @param {string} kind @return {string} the id prefix (2.3). */
function entryIdPrefix(kind) {
  return (kind === 'fuel') ? 'F-' : 'E-';
}

/**
 * Load one settlement from the caller's own sheet.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} settlementId
 * @return {Object} the raw row.
 * @throws {Object} appError('not_found')
 */
function readSettlementOrThrow(ss, settlementId) {
  var id = normalizeKey(settlementId);
  if (!id) {
    throw appError('validation_failed', 'invalid_settlement', { settlement_id: 'required' });
  }

  var row = readRowByKey(ss, 'Settlements', 'settlement_id', id);
  if (!row) throw appError('not_found', 'settlement_not_found');

  return row;
}

/**
 * The Tracking# an entry settles against (6.2). Never stored on the entry —
 * always resolved from the settlement by period, so one correction fixes every
 * row.
 *
 * @param {Object} settlement a Settlements row.
 * @param {string} period 'old' | 'new'
 * @return {number|null} null when that track has no number yet.
 */
function resolveTracking(settlement, period) {
  var raw = (normalizePeriod(period) === 'old')
    ? settlement.old_tracking_no
    : settlement.new_tracking_no;

  return toFiniteNumber(raw);
}

/* ================================================================== *
 * get_my_settlements (3.5)
 * ================================================================== */

/**
 * `get_my_settlements` — the coordinator dashboard.
 *
 * Returns each settlement with a roll-up PER TRACK, because old and new run the
 * status machine independently (rule 10): a coordinator can be finished with
 * old while new is still half-typed, and one status for the settlement would
 * hide exactly that.
 *
 * @param {Object} session auth context.
 * @param {Object} payload {}
 * @return {Object} { settlements: [...] }
 */
function handleGetMySettlements(session, payload) {
  var ss = coordinatorContext(session, payload);

  var settlements = readAllRows(ss, 'Settlements');
  var expenses = readAllRows(ss, 'Expenses');
  var fuel = readAllRows(ss, 'Fuel');

  // One pass over the entries, bucketed by settlement, rather than a scan per
  // settlement — a year of months against a year of entries would otherwise be
  // quadratic.
  var buckets = {};
  collectForRollUp(buckets, expenses, 'expense');
  collectForRollUp(buckets, fuel, 'fuel');

  var out = [];

  for (var i = 0; i < settlements.length; i++) {
    var row = settlements[i];
    var id = normalizeKey(row.settlement_id);
    if (!id) continue;

    out.push(toPublicSettlement(row, buckets[id]));
  }

  // Newest first: the month a coordinator is working on is almost always the
  // last one created.
  out.sort(function (a, b) {
    return (a.settlement_id < b.settlement_id) ? 1 : ((a.settlement_id > b.settlement_id) ? -1 : 0);
  });

  return { settlements: out };
}

/**
 * Bucket entry rows by settlement, period and status.
 * @param {Object} buckets accumulator, keyed by settlement_id.
 * @param {Array<Object>} rows
 * @param {string} kind
 */
function collectForRollUp(buckets, rows, kind) {
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var settlementId = normalizeKey(row.settlement_id);
    if (!settlementId) continue;

    if (!buckets[settlementId]) {
      buckets[settlementId] = { 'old': newCounts(), 'new': newCounts(), unrouted: 0 };
    }

    var period = normalizePeriod(row.period);
    if (!period) {
      // No period means no Tracking#, which means this row belongs to neither
      // track and confirm_track will pass it by. Counted so the dashboard can
      // say so out loud.
      buckets[settlementId].unrouted++;
      continue;
    }

    var track = buckets[settlementId][period];
    var status = normalizeKey(row.status).toLowerCase() || 'draft';

    if (track.counts[status] === undefined) track.counts[status] = 0;
    track.counts[status]++;
    track.total++;
    track[kind + '_count']++;
  }
}

/** @return {Object} an empty per-track counter. */
function newCounts() {
  return {
    counts: { draft: 0, confirmed: 0, approved: 0, returned: 0, exported: 0 },
    total: 0,
    expense_count: 0,
    fuel_count: 0
  };
}

/**
 * Shape one settlement for the client, with its two track roll-ups.
 * @param {Object} row a Settlements row.
 * @param {Object} [bucket] from collectForRollUp().
 * @return {Object}
 */
function toPublicSettlement(row, bucket) {
  var counts = bucket || { 'old': newCounts(), 'new': newCounts(), unrouted: 0 };

  return {
    settlement_id: normalizeKey(row.settlement_id),
    month: normalizeKey(row.month),
    fiscal_year: normalizeKey(row.fiscal_year),
    account: normalizeKey(row.account),
    old_tracking_no: toFiniteNumber(row.old_tracking_no),
    new_tracking_no: toFiniteNumber(row.new_tracking_no),

    tracks: {
      'old': toPublicTrack('old', row, counts['old']),
      'new': toPublicTrack('new', row, counts['new'])
    },

    unrouted_count: counts.unrouted,

    created_at: toStampString(row.created_at),
    updated_at: toStampString(row.updated_at),
    updated_by: normalizeKey(row.updated_by)
  };
}

/**
 * One track's roll-up.
 *
 * `status` is the single word for the track, chosen by what the COORDINATOR has
 * to do next rather than by how far along the track is. A returned row outranks
 * everything: it is the one state that is waiting on them personally.
 *
 * @param {string} period 'old' | 'new'
 * @param {Object} settlement the Settlements row.
 * @param {Object} track from newCounts().
 * @return {Object}
 */
function toPublicTrack(period, settlement, track) {
  var counts = track.counts;
  var status;

  if (!track.total) status = 'empty';
  else if (counts.returned) status = 'returned';
  else if (counts.draft) status = 'draft';
  else if (counts.confirmed) status = 'confirmed';
  else if (counts.approved) status = 'approved';
  else status = 'exported';

  var trackingNo = resolveTracking(settlement, period);

  return {
    period: period,
    tracking_no: trackingNo,
    tracking_no_set: trackingNo !== null,
    status: status,
    counts: counts,
    total: track.total,
    expense_count: track.expense_count,
    fuel_count: track.fuel_count,
    has_draft: counts.draft > 0,
    has_exported: counts.exported > 0
  };
}

/* ================================================================== *
 * create_settlement / update_settlement (3.5)
 * ================================================================== */

/**
 * `create_settlement` — one coordinator's batch for a month (rule 9).
 *
 * A month is NOT unique. Several teams settle against the same month and each
 * batch carries its own pair of Tracking#s, so refusing a second August would
 * force unrelated teams onto one number. The ids stay readable by suffixing:
 * `S-2026-08`, then `S-2026-08-2` (buildSettlementId).
 *
 * The two Tracking#s are optional here. A coordinator often starts recording
 * before finance has issued the numbers, and `confirm_track` is the point at
 * which the matching one becomes required — that is the gate, not this.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { month, account, old_tracking_no?, new_tracking_no?,
 *                           fiscal_year? }
 * @return {Object} { settlement }
 */
function handleCreateSettlement(session, payload) {
  var ss = coordinatorContext(session, payload);
  var body = payload || {};

  var fieldErrors = {};

  var month = normalizeKey(body.month);
  if (!month) fieldErrors.month = 'required';
  else if (month.length > 20) fieldErrors.month = 'too_long';
  else if (!isKnownMonthLabel(month)) fieldErrors.month = 'unknown_month';

  var account = normalizeKey(body.account);
  if (!account) fieldErrors.account = 'required';
  else if (account.length > 40) fieldErrors.account = 'too_long';

  var fiscalYear = normalizeKey(body.fiscal_year) || String(new Date().getFullYear());
  if (!/^\d{4}$/.test(fiscalYear)) fieldErrors.fiscal_year = 'must_be_a_year';

  var oldTracking = readOptionalTracking(body.old_tracking_no, fieldErrors, 'old_tracking_no');
  var newTracking = readOptionalTracking(body.new_tracking_no, fieldErrors, 'new_tracking_no');

  if (Object.keys(fieldErrors).length) {
    throw appError('validation_failed', 'invalid_settlement', fieldErrors);
  }

  var created = withScriptLock(function () {
    // Re-read under the lock: the id allocation has to see every id already in
    // the tab, or two quick clicks both land on S-2026-08.
    var rows = readAllRows(ss, 'Settlements');
    var ids = [];

    for (var i = 0; i < rows.length; i++) {
      ids.push(normalizeKey(rows[i].settlement_id));
    }

    var stamp = nowIso();

    return appendRow(ss, 'Settlements', {
      settlement_id: buildSettlementId(fiscalYear, month, ids),
      month: month,
      fiscal_year: fiscalYear,
      account: account,
      old_tracking_no: oldTracking === null ? '' : oldTracking,
      new_tracking_no: newTracking === null ? '' : newTracking,
      created_at: stamp,
      updated_at: stamp,
      updated_by: session.user_id
    });
  });

  return { settlement: toPublicSettlement(created, null) };
}

/**
 * `update_settlement` — "only while the relevant track has no `exported` rows"
 * (3.5).
 *
 * The check is per track, and that is the point. Changing `old_tracking_no`
 * after the old track has been settled would silently re-label money that
 * finance has already received; the new track, meanwhile, may still be wide
 * open. Month and account sit above both tracks, so changing either needs both
 * to be unexported.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { settlement_id, month?, account?,
 *                           old_tracking_no?, new_tracking_no? }
 * @return {Object} { settlement, updated: [keys] }
 */
function handleUpdateSettlement(session, payload) {
  var ss = coordinatorContext(session, payload);
  var body = payload || {};

  var settlement = readSettlementOrThrow(ss, body.settlement_id);
  var settlementId = normalizeKey(settlement.settlement_id);

  var exported = countExportedByPeriod(ss, settlementId);

  var fieldErrors = {};
  var patch = {};

  if (hasField(body, 'month')) {
    var month = normalizeKey(body.month);
    if (!month) fieldErrors.month = 'required';
    else if (!isKnownMonthLabel(month)) fieldErrors.month = 'unknown_month';
    else if (month !== normalizeKey(settlement.month)) {
      if (exported['old'] || exported['new']) fieldErrors.month = 'track_already_exported';
      else patch.month = month;
    }
  }

  if (hasField(body, 'account')) {
    var account = normalizeKey(body.account);
    if (!account) fieldErrors.account = 'required';
    else if (account.length > 40) fieldErrors.account = 'too_long';
    else if (account !== normalizeKey(settlement.account)) {
      if (exported['old'] || exported['new']) fieldErrors.account = 'track_already_exported';
      else patch.account = account;
    }
  }

  applyTrackingChange(body, settlement, exported, patch, fieldErrors, 'old');
  applyTrackingChange(body, settlement, exported, patch, fieldErrors, 'new');

  if (Object.keys(fieldErrors).length) {
    throw appError('validation_failed', 'invalid_settlement', fieldErrors);
  }

  if (!Object.keys(patch).length) {
    return { settlement: toPublicSettlement(settlement, null), updated: [] };
  }

  var applied = Object.keys(patch);
  patch.updated_at = nowIso();
  patch.updated_by = session.user_id;

  var written = withScriptLock(function () {
    var result = updateRowByKey(ss, 'Settlements', 'settlement_id', settlementId, patch);
    if (!result) throw appError('not_found', 'settlement_not_found');
    return result;
  });

  return { settlement: toPublicSettlement(written, null), updated: applied };
}

/**
 * Stage one track's Tracking# change, refusing it once that track has settled.
 *
 * @param {Object} body the payload.
 * @param {Object} settlement the stored row.
 * @param {{old: number, new: number}} exported exported row counts per period.
 * @param {Object} patch accumulator.
 * @param {Object} fieldErrors accumulator.
 * @param {string} period 'old' | 'new'
 */
function applyTrackingChange(body, settlement, exported, patch, fieldErrors, period) {
  var key = period + '_tracking_no';
  if (!hasField(body, key)) return;

  var next = readOptionalTracking(body[key], fieldErrors, key);
  if (fieldErrors[key]) return;

  var current = toFiniteNumber(settlement[key]);
  if (next === current) return;

  if (exported[period]) {
    fieldErrors[key] = 'track_already_exported';
    return;
  }

  patch[key] = (next === null) ? '' : next;
}

/**
 * How many rows of each period are already `exported`, across both tabs.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} settlementId
 * @return {{old: number, new: number}}
 */
function countExportedByPeriod(ss, settlementId) {
  var out = { 'old': 0, 'new': 0 };
  var target = normalizeKey(settlementId);

  ['Expenses', 'Fuel'].forEach(function (tab) {
    var rows = readAllRows(ss, tab);

    for (var i = 0; i < rows.length; i++) {
      if (normalizeKey(rows[i].settlement_id) !== target) continue;
      if (normalizeKey(rows[i].status).toLowerCase() !== 'exported') continue;

      var period = normalizePeriod(rows[i].period);
      if (period) out[period]++;
    }
  });

  return out;
}

/**
 * A Tracking# from a payload: a positive integer, or null when cleared.
 * @param {*} value
 * @param {Object} fieldErrors accumulator.
 * @param {string} key the field name for the error.
 * @return {number|null}
 */
function readOptionalTracking(value, fieldErrors, key) {
  if (value === undefined || value === null || normalizeKey(value) === '') return null;

  var number = toFiniteNumber(value);
  if (number === null || number !== Math.floor(number) || number <= 0) {
    fieldErrors[key] = 'must_be_a_positive_number';
    return null;
  }

  return number;
}

/**
 * Is this a month the app knows?
 *
 * Checked against the configured `Lists.months` when that list has been filled
 * in, so a typed "Augst" cannot quietly become a second August settlement. While
 * the list is still empty — a fresh install — any non-empty label is accepted,
 * because refusing everything would make the app unusable before an admin has
 * been anywhere near the Lists screen.
 *
 * @param {string} month
 * @return {boolean}
 */
function isKnownMonthLabel(month) {
  var rows = getListsRows();
  var known = [];

  for (var i = 0; i < rows.length; i++) {
    if (normalizeKey(rows[i].list_name).toLowerCase() !== 'months') continue;
    if (!normalizeBoolean(rows[i].active)) continue;

    var value = normalizeKey(rows[i].value);
    if (value) known.push(value.toLowerCase());
  }

  if (!known.length) return true;
  return known.indexOf(normalizeKey(month).toLowerCase()) !== -1;
}

/**
 * A settlement's id (2.2: `S-2026-08`).
 *
 * Derived from the year and month rather than a counter, so the id says what the
 * settlement IS and two coordinators' August rows carry the same recognisable
 * shape. A month label the app cannot map to a number — a renamed or Arabic list
 * — falls back to a slug, and then to a plain sequence, so an id is always
 * produced.
 *
 * A month holds as many settlements as the coordinator opens, so the `-2`, `-3`
 * suffix below is the normal path and not a rare collision: the second August
 * batch is `S-2026-08-2`.
 *
 * @param {string} fiscalYear four digits.
 * @param {string} month the label.
 * @param {Array<string>} existingIds for the sequence fallback and collisions.
 * @return {string}
 */
function buildSettlementId(fiscalYear, month, existingIds) {
  var key = normalizeKey(month).toLowerCase().substring(0, 3);
  var number = MONTH_NUMBERS[key];

  var suffix;
  if (number) {
    suffix = (number < 10 ? '0' : '') + number;
  } else {
    suffix = normalizeKey(month).toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 8);
  }

  if (!suffix) return nextId('S-', existingIds);

  var candidate = 'S-' + fiscalYear + '-' + suffix;

  // The first batch of the month gets the clean id; every later one is
  // suffixed, so a second August can never overwrite the first.
  if (existingIds.indexOf(candidate) === -1) return candidate;

  for (var n = 2; n < 100; n++) {
    if (existingIds.indexOf(candidate + '-' + n) === -1) return candidate + '-' + n;
  }

  return nextId('S-', existingIds);
}

/* ================================================================== *
 * list_entries (3.5)
 * ================================================================== */

/**
 * `list_entries` — the rows behind one grid.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { settlement_id, kind }
 * @return {Object} { settlement_id, kind, entries: [...], validation: {...} }
 */
function handleListEntries(session, payload) {
  var ss = coordinatorContext(session, payload);
  var body = payload || {};

  var kind = normalizeEntryKind(body.kind);
  var settlement = readSettlementOrThrow(ss, body.settlement_id);
  var settlementId = normalizeKey(settlement.settlement_id);

  var rows = readAllRows(ss, entrySheetName(kind)).filter(function (row) {
    return normalizeKey(row.settlement_id) === settlementId;
  });

  // Validated on the way out so the grid paints its flags on load, not only
  // after the first save.
  var report = validateEntries(kind, rows);

  var entries = rows.map(function (row) {
    return toPublicEntry(kind, row, settlement, report);
  });

  return {
    settlement_id: settlementId,
    kind: kind,
    entries: entries,
    validation: summariseValidation(report)
  };
}

/**
 * Shape one entry for the client.
 *
 * Two things are added that the sheet does not store: `tracking_no`, resolved
 * from the settlement by period (6.2, and never persisted — rule 9.3), and this
 * row's flags and warnings.
 *
 * @param {string} kind
 * @param {Object} row a raw entry row.
 * @param {Object} settlement the parent Settlements row.
 * @param {Object} [report] from validateEntries().
 * @return {Object}
 */
function toPublicEntry(kind, row, settlement, report) {
  var entryId = normalizeKey(row.entry_id);
  var period = normalizePeriod(row.period);

  var out = {
    entry_id: entryId,
    settlement_id: normalizeKey(row.settlement_id),
    kind: kind,

    period: period,
    tracking_no: period ? resolveTracking(settlement, period) : null,

    status: normalizeKey(row.status).toLowerCase() || 'draft',
    approved_by: normalizeKey(row.approved_by),
    approved_at: toStampString(row.approved_at),
    return_note: normalizeKey(row.return_note),

    exported: normalizeBoolean(row.exported),
    export_batch_id: normalizeKey(row.export_batch_id),
    exported_at: toStampString(row.exported_at),

    created_at: toStampString(row.created_at),
    updated_at: toStampString(row.updated_at),
    updated_by: normalizeKey(row.updated_by)
  };

  var fields = ENTRY_FIELDS[kind];
  for (var i = 0; i < fields.length; i++) {
    var key = fields[i];
    if (key === 'period') continue;             // already resolved above
    out[key] = normalizeKey(row[key]);
  }

  out.day = toFiniteNumber(row.day);

  var numbers = ENTRY_NUMBER_FIELDS[kind];
  for (var n = 0; n < numbers.length; n++) {
    out[numbers[n]] = toFiniteNumber(row[numbers[n]]);
  }

  var found = (report && entryId) ? report.by_entry[entryId] : null;
  out.flags = found ? found.flags : [];
  out.warnings = found ? found.warnings : [];

  return out;
}

/**
 * The client-facing shape of a validation pass.
 * @param {Object} report from validateEntries().
 * @return {Object}
 */
function summariseValidation(report) {
  return {
    flag_count: report.flag_count,
    warning_count: report.warning_count,
    flagged_entry_ids: report.flagged_entry_ids
  };
}

/* ================================================================== *
 * save_entries (3.5)
 * ================================================================== */

/**
 * `save_entries` — the grid's Save.
 *
 * All-or-nothing on purpose. A partial save would leave the grid and the sheet
 * disagreeing about rows the coordinator can no longer see, so every incoming
 * row is checked BEFORE anything is written and the whole call is refused if one
 * of them cannot be stored.
 *
 * What it refuses (rule 13): any row whose STORED status is `exported`. What it
 * silently does (rule 12): reverts an `approved` row to `confirmed` when a
 * meaningful field changed, clearing the approval, and reports which rows that
 * happened to so the coordinator is told rather than surprised.
 *
 * It does NOT refuse a row that fails validation. A draft is allowed to be
 * half-typed — that is what a draft is. The flags come back in the response so
 * the grid can paint them; `confirm_track` is where they start to bite.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { settlement_id, kind, rows: [...] }
 * @return {Object} { created, updated, reverted: [...], entries, validation }
 */
function handleSaveEntries(session, payload) {
  var ss = coordinatorContext(session, payload);
  var body = payload || {};

  var kind = normalizeEntryKind(body.kind);
  var settlement = readSettlementOrThrow(ss, body.settlement_id);
  var settlementId = normalizeKey(settlement.settlement_id);

  var incoming = body.rows;
  if (!(incoming instanceof Array)) {
    throw appError('validation_failed', 'invalid_rows', { rows: 'must_be_array' });
  }
  if (incoming.length > MAX_SAVE_ROWS) {
    throw appError('validation_failed', 'too_many_rows', { rows: 'max_' + MAX_SAVE_ROWS });
  }
  if (!incoming.length) {
    return emptySaveResult(ss, kind, settlement, settlementId);
  }

  var result = withScriptLock(function () {
    var tab = entrySheetName(kind);
    var block = openRowBlock(ss, tab);
    var stored = block.rows();

    var byId = {};
    var existingIds = [];

    for (var s = 0; s < stored.length; s++) {
      var storedId = normalizeKey(stored[s].entry_id);
      if (!storedId) continue;
      byId[storedId] = stored[s];
      existingIds.push(storedId);
    }

    /* --- pass 1: decide everything, write nothing --- */
    var fieldErrors = {};
    var plan = [];

    for (var i = 0; i < incoming.length; i++) {
      var raw = incoming[i] || {};
      var entryId = normalizeKey(raw.entry_id);

      if (!entryId) {
        plan.push({ mode: 'create', values: readEntryFields(kind, raw) });
        continue;
      }

      var current = byId[entryId];
      if (!current) {
        fieldErrors['rows[' + i + '].entry_id'] = 'not_found';
        continue;
      }
      if (normalizeKey(current.settlement_id) !== settlementId) {
        // Belongs to another month of this coordinator's own work. Still wrong.
        fieldErrors['rows[' + i + '].entry_id'] = 'wrong_settlement';
        continue;
      }

      var status = normalizeKey(current.status).toLowerCase() || 'draft';
      if (status === 'exported') {
        // Rule 13. The row is locked, and saying so is the whole point.
        fieldErrors['rows[' + i + '].entry_id'] = 'entry_exported';
        continue;
      }

      plan.push({
        mode: 'update',
        entry_id: entryId,
        offset: current._offset,
        status: status,
        values: readEntryFields(kind, raw),
        stored: current
      });
    }

    if (Object.keys(fieldErrors).length) {
      throw appError('validation_failed', 'invalid_entries', fieldErrors);
    }

    /* --- pass 2: apply --- */
    var stamp = nowIso();
    var actor = session.user_id;

    var created = [];
    var updated = [];
    var reverted = [];

    for (var p = 0; p < plan.length; p++) {
      var step = plan[p];

      if (step.mode === 'create') {
        var newId = nextId(entryIdPrefix(kind), existingIds, 6);
        existingIds.push(newId);

        var line = {
          entry_id: newId,
          settlement_id: settlementId,
          status: 'draft',
          exported: 'FALSE',
          created_at: stamp,
          updated_at: stamp,
          updated_by: actor
        };
        copyInto(line, step.values);

        block.append(line);
        created.push(newId);
        continue;
      }

      var patch = copyInto({}, step.values);
      patch.updated_at = stamp;
      patch.updated_by = actor;

      var changed = hasMeaningfulChange(kind, step.stored, step.values);

      if (changed && step.status === 'approved') {
        /*
         * Rule 12. The manager approved a set of numbers; these are no longer
         * those numbers, so the approval does not survive them. Back to
         * `confirmed` — not to `draft` — because the row is still submitted, it
         * just needs looking at again.
         */
        patch.status = 'confirmed';
        patch.approved_by = '';
        patch.approved_at = '';
        reverted.push(step.entry_id);

      } else if (changed && step.status === 'returned') {
        /*
         * A returned row that the coordinator has actually edited is back in
         * their hands as a draft (6.1). The note goes with it: it said "fix
         * this", they did, and leaving it attached would mark a perfectly good
         * draft as rejected.
         */
        patch.status = 'draft';
        patch.return_note = '';
      }

      block.patch(step.offset, patch);
      updated.push(step.entry_id);
    }

    block.flush();

    return { created: created, updated: updated, reverted: reverted };
  });

  // Re-read so the client gets exactly what is stored, ids and all.
  var listed = handleListEntries(session, { settlement_id: settlementId, kind: kind });

  return {
    settlement_id: settlementId,
    kind: kind,
    created: result.created.length,
    updated: result.updated.length,
    created_entry_ids: result.created,
    reverted_entry_ids: result.reverted,
    entries: listed.entries,
    validation: listed.validation
  };
}

/**
 * A save of nothing still answers with the current state, so a client that
 * saves an untouched grid is not left guessing.
 */
function emptySaveResult(ss, kind, settlement, settlementId) {
  var rows = readAllRows(ss, entrySheetName(kind)).filter(function (row) {
    return normalizeKey(row.settlement_id) === settlementId;
  });

  var report = validateEntries(kind, rows);

  return {
    settlement_id: settlementId,
    kind: kind,
    created: 0,
    updated: 0,
    created_entry_ids: [],
    reverted_entry_ids: [],
    entries: rows.map(function (row) { return toPublicEntry(kind, row, settlement, report); }),
    validation: summariseValidation(report)
  };
}

/**
 * Pull the writable fields out of an incoming row.
 *
 * Only ENTRY_FIELDS are read. A client that sends `status`, `approved_by` or
 * `exported_at` is not rejected — it is ignored, because those columns belong to
 * the server (rule 8) and there is no request in which a coordinator's opinion
 * of them is worth having.
 *
 * @param {string} kind
 * @param {Object} raw
 * @return {Object} field -> value, only for fields actually present.
 */
function readEntryFields(kind, raw) {
  var fields = ENTRY_FIELDS[kind];
  var out = {};

  for (var i = 0; i < fields.length; i++) {
    var key = fields[i];
    if (!hasField(raw, key)) continue;

    if (key === 'period') {
      // Stored lowercase or blank; the grid may send either case.
      out.period = normalizePeriod(raw.period);
      continue;
    }

    var value = raw[key];
    out[key] = (value === null || value === undefined) ? '' : value;
  }

  return out;
}

/**
 * Did a meaningful field actually change (rule 12)?
 *
 * Compared by VALUE, not by cell: Sheets hands back `100` where the grid sends
 * `"100"`, and reverting an approval over that would be a bug that shows up as
 * a manager re-approving the same untouched row every afternoon.
 *
 * @param {string} kind
 * @param {Object} stored the row as it is on the sheet.
 * @param {Object} values the incoming writable fields.
 * @return {boolean}
 */
function hasMeaningfulChange(kind, stored, values) {
  var keys = Object.keys(values);

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];

    if (key === 'period') {
      if (normalizePeriod(stored.period) !== values.period) return true;
      continue;
    }

    if (isEntryNumberField(kind, key)) {
      if (toFiniteNumber(stored[key]) !== toFiniteNumber(values[key])) return true;
      continue;
    }

    if (normalizeKey(stored[key]) !== normalizeKey(values[key])) return true;
  }

  return false;
}

/**
 * @param {string} kind
 * @param {string} key
 * @return {boolean} true for the fields compared as numbers.
 */
function isEntryNumberField(kind, key) {
  if (key === 'day') return true;
  return ENTRY_NUMBER_FIELDS[kind].indexOf(key) !== -1;
}

/**
 * Copy own keys from `source` onto `target`.
 * @param {Object} target
 * @param {Object} source
 * @return {Object} target
 */
function copyInto(target, source) {
  var keys = Object.keys(source || {});
  for (var i = 0; i < keys.length; i++) target[keys[i]] = source[keys[i]];
  return target;
}

/* ================================================================== *
 * delete_entry (3.5)
 * ================================================================== */

/**
 * `delete_entry` — the only hard delete in the app (rule 9.3), and only for a
 * `draft` row.
 *
 * Everything past draft has been seen by somebody else. A confirmed row is
 * waiting on a manager, an approved one has been signed off, an exported one is
 * in a finance file — none of those may vanish, and each is returned or kept
 * with its status instead.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { settlement_id, kind, entry_id }
 * @return {Object} { deleted: true, entry_id }
 */
function handleDeleteEntry(session, payload) {
  var ss = coordinatorContext(session, payload);
  var body = payload || {};

  var kind = normalizeEntryKind(body.kind);
  var settlement = readSettlementOrThrow(ss, body.settlement_id);
  var settlementId = normalizeKey(settlement.settlement_id);

  var entryId = normalizeKey(body.entry_id);
  if (!entryId) {
    throw appError('validation_failed', 'invalid_entry', { entry_id: 'required' });
  }

  var tab = entrySheetName(kind);

  withScriptLock(function () {
    // Re-read inside the lock: the status decides whether this is allowed at
    // all, and a stale read could delete a row a manager just approved.
    var row = readRowByKey(ss, tab, 'entry_id', entryId);
    if (!row) throw appError('not_found', 'entry_not_found');

    if (normalizeKey(row.settlement_id) !== settlementId) {
      throw appError('not_found', 'entry_not_found');
    }

    var status = normalizeKey(row.status).toLowerCase() || 'draft';
    if (status !== 'draft') {
      throw appError('validation_failed', 'entry_not_draft', { status: status });
    }

    getSheet(ss, tab).deleteRow(row._row);
  });

  return { deleted: true, entry_id: entryId, kind: kind, settlement_id: settlementId };
}

/* ================================================================== *
 * confirm_track (3.5)
 * ================================================================== */

/**
 * `confirm_track` — the coordinator hands one period to the managers.
 *
 * One period, both tabs. A track is a period, not a kind: the expenses and the
 * fuel of the new period travel together to the new Tracking#, and the old
 * period is not touched (rule 10).
 *
 * Two things must be true first:
 *   - The matching Tracking# is set (3.5). Confirming rows that resolve to no
 *     number would hand the manager a batch nobody can settle.
 *   - No FLAG remains on the rows being confirmed (6.3). Warnings do not block:
 *     an unknown site is the lookup's gap, not a reason to hold up a month.
 *
 * Rows of that period with no period value at all cannot be routed and are left
 * where they are — reported as `unrouted` rather than dropped in silence.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { settlement_id, period }
 * @return {Object} { confirmed, by_kind, tracking_no, unrouted, warning_count }
 */
function handleConfirmTrack(session, payload) {
  var ss = coordinatorContext(session, payload);
  var body = payload || {};

  var settlement = readSettlementOrThrow(ss, body.settlement_id);
  var settlementId = normalizeKey(settlement.settlement_id);

  var period = normalizePeriod(body.period);
  if (!period) {
    throw appError('validation_failed', 'invalid_period', { period: 'must_be_old_or_new' });
  }

  var trackingNo = resolveTracking(settlement, period);
  if (trackingNo === null) {
    throw appError('validation_failed', 'tracking_no_required', {
      tracking_no: 'set_' + period + '_tracking_no_first'
    });
  }

  var siteMap = getSiteJcMap();

  var outcome = withScriptLock(function () {
    var confirmedByKind = { expense: 0, fuel: 0 };
    var blocking = {};
    var blockingCount = 0;
    var warningCount = 0;
    var unrouted = 0;

    var blocks = {};
    var candidates = {};

    /* --- pass 1: read both tabs and validate, write nothing --- */
    for (var k = 0; k < ENTRY_KINDS.length; k++) {
      var kind = ENTRY_KINDS[k];
      var block = openRowBlock(ss, entrySheetName(kind));

      var mine = block.rows().filter(function (row) {
        return normalizeKey(row.settlement_id) === settlementId;
      });

      /*
       * Validation runs over EVERY row of this settlement, not just the ones
       * being confirmed, because KM continuity is a sequence: slicing it to one
       * period first would report gaps that only exist in the slice.
       */
      var report = validateEntries(kind, mine, { site_jc_map: siteMap });

      var take = [];

      for (var i = 0; i < mine.length; i++) {
        var row = mine[i];
        var status = normalizeKey(row.status).toLowerCase() || 'draft';
        if (status !== 'draft') continue;

        var rowPeriod = normalizePeriod(row.period);
        if (!rowPeriod) { unrouted++; continue; }
        if (rowPeriod !== period) continue;

        var check = report.rows[i];

        if (check.flags.length) {
          /*
           * Flags are checked on the rows being MOVED, not on every row of the
           * period. A confirmed or approved row that carries a flag is already
           * with a manager, and the coordinator cannot edit it back into shape
           * without it being returned first — blocking on it would be a dead end.
           */
          blocking[normalizeKey(row.entry_id)] = check.flags.map(function (flag) {
            return flag.code;
          }).join(',');
          blockingCount++;
          continue;
        }

        warningCount += check.warnings.length;
        take.push(row);
      }

      blocks[kind] = block;
      candidates[kind] = take;
    }

    /*
     * field_errors is keyed by entry_id here rather than by column name: the
     * thing the coordinator has to go and fix is a ROW, and the grid highlights
     * by entry_id. The value is the comma-joined flag codes for that row.
     */
    if (blockingCount) {
      throw appError('validation_failed', 'confirm_blocked_by_flags', blocking);
    }

    /* --- pass 2: stamp --- */
    var stamp = nowIso();

    for (var k2 = 0; k2 < ENTRY_KINDS.length; k2++) {
      var kind2 = ENTRY_KINDS[k2];
      var rows = candidates[kind2];

      for (var r = 0; r < rows.length; r++) {
        blocks[kind2].patch(rows[r]._offset, {
          status: 'confirmed',
          return_note: '',
          updated_at: stamp,
          updated_by: session.user_id
        });
      }

      confirmedByKind[kind2] = rows.length;
      blocks[kind2].flush();
    }

    return {
      by_kind: confirmedByKind,
      unrouted: unrouted,
      warning_count: warningCount
    };
  });

  return {
    settlement_id: settlementId,
    period: period,
    tracking_no: trackingNo,
    confirmed: outcome.by_kind.expense + outcome.by_kind.fuel,
    by_kind: outcome.by_kind,
    unrouted: outcome.unrouted,
    warning_count: outcome.warning_count
  };
}
