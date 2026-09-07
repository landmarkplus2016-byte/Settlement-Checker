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
    'date', 'project', 'site_id', 'job_code', 'period',
    'category', 'item_description', 'amount', 'comment'
  ],
  fuel: [
    'date', 'project', 'site_id', 'job_code', 'period',
    'start_km', 'end_km', 'fuel_amount', 'area', 'driver', 'city',
    'karta_amount'
  ]
};

/** Fields returned to the client as numbers rather than raw cells. */
var ENTRY_NUMBER_FIELDS = {
  expense: ['amount'],
  fuel: ['start_km', 'end_km', 'fuel_amount', 'karta_amount']
};

/**
 * English month labels to month numbers.
 *
 * The only thing this is still for is reading a LEGACY entry, which stored its
 * day as `month` + `day` against the settlement's `fiscal_year` rather than as
 * one date. Old data is never rewritten, so the mapping stays — see
 * entryDateOf().
 */
var MONTH_NUMBERS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

/**
 * The columns a coordinator spreadsheet grew when the settlement moved from a
 * month to a team, created on first use rather than by hand (ensureColumns).
 *
 * A settlement stores the team's id AND its name. The id is what drives the
 * counters and can never be retyped; the name is what the finance file prints
 * and what the export and approvals screens match on. Storing only the name is
 * how a rename orphans a settlement, and storing only the id would make every
 * reader of a coordinator sheet go back to the config spreadsheet for a word.
 */
var SETTLEMENT_EXTRA_COLUMNS = ['team_id', 'team'];

/**
 * The column both entry tabs grew when `month` + `day` became one `date`.
 *
 * Appended, never inserted (ensureColumns): every reader maps by header, so the
 * position is irrelevant and adding it at the end cannot shift a single stored
 * cell. `month` and `day` are left exactly where they are, holding what they
 * always held — entryDateOf() reads whichever shape a row is in.
 */
var ENTRY_EXTRA_COLUMNS = ['date'];

/**
 * The entry fields that must come from a reference list, and which list
 * (CLAUDE.md 2.1, 6.6.4).
 *
 * `team` used to be here and was the one that cost money to get wrong: the export
 * and the approvals list both match team BY VALUE (Manager.gs
 * `entryMatchesFilter`), so a row filed under a team that did not match the Teams
 * tab appeared in no finance file and on no approvals screen — an absence, the
 * hardest kind of error to notice. It is gone from this list because it is gone
 * from the client: the settlement belongs to a team, and `save_entries` stamps
 * that team onto every row it writes. A value the client cannot send is a value
 * it cannot misspell, which is a stronger guarantee than canonicalising one.
 *
 * `month` is gone for the same shape of reason — an entry carries a date now, not
 * a month label to be matched against a list.
 *
 * What is left is a readability problem: a project cell that says `POC-3 ` prints
 * with its stray space in the workbook the file mirrors (7.2), beside twenty rows
 * that do not.
 */
var ENTRY_LIST_FIELDS = {
  project: 'projects',
  category: 'categories',
  area: 'areas',
  driver: 'drivers'
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

  var ss = resolveCoordinatorSheet(session);
  ensureCoordinatorSchema(ss);
  return ss;
}

/**
 * Make sure one coordinator spreadsheet carries the columns this version writes.
 *
 * The owner is the only person with sheet access (rule 3), and there is one
 * spreadsheet per coordinator — asking him to add the same columns by hand to
 * each of them is how half of them end up done. Appending is safe (ensureColumns)
 * and the headers are cached for the request, so this costs one row-1 read per
 * tab the first time a request touches it and nothing after that.
 *
 * Managers reach these tabs too, through Registry's loop over every coordinator,
 * so anything that opens a coordinator sheet calls this — not just this file.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss a coordinator spreadsheet.
 */
function ensureCoordinatorSchema(ss) {
  ensureColumns(ss, 'Settlements', SETTLEMENT_EXTRA_COLUMNS);
  ensureColumns(ss, 'Expenses', ENTRY_EXTRA_COLUMNS);
  ensureColumns(ss, 'Fuel', ENTRY_EXTRA_COLUMNS);
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

  /*
   * Newest first, by when it was CREATED — not by id. `S-2026-08` sorted in date
   * order because the id was the date; `S-MS-01` is a per-team sequence, so
   * sorting on it would interleave thirteen teams' counters and put team AS's
   * first-ever settlement above team MS's twentieth.
   *
   * Legacy ids fall back to the id when a row predates `created_at`.
   */
  out.sort(function (a, b) {
    var left = a.created_at || a.settlement_id;
    var right = b.created_at || b.settlement_id;
    return (left < right) ? 1 : ((left > right) ? -1 : 0);
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
    team_id: normalizeKey(row.team_id),
    team: normalizeKey(row.team),

    /*
     * Legacy only, both of them. A settlement created before the team rewrite
     * carries a month and nothing else to name it by, and its entries carry no
     * date — `fiscal_year` is how those are read back as real days
     * (entryDateOf). Neither is an input any more; nothing writes them.
     */
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
 * `create_settlement` — one coordinator's batch for one team (rule 9).
 *
 * Two fields: team and account. There is no month, because there is nothing left
 * for one to do — an entry carries its own date, so a batch that runs from
 * 27 August to 3 September is just a batch, not an August settlement holding
 * September rows. The id says the team and the sequence instead: `S-MS-01`.
 *
 * That sequence comes from the TEAM's counter on the shared config spreadsheet,
 * not from this coordinator's own tab, so an id is unique across every
 * coordinator and can be read back as "the first settlement Mahmoud's team ever
 * filed". It is never reused; delete_settlement frees a row, not a number.
 *
 * The two Tracking#s are not set here at all. They are issued by `confirm_track`
 * from the team's other counter (decision 6) — a number handed out at creation
 * would be burnt by every settlement someone started and abandoned.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { team_id, account }
 * @return {Object} { settlement }
 */
function handleCreateSettlement(session, payload) {
  var ss = coordinatorContext(session, payload);
  var body = payload || {};

  var fieldErrors = {};

  var team = null;
  var teamId = normalizeKey(body.team_id);
  if (!teamId) {
    fieldErrors.team_id = 'required';
  } else {
    team = findActiveTeam(teamId);
    if (!team) fieldErrors.team_id = 'unknown_team';
    else if (!normalizeTeamCode(team.code)) fieldErrors.team_id = 'team_has_no_code';
  }

  var account = normalizeKey(body.account);
  if (!account) fieldErrors.account = 'required';
  else if (account.length > 40) fieldErrors.account = 'too_long';

  if (Object.keys(fieldErrors).length) {
    throw appError('validation_failed', 'invalid_settlement', fieldErrors);
  }

  /*
   * Kept and set server-side, never shown and never sent (decision 33). It is
   * what lets a LEGACY row — one that stored month + day and no date — still be
   * read as a real day (entryDateOf), which is what keeps the per-site files of
   * already-exported batches regenerating unchanged.
   */
  var fiscalYear = String(new Date().getFullYear());

  var created = withScriptLock(function () {
    var code = normalizeTeamCode(team.code);

    // Re-read under the lock. The counter cannot collide, but a sheet that was
    // restored from a copy might already hold the id it hands out, and appending
    // a second row under one settlement_id would break every reader.
    var taken = {};
    var rows = readAllRows(ss, 'Settlements');
    for (var i = 0; i < rows.length; i++) taken[normalizeKey(rows[i].settlement_id)] = true;

    var settlementId = '';
    for (var attempt = 0; attempt < 20; attempt++) {
      settlementId = 'S-' + code + '-' + padSettlementNo(
        allocateTeamNumber(team.team_id, 'next_settlement_no')
      );
      if (!taken[settlementId]) break;
      settlementId = '';
    }
    if (!settlementId) throw appError('conflict', 'settlement_id_unavailable');

    var stamp = nowIso();

    return appendRow(ss, 'Settlements', {
      settlement_id: settlementId,
      team_id: normalizeKey(team.team_id),
      team: normalizeKey(team.name),
      fiscal_year: fiscalYear,
      account: account,
      old_tracking_no: '',
      new_tracking_no: '',
      created_at: stamp,
      updated_at: stamp,
      updated_by: session.user_id
    });
  });

  return { settlement: toPublicSettlement(created, null) };
}

/**
 * One ACTIVE team by id, from the shared registry.
 *
 * Active only, and on purpose: a deactivated team is one that has stopped
 * settling, so it must not be pickable for a new batch. Settlements already
 * filed under it keep working — they carry the name, and every reader of a
 * settlement reads that, not this.
 *
 * @param {string} teamId
 * @return {Object|null} the raw Teams row.
 */
function findActiveTeam(teamId) {
  var target = normalizeKey(teamId);
  if (!target) return null;

  var rows = getTeamsRegistry();
  for (var i = 0; i < rows.length; i++) {
    if (normalizeKey(rows[i].team_id) !== target) continue;
    return normalizeBoolean(rows[i].active) ? rows[i] : null;
  }
  return null;
}

/**
 * A settlement's sequence number as it appears in its id: two digits until a
 * team passes ninety-nine, then as many as it needs. Zero-padding keeps `S-MS-01`
 * through `S-MS-09` the same width as the rest, which is the whole reason a
 * sorted list of them reads in order.
 *
 * @param {number} n
 * @return {string}
 */
function padSettlementNo(n) {
  var s = String(n);
  return (s.length < 2) ? ('0' + s) : s;
}

/**
 * `update_settlement` — "only while the relevant track has no `exported` rows"
 * (3.5).
 *
 * The check is per track, and that is the point. Changing `old_tracking_no`
 * after the old track has been settled would silently re-label money that
 * finance has already received; the new track, meanwhile, may still be wide
 * open. Account sits above both tracks, so changing it needs both to be
 * unexported.
 *
 * The TEAM is stricter still: every row of the settlement must be `draft` or
 * `returned` (decision 3). A team is not a label on a settlement — `save_entries`
 * stamps it onto every entry, and it is what the export and the approvals screen
 * match on. Moving a settlement that a manager has already seen would move rows
 * out from under a filter he is looking at.
 *
 * There is no `month`. A settlement has none, and an entry carries its own date.
 * A client that still sends one is ignored, not refused: an old tab left open is
 * not worth an error.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { settlement_id, team_id?, account?,
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

  if (hasField(body, 'team_id')) {
    var nextTeamId = normalizeKey(body.team_id);

    if (!nextTeamId) {
      fieldErrors.team_id = 'required';
    } else if (nextTeamId !== normalizeKey(settlement.team_id)) {
      var nextTeam = findActiveTeam(nextTeamId);

      if (!nextTeam) {
        fieldErrors.team_id = 'unknown_team';
      } else if (!normalizeTeamCode(nextTeam.code)) {
        fieldErrors.team_id = 'team_has_no_code';
      } else {
        var held = countUndeletableEntries(ss, settlementId);
        if (held.total) {
          fieldErrors.team_id = 'entries_already_submitted';
        } else {
          /*
           * The id keeps the code it was born with — `S-MS-01` moved to team YM
           * is still `S-MS-01`. A primary key is never renamed (2, design
           * principle 2), and the id was allocated out of MS's sequence: give it
           * a YM number now and that number is either a duplicate of a real YM
           * settlement or a hole in YM's run. The team_id column is the answer to
           * "whose is this", not the id.
           */
          patch.team_id = normalizeKey(nextTeam.team_id);
          patch.team = normalizeKey(nextTeam.name);
        }
      }
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

  var teamId = normalizeKey(settlement.team_id);

  var written = withScriptLock(function () {
    var result = updateRowByKey(ss, 'Settlements', 'settlement_id', settlementId, patch);
    if (!result) throw appError('not_found', 'settlement_not_found');

    /*
     * A hand-typed Tracking# has to move the team's counter past itself, or the
     * next confirm issues the number that was just claimed. Done after the write
     * and inside the same lock, so a refused write cannot advance the sequence.
     *
     * Note what is NOT here any more: findTrackingClash, which used to sweep this
     * coordinator's other settlements looking for the same number. It could only
     * ever see one coordinator's sheet, and the counter it has been replaced by
     * is shared across all of them — so the case it was built for is now the case
     * that cannot arise.
     */
    if (teamId) {
      ['old', 'new'].forEach(function (period) {
        var key = period + '_tracking_no';
        if (!hasField(patch, key)) return;

        var value = toFiniteNumber(patch[key]);
        if (value !== null) bumpTeamCounterPast(teamId, 'next_tracking_no', value);
      });
    }

    return result;
  });

  return { settlement: toPublicSettlement(written, null), updated: applied };
}

/**
 * Stage one track's Tracking# change, refusing it once that track has settled.
 *
 * This is the manual override of decision 9: the numbers issue themselves at
 * confirm, and this is the way back out when finance has already spoken for a
 * number. Clearing one is still allowed — the next confirm then issues a fresh
 * one — but only while the track is unexported, same as changing it.
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
 * Move a team counter on so it will never issue `value` or anything below it.
 *
 * Only ever forwards. A number typed by hand that is BELOW the counter means the
 * sequence has already run past it — reissuing from there would hand the same
 * number out twice, which is the one thing the counter exists to prevent.
 *
 * @param {string} teamId
 * @param {string} field one of TEAM_COUNTER_FIELDS.
 * @param {number} value the number just claimed by hand.
 */
function bumpTeamCounterPast(teamId, field, value) {
  var rows = getTeamsRegistry();

  for (var i = 0; i < rows.length; i++) {
    if (normalizeKey(rows[i].team_id) !== normalizeKey(teamId)) continue;
    if (teamCounterValue(rows[i][field]) > value) return;

    var patch = {};
    patch[field] = value + 1;
    updateRowAt(openConfigSpreadsheet(), 'Teams', rows[i]._row, patch);
    invalidateTeamsRegistry();
    return;
  }
}

/**
 * How many of a settlement's entries are out of the coordinator's hands, by
 * status — anything not `draft` or `returned` (DELETABLE_STATUSES).
 *
 * The same question delete_settlement asks about the whole container, asked here
 * about changing its team. Both are "has anyone else seen this yet".
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} settlementId
 * @return {{total: number, by_status: Object}}
 */
function countUndeletableEntries(ss, settlementId) {
  var target = normalizeKey(settlementId);
  var byStatus = {};
  var total = 0;

  ['Expenses', 'Fuel'].forEach(function (tab) {
    var rows = readAllRows(ss, tab);

    for (var i = 0; i < rows.length; i++) {
      if (normalizeKey(rows[i].settlement_id) !== target) continue;

      var status = normalizeKey(rows[i].status).toLowerCase() || 'draft';
      if (isDeletableStatus(status)) continue;

      byStatus[status] = (byStatus[status] || 0) + 1;
      total++;
    }
  });

  return { total: total, by_status: byStatus };
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
  var report = validateEntries(kind, rows, { settlement: settlement });

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

    // Server-owned since the settlement gained a team: stamped by save_entries,
    // read-only here, and not in ENTRY_FIELDS, so a client cannot send one.
    team: normalizeKey(row.team),

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
    if (key === 'date') continue;               // resolved below, legacy and all
    out[key] = normalizeKey(row[key]);
  }

  /*
   * Always the RESOLVED date, so a legacy row reaches the grid as a real day
   * rather than as a blank cell the coordinator would have to retype. It is what
   * he edits and what save_entries writes back into `date`, which is how a row
   * quietly stops being legacy the first time it is touched — without anything
   * having rewritten old data on its own.
   */
  out.date = entryDateOf(row, settlement);

  // Legacy columns, read-only and untouched. Kept in the response only so a
  // screen can say where a date came from; nothing writes them.
  out.month = normalizeKey(row.month);
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

    /*
     * The team is stamped from the SETTLEMENT, never taken from the row. It used
     * to be a column in the grid, matched against the Teams list on the way in,
     * and a value that matched nothing produced a row that appeared in no finance
     * file and on no approvals screen — because both filter on team by value.
     * A settlement belongs to one team (decision 1), so every row in it does too,
     * and the client has no say in the matter.
     *
     * Blank only for a legacy settlement created before teams existed. Those keep
     * whatever their rows already say until the coordinator sets a team on the
     * settlement, which confirm_track makes him do (decision 30).
     */
    var teamName = normalizeKey(settlement.team);

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
        if (teamName) line.team = teamName;

        block.append(line);
        created.push(newId);
        continue;
      }

      var patch = copyInto({}, step.values);
      patch.updated_at = stamp;
      patch.updated_by = actor;

      /*
       * Restamped on every save, not only on create, so a row written before its
       * settlement had a team — or before this rule existed — is corrected the
       * next time it is touched. It is set outside `step.values`, so it is not
       * part of hasMeaningfulChange() and cannot revert an approval on its own
       * (rule 12): the team the manager approved is the settlement's team, and
       * that cannot change while a row is approved.
       */
      if (teamName) patch.team = teamName;

      var changed = hasMeaningfulChange(kind, step.stored, step.values, settlement);

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

  var report = validateEntries(kind, rows, { settlement: settlement });

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

    if (key === 'date') {
      /*
       * Stored as ISO 'YYYY-MM-DD' (2.3), whatever shape it arrived in. The grid
       * shows `11-Aug-26` and parses what the coordinator types day-first, but
       * the cell that reaches the sheet is unambiguous — a stored `11-08-26`
       * would be read back as 11 August by one reader and 8 November by the next.
       * An unparseable value is stored blank, which validation then flags.
       */
      out.date = normalizeIsoDate(raw.date);
      continue;
    }

    if (ENTRY_LIST_FIELDS[key]) {
      out[key] = canonicalEntryListValue(key, raw[key]);
      continue;
    }

    var value = raw[key];
    out[key] = (value === null || value === undefined) ? '' : value;
  }

  return out;
}

/**
 * One list cell, in the list's own spelling (6.6.4).
 *
 * This is the durable half of the fix for `AUG` where `Lists.months` says `Aug`.
 * The grid corrects the same cells as they are typed and pasted, but the grid is
 * one route into a sheet and the server is all of them — an older client, a
 * device that failed to load the option lists, whatever writes here next. A rule
 * that only holds where the UI enforced it is not a rule.
 *
 * Matching ignores case, surrounding space and doubled spaces, and nothing else.
 * A value that matches no option is stored EXACTLY as it arrived, never blanked
 * and never guessed at: it may be a team that is about to be added, and the row
 * is the record of what somebody actually wrote. Validate.gs warns about it
 * (`unknown_list_value`) rather than this function deciding for them.
 *
 * Note what this does to rule 12: an APPROVED row still holding `AUG` from before
 * this existed reverts to `confirmed` the first time it is saved, because `Aug`
 * is not the string a manager approved. That is the rule working, not an
 * exception to it — and it happens once per row, since the value is canonical
 * from then on.
 *
 * @param {string} field an ENTRY_LIST_FIELDS key.
 * @param {*} value as it arrived from the client.
 * @return {string|*} the canonical option, or the value unchanged.
 */
function canonicalEntryListValue(field, value) {
  if (value === null || value === undefined) return '';

  var options = getEntryListOptions(field);
  if (!options.length) return value;

  var wanted = listMatchKey(value);
  if (!wanted) return value;

  for (var i = 0; i < options.length; i++) {
    if (listMatchKey(options[i]) === wanted) return options[i];
  }

  return value;
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
 * @param {Object} settlement the parent row, for resolving a legacy date.
 * @return {boolean}
 */
function hasMeaningfulChange(kind, stored, values, settlement) {
  var keys = Object.keys(values);

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];

    if (key === 'period') {
      if (normalizePeriod(stored.period) !== values.period) return true;
      continue;
    }

    if (key === 'date') {
      /*
       * Compared as RESOLVED dates, not as cells. Sheets may hand back a Date
       * object where the grid sends a string, and a legacy row's `date` cell is
       * empty while the day it means — from `month` + `day` — is perfectly real.
       * Comparing the raw cells would call every untouched legacy row changed and
       * revert its approval the first time the grid was saved (rule 12), which is
       * the one thing rule 12 must not do to a row nobody edited.
       */
      if (entryDateOf(stored, settlement) !== normalizeIsoDate(values.date)) return true;
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
 * The statuses a hard delete may touch (rule 9.3).
 *
 * `draft` is the obvious one: nobody but the coordinator has ever seen it.
 *
 * `returned` is here because 6.1 already says so. A returned row is back in the
 * coordinator's hands — `save_entries` turns it into a `draft` the moment they
 * edit it (see the returned branch above) — so it is a draft that happens to
 * still be carrying a note. Refusing to delete it only meant the coordinator had
 * to type something meaningless into a row they were about to bin, save, and
 * then delete: two round trips and an edit that lied about what they were doing.
 *
 * This is also the app's answer to a duplicate that got confirmed. The manager
 * returns it, which takes it out of the `approved` pool `export_query` draws
 * from (rule 15), so it can never reach a finance file; the coordinator then
 * deletes it outright instead of leaving it lying around as `returned` forever.
 *
 * Nothing else is deletable, and the reasons are unchanged: a `confirmed` row is
 * with a manager, an `approved` one has been signed off, an `exported` one is in
 * a finance file (rule 13). Each of those is returned or kept with its status.
 */
var DELETABLE_STATUSES = ['draft', 'returned'];

/**
 * @param {*} value a row's stored status.
 * @return {boolean} whether a hard delete may remove it.
 */
function isDeletableStatus(value) {
  var status = normalizeKey(value).toLowerCase() || 'draft';
  return DELETABLE_STATUSES.indexOf(status) !== -1;
}

/**
 * `delete_entry` — the only hard delete in the app (rule 9.3), and only for a
 * `draft` or `returned` row (DELETABLE_STATUSES).
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
    if (!isDeletableStatus(status)) {
      throw appError('validation_failed', 'entry_not_deletable', { status: status });
    }

    getSheet(ss, tab).deleteRow(row._row);
  });

  return { deleted: true, entry_id: entryId, kind: kind, settlement_id: settlementId };
}

/* ================================================================== *
 * delete_entries — the same rule, in one call
 * ================================================================== */

/**
 * Ceiling on one bulk delete.
 *
 * Higher than a paste's 500 (gridPaste.js) because the thing this exists for is
 * clearing up after a paste that went wrong, and a coordinator who has to do that
 * twice will reasonably wonder why. Well under MAX_SAVE_ROWS, because deleting is
 * the more expensive direction: rows are physically removed and everything below
 * shifts up.
 */
var MAX_DELETE_ROWS = 1000;

/**
 * `delete_entries` — hard-delete several `draft` or `returned` rows in one call.
 *
 * `delete_entry` already does exactly this for one row, and looping it from the
 * client would work — but at one Apps Script round trip each, clearing a grid of
 * thirty rows is most of a minute of a coordinator watching rows disappear one at
 * a time, and any of those calls can fail on its own leaving the sheet in a state
 * neither side predicted. This takes the whole list, under one lock, in one pass.
 *
 * Deliberately NOT all-or-nothing, which is the opposite of `save_entries`. The
 * situation this is for is a bad paste that has been partly confirmed: refusing
 * to delete twenty-eight junk drafts because two of them are with a manager would
 * leave the coordinator worse off than the one-at-a-time loop he was trying to
 * escape. So every row is judged on its own, the deletable ones go, and the rest
 * come back NAMED — with the status that saved them — so the grid can put those
 * rows back exactly where they were and say why.
 *
 * The rule itself is the same one `delete_entry` enforces: a row of the caller's
 * own settlement whose status is in DELETABLE_STATUSES, and nothing else
 * (rule 9.3).
 *
 * @param {Object} session auth context.
 * @param {Object} payload { settlement_id, kind, entry_ids: [...] }
 * @return {Object} { deleted: [...], refused: [{entry_id, status}], ... }
 */
function handleDeleteEntries(session, payload) {
  var ss = coordinatorContext(session, payload);
  var body = payload || {};

  var kind = normalizeEntryKind(body.kind);
  var settlement = readSettlementOrThrow(ss, body.settlement_id);
  var settlementId = normalizeKey(settlement.settlement_id);

  var wanted = body.entry_ids;
  if (!(wanted instanceof Array)) {
    throw appError('validation_failed', 'invalid_entry_ids', { entry_ids: 'must_be_array' });
  }
  if (wanted.length > MAX_DELETE_ROWS) {
    throw appError('validation_failed', 'too_many_rows', { entry_ids: 'max_' + MAX_DELETE_ROWS });
  }

  var ids = {};
  var order = [];

  for (var w = 0; w < wanted.length; w++) {
    var asked = normalizeKey(wanted[w]);
    if (!asked || ids[asked]) continue;
    ids[asked] = true;
    order.push(asked);
  }

  if (!order.length) {
    return {
      settlement_id: settlementId, kind: kind,
      deleted: [], refused: [], deleted_count: 0, refused_count: 0
    };
  }

  var tab = entrySheetName(kind);

  var outcome = withScriptLock(function () {
    // Re-read inside the lock, exactly as delete_entry does: status is what
    // decides, and a stale read could delete a row a manager just approved.
    var rows = readAllRows(ss, tab);

    var deleted = [];
    var refused = [];
    var targets = [];
    var seen = {};

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var entryId = normalizeKey(row.entry_id);
      if (!entryId || !ids[entryId]) continue;

      seen[entryId] = true;

      if (normalizeKey(row.settlement_id) !== settlementId) {
        // Another month of this coordinator's own work. Not this call's business.
        refused.push({ entry_id: entryId, status: 'wrong_settlement' });
        continue;
      }

      var status = normalizeKey(row.status).toLowerCase() || 'draft';
      if (!isDeletableStatus(status)) {
        refused.push({ entry_id: entryId, status: status });
        continue;
      }

      targets.push(row._row);
      deleted.push(entryId);
    }

    // An id nobody has heard of is refused rather than ignored, so the grid can
    // tell "already gone" from "still there" and put back only the second.
    for (var o = 0; o < order.length; o++) {
      if (!seen[order[o]]) refused.push({ entry_id: order[o], status: 'not_found' });
    }

    deleteSheetRows(getSheet(ss, tab), targets);

    return { deleted: deleted, refused: refused };
  });

  return {
    settlement_id: settlementId,
    kind: kind,
    deleted: outcome.deleted,
    refused: outcome.refused,
    deleted_count: outcome.deleted.length,
    refused_count: outcome.refused.length
  };
}

/**
 * Remove a set of sheet rows by their 1-based row numbers.
 *
 * Two things make this more than a loop. Rows are removed from the BOTTOM up,
 * because deleting row 7 renumbers everything below it and a list gathered before
 * the first delete would then be pointing one row short. And runs of adjacent
 * rows are removed together, because `deleteRows(start, count)` is one call where
 * `deleteRow()` is one call per row — and the case this is for, a whole pasted
 * block, is adjacent by construction. Clearing a grid of thirty becomes one API
 * call instead of thirty.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Array<number>} rowNumbers 1-based; order and duplicates do not matter.
 */
function deleteSheetRows(sheet, rowNumbers) {
  var sorted = (rowNumbers || []).slice().sort(function (a, b) { return b - a; });

  // Deduped: a repeated row number would look like the start of a new run and
  // take a row that was never asked for.
  var list = [];
  for (var d = 0; d < sorted.length; d++) {
    if (d === 0 || sorted[d] !== sorted[d - 1]) list.push(sorted[d]);
  }

  var i = 0;
  while (i < list.length) {
    var last = list[i];        // the highest row of this run
    var count = 1;

    // Walk down while the next number is the one immediately above.
    while (i + count < list.length && list[i + count] === last - count) count++;

    sheet.deleteRows(last - count + 1, count);
    i += count;
  }
}

/* ================================================================== *
 * delete_settlement (3.5)
 * ================================================================== */

/**
 * `delete_settlement` — remove a settlement and everything in it.
 *
 * This is DELETABLE_STATUSES applied one level up: to the container instead of
 * the row. A settlement holding nothing but `draft` and `returned` entries has
 * never left the coordinator's hands, so binning it is the same act as binning
 * the rows one at a time — which delete_entries already allows — minus thirty
 * clicks and the empty shell left behind at the end.
 *
 * The moment ONE entry is `confirmed`, `approved` or `exported`, the whole
 * delete is refused. Not "delete what we can": a settlement is the only thing
 * that carries `old_tracking_no` / `new_tracking_no`, and the Tracking# is
 * resolved from it at read and export time rather than stored on the entry
 * (rule 6.2). Take the settlement away from under an exported row and the
 * ExportLog batch points at a number that no longer exists anywhere — an audit
 * hole nothing can repair.
 *
 * Ids are no longer part of that argument. A settlement id came off the month, so
 * deleting one freed it and the next August settlement was handed the same
 * `S-2026-08` — which would have collided with an old log row. It now comes off
 * the team's counter, which only ever moves forwards, so a deleted `S-MS-04` is
 * simply a gap and nothing can ever be filed under that name again.
 *
 * The refusal names the statuses and their counts, so the coordinator is told
 * "3 confirmed, 2 approved" rather than just "no".
 *
 * @param {Object} session auth context.
 * @param {Object} payload { settlement_id }
 * @return {Object} { deleted, settlement_id, entries_deleted, by_kind }
 */
function handleDeleteSettlement(session, payload) {
  var ss = coordinatorContext(session, payload);
  var body = payload || {};

  var settlement = readSettlementOrThrow(ss, body.settlement_id);
  var settlementId = normalizeKey(settlement.settlement_id);

  var outcome = withScriptLock(function () {
    /*
     * Everything is re-read INSIDE the lock. The status of every entry is what
     * decides whether this is allowed at all, and a manager approving a row
     * between the client's check and this one is exactly the race that would
     * otherwise delete work that had already been signed off.
     */
    var current = readRowByKey(ss, 'Settlements', 'settlement_id', settlementId);
    if (!current) throw appError('not_found', 'settlement_not_found');

    var blocked = {};
    var blockedCount = 0;
    var targets = {};

    for (var k = 0; k < ENTRY_KINDS.length; k++) {
      var kind = ENTRY_KINDS[k];
      var rows = readAllRows(ss, entrySheetName(kind));
      targets[kind] = [];

      for (var i = 0; i < rows.length; i++) {
        if (normalizeKey(rows[i].settlement_id) !== settlementId) continue;

        var status = normalizeKey(rows[i].status).toLowerCase() || 'draft';

        if (!isDeletableStatus(status)) {
          blocked[status] = (blocked[status] || 0) + 1;
          blockedCount++;
          continue;
        }

        targets[kind].push(rows[i]._row);
      }
    }

    if (blockedCount) {
      throw appError('validation_failed', 'settlement_not_empty', blocked);
    }

    // Entries first, then the settlement itself: if the run were to fail
    // half-way, an orphaned entry is recoverable and an orphaned settlement is
    // merely empty, but an entry whose settlement is gone can resolve no
    // Tracking# at all.
    var removed = {};

    for (var k2 = 0; k2 < ENTRY_KINDS.length; k2++) {
      var kind2 = ENTRY_KINDS[k2];
      deleteSheetRows(getSheet(ss, entrySheetName(kind2)), targets[kind2]);
      removed[kind2] = targets[kind2].length;
    }

    getSheet(ss, 'Settlements').deleteRow(current._row);

    return removed;
  });

  return {
    deleted: true,
    settlement_id: settlementId,
    entries_deleted: (outcome.expense || 0) + (outcome.fuel || 0),
    by_kind: outcome
  };
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
 * **This is where a Tracking# comes from** (decision 6). It used to be the gate:
 * the coordinator had to have typed the number before he could confirm, which
 * meant chasing finance for it before he could hand over work he had finished.
 * The gate is inverted — confirming is what ISSUES the number, from the team's
 * `next_tracking_no` counter, and only when the track does not already have one.
 * A top-up confirm on a track that has already been handed over reuses the number
 * it went out under, because it is the same batch.
 *
 * Two things must be true first:
 *   - The settlement has a TEAM. The counter is the team's, so a legacy
 *     settlement created before teams existed has nothing to draw from and must
 *     be given one first (decision 30).
 *   - No FLAG remains on the rows being confirmed (6.3). Warnings do not block:
 *     an unknown site is the lookup's gap, not a reason to hold up a batch.
 *
 * Nothing is allocated until both of those hold AND there is at least one row to
 * move. A confirm that is refused, or that finds nothing to confirm, must not
 * burn a number — the sequence is what finance reads, and a gap in it is a
 * question somebody has to answer.
 *
 * Rows of that period with no period value at all cannot be routed and are left
 * where they are — reported as `unrouted` rather than dropped in silence.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { settlement_id, period }
 * @return {Object} { confirmed, by_kind, tracking_no, tracking_no_issued,
 *                    unrouted, warning_count }
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

  var teamId = normalizeKey(settlement.team_id);
  if (!teamId) {
    throw appError('validation_failed', 'settlement_team_required', {
      team_id: 'set_the_team_first'
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
      var report = validateEntries(kind, mine, {
        site_jc_map: siteMap,
        settlement: settlement
      });

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

    /* --- the Tracking# --- */
    var moving = candidates.expense.length + candidates.fuel.length;

    /*
     * Re-read the settlement inside the lock. `settlement` was read before it,
     * and two confirms racing on the same track must not both see "no number"
     * and each allocate one.
     */
    var current = readRowByKey(ss, 'Settlements', 'settlement_id', settlementId);
    if (!current) throw appError('not_found', 'settlement_not_found');

    var trackingKey = period + '_tracking_no';
    var trackingNo = resolveTracking(current, period);
    var issued = false;

    if (trackingNo === null && moving) {
      trackingNo = allocateTeamNumber(teamId, 'next_tracking_no');
      issued = true;

      var trackingPatch = { updated_at: nowIso(), updated_by: session.user_id };
      trackingPatch[trackingKey] = trackingNo;
      updateRowAt(ss, 'Settlements', current._row, trackingPatch);
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
      warning_count: warningCount,
      tracking_no: trackingNo,
      tracking_no_issued: issued
    };
  });

  return {
    settlement_id: settlementId,
    period: period,
    tracking_no: outcome.tracking_no,
    tracking_no_issued: outcome.tracking_no_issued,
    confirmed: outcome.by_kind.expense + outcome.by_kind.fuel,
    by_kind: outcome.by_kind,
    unrouted: outcome.unrouted,
    warning_count: outcome.warning_count
  };
}
