/**
 * Manager.gs — the four consolidated manager actions (CLAUDE.md 3.6).
 *
 * This is the only file besides Export.gs whose handlers reach INTO another
 * user's spreadsheet, and every one of them does it the same way:
 *
 *   - `list_pending` walks every active coordinator through
 *     Registry.forEachCoordinator(), which is the single sanctioned sweep.
 *   - `approve_entry` / `return_entry` open one named coordinator's sheet
 *     through Registry.resolveCoordinatorSheetAsManager(), which calls
 *     requireManager() itself so no caller can forget the gate (rule 5).
 *
 * A coordinator has no route here at all. `resolveCoordinatorSheetAsManager`
 * refuses a non-manager session before it looks at the target, so the
 * `coordinator_user_id` in these payloads — the one place in the API where a
 * caller names somebody else's sheet — is only ever honoured for a manager.
 *
 * Three things this file must never break:
 *
 *   - **An `exported` row is locked (rule 13).** Approve, return and the batch
 *     all refuse it. Re-approving a row that is already in a finance file would
 *     put it back in front of the next export, and the dedup guarantee would be
 *     gone.
 *   - **The Tracking# is never stored on an entry (rule 9.3).** It is resolved
 *     from that coordinator's settlement by the entry's period at read time
 *     (6.2), which is why every row that comes back from `list_pending` carries
 *     a number the manager can settle against without anything having been
 *     written down twice.
 *   - **A partial consolidation is never presented as complete.** A coordinator
 *     sheet that cannot be read comes back in `errors`, per the contract on
 *     forEachCoordinator(). The manager screens must show it; an entry silently
 *     missing from the approvals list is an entry that never gets approved.
 */

/** The statuses a manager reviews. Draft is the coordinator's, exported is done. */
var MANAGER_REVIEW_STATUSES = ['confirmed', 'approved', 'returned'];

/**
 * Review order, most-actionable first.
 *
 * `confirmed` is what the manager is actually here to do. `returned` sits above
 * `approved` because it is still an open loop — it is waiting on a coordinator
 * and it is worth seeing that it has not moved. `approved` is finished work,
 * kept in the list only so it can be returned if something turns up later.
 */
var MANAGER_STATUS_RANK = { confirmed: 0, returned: 1, approved: 2 };

/** Paging for list_pending (3.6: "Paged"). */
var DEFAULT_PENDING_PAGE_SIZE = 200;
var MAX_PENDING_PAGE_SIZE = 500;

/**
 * Ceiling on one approve_batch. A batch that spans every coordinator's whole
 * month would time out mid-write; refusing it and asking for a narrower filter
 * is better than a half-applied approval nobody can see the edge of.
 */
var MAX_APPROVE_BATCH_ROWS = 1000;

/** Longest return note we will store. */
var MAX_RETURN_NOTE_LENGTH = 1000;

/* ================================================================== *
 * Shared helpers
 * ================================================================== */

/**
 * A coordinator's Settlements tab, keyed by settlement_id.
 *
 * Read once per coordinator per request: every entry of that coordinator needs
 * its parent settlement to resolve a Tracking# (6.2), and a lookup per entry
 * would re-read the tab hundreds of times.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {Object} settlement_id -> the raw Settlements row.
 */
function readSettlementMap(ss) {
  var rows = readAllRows(ss, 'Settlements');
  var map = {};

  for (var i = 0; i < rows.length; i++) {
    var id = normalizeKey(rows[i].settlement_id);
    if (id) map[id] = rows[i];
  }

  return map;
}

/**
 * The stand-in for an entry whose settlement row is missing.
 *
 * It resolves to a null Tracking# rather than throwing, because an orphaned
 * entry is a data problem the manager needs to SEE. Dropping it from the list
 * would hide money that a coordinator believes he has submitted.
 *
 * @param {string} settlementId
 * @return {Object}
 */
function missingSettlement(settlementId) {
  return {
    settlement_id: normalizeKey(settlementId),
    month: '',
    fiscal_year: '',
    account: '',
    old_tracking_no: '',
    new_tracking_no: ''
  };
}

/**
 * The client-safe identity of a coordinator, for the approvals list.
 * Never `coordinator_sheet_id` (rule 3) — a manager screen names people, not
 * spreadsheets.
 *
 * @param {Object} userRow a raw Users row.
 * @return {Object}
 */
function toEntryCoordinator(userRow) {
  return {
    user_id: normalizeKey(userRow.user_id),
    display_name: normalizeKey(userRow.display_name),
    display_name_ar: normalizeKey(userRow.display_name_ar)
  };
}

/**
 * One entry, shaped for a manager screen.
 *
 * Built on Coordinator.toPublicEntry() so a row looks the same to both roles —
 * same field names, same coercion, same resolved `tracking_no` — with the two
 * things only a manager needs added on top: WHO it belongs to, and WHICH
 * settlement it sits in. The settlement is nested rather than flattened because
 * an entry already carries its own `month` cell, and the two are not the same
 * thing: the entry's month is the day-to-day label the coordinator typed, the
 * settlement's is the month being settled.
 *
 * Validation flags are deliberately not computed here. `list_pending` is a
 * consolidated read across every coordinator, and re-validating every row of
 * every sheet on every page load would cost more than it tells a manager who is
 * approving amounts, not typing them.
 *
 * @param {string} kind 'expense' | 'fuel'.
 * @param {Object} row the raw entry row.
 * @param {Object} settlement the parent Settlements row (or missingSettlement()).
 * @param {Object} userRow the coordinator's raw Users row.
 * @return {Object}
 */
function toManagerEntry(kind, row, settlement, userRow) {
  var out = toPublicEntry(kind, row, settlement, null);

  out.coordinator = toEntryCoordinator(userRow);
  out.settlement = {
    settlement_id: normalizeKey(settlement.settlement_id),
    month: normalizeKey(settlement.month),
    fiscal_year: normalizeKey(settlement.fiscal_year),
    account: normalizeKey(settlement.account)
  };

  return out;
}

/* ================================================================== *
 * The filter, shared by list_pending and approve_batch
 * ================================================================== */

/**
 * Normalise the four filter fields of 3.6.
 *
 * Every one is optional; an absent field matches everything. They are read the
 * same way for both actions so that a manager can review a filtered list and
 * then approve exactly what he was looking at.
 *
 * `coordinator` is a `user_id` — the identifier list_users hands the People and
 * Approvals screens. It is not a name: two people can share a display name, and
 * approving the wrong person's month is not a mistake worth making possible.
 *
 * `month` is matched against the SETTLEMENT's month, not the entry's own month
 * cell. A settlement is one coordinator and one month (rule 9), so that is the
 * month a manager means when he says "August"; the per-row cell is a day-level
 * label the coordinator typed and may legitimately differ. An entry whose
 * settlement row is missing falls back to its own cell, so an orphan is still
 * reachable.
 *
 * @param {Object} body the payload.
 * @return {Object} the normalized filter.
 * @throws {Object} appError('validation_failed') for an unusable period.
 */
function readPendingFilter(body) {
  var raw = body || {};

  var period = '';
  if (normalizeKey(raw.period)) {
    period = normalizePeriod(raw.period);
    if (!period) {
      throw appError('validation_failed', 'invalid_period', { period: 'must_be_old_or_new' });
    }
  }

  return {
    team: normalizeKey(raw.team).toLowerCase(),
    coordinator: normalizeKey(raw.coordinator).toLowerCase(),
    period: period,
    month: normalizeKey(raw.month).toLowerCase()
  };
}

/** @return {boolean} true when no filter field was supplied. */
function isEmptyPendingFilter(filter) {
  return !filter.team && !filter.coordinator && !filter.period && !filter.month;
}

/**
 * Does this coordinator pass the `coordinator` filter? Checked before a sheet's
 * tabs are read, so a filtered sweep does no needless work.
 *
 * @param {Object} filter from readPendingFilter().
 * @param {Object} userRow a raw Users row.
 * @return {boolean}
 */
function coordinatorMatchesFilter(filter, userRow) {
  if (!filter.coordinator) return true;
  return normalizeKey(userRow.user_id).toLowerCase() === filter.coordinator;
}

/**
 * Does this entry pass the team / period / month filters?
 *
 * @param {Object} filter from readPendingFilter().
 * @param {Object} row the raw entry row.
 * @param {Object|null} settlement the parent Settlements row, if it exists.
 * @return {boolean}
 */
function entryMatchesFilter(filter, row, settlement) {
  if (filter.team && normalizeKey(row.team).toLowerCase() !== filter.team) return false;

  if (filter.period && normalizePeriod(row.period) !== filter.period) return false;

  if (filter.month) {
    var month = settlement
      ? normalizeKey(settlement.month).toLowerCase()
      : normalizeKey(row.month).toLowerCase();
    if (month !== filter.month) return false;
  }

  return true;
}

/* ================================================================== *
 * list_pending (3.6)
 * ================================================================== */

/**
 * `list_pending` — the Approvals screen.
 *
 * Loops the registry, opens every active coordinator's sheet, and returns their
 * `confirmed` / `approved` / `returned` entries as one list with the coordinator
 * and the resolved Tracking# attached (3.6).
 *
 * `counts` is computed over the WHOLE filtered result, not over the page. A
 * manager decides whether to keep paging from the totals, and a per-page total
 * would tell him nothing he could act on.
 *
 * The sweep always OPENS every active coordinator's spreadsheet, even when the
 * filter names one coordinator — forEachCoordinator() is the single sanctioned
 * walk of the registry and it opens before it delegates. The tab reads, which
 * are the expensive part, are skipped for coordinators the filter excludes.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { team?, coordinator?, period?, month?, page?, page_size? }
 * @return {Object} { entries, page, page_size, total, total_pages, has_more,
 *                    counts, filter, errors, skipped }
 */
function handleListPending(session, payload) {
  requireManager(session);

  var body = payload || {};
  var filter = readPendingFilter(body);

  var pageSize = readPageSize(body.page_size);
  var page = readPageNumber(body.page);

  var collected = [];

  var sweep = forEachCoordinator(function (userRow, ss) {
    if (!coordinatorMatchesFilter(filter, userRow)) return;

    var settlements = readSettlementMap(ss);

    for (var k = 0; k < ENTRY_KINDS.length; k++) {
      var kind = ENTRY_KINDS[k];
      var rows = readAllRows(ss, entrySheetName(kind));

      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];

        var status = normalizeKey(row.status).toLowerCase() || 'draft';
        if (MANAGER_REVIEW_STATUSES.indexOf(status) === -1) continue;

        var settlementId = normalizeKey(row.settlement_id);
        var settlement = settlements[settlementId] || null;

        if (!entryMatchesFilter(filter, row, settlement)) continue;

        collected.push(toManagerEntry(
          kind, row, settlement || missingSettlement(settlementId), userRow
        ));
      }
    }
  });

  collected.sort(comparePendingEntries);

  var total = collected.length;
  var totalPages = total ? Math.ceil(total / pageSize) : 0;
  var start = (page - 1) * pageSize;

  return {
    entries: collected.slice(start, start + pageSize),
    page: page,
    page_size: pageSize,
    total: total,
    total_pages: totalPages,
    has_more: (start + pageSize) < total,
    counts: summarisePending(collected),
    filter: filter,

    /*
     * Never swallowed (see forEachCoordinator's contract). A sheet that could
     * not be opened means entries are missing from this list, and the screen
     * has to say so out loud.
     */
    coordinators_visited: sweep.visited,
    errors: sweep.errors,
    skipped: sweep.skipped
  };
}

/**
 * Ordering for the review queue.
 *
 * Status first, so what needs a decision is at the top; then newest settlement,
 * because a manager works down from the current month; then coordinator, kind
 * and entry id, which are there to make the order TOTAL. Paging over a partial
 * order would let a row appear on two pages, or on none.
 *
 * @param {Object} a
 * @param {Object} b
 * @return {number}
 */
function comparePendingEntries(a, b) {
  var rankA = MANAGER_STATUS_RANK[a.status];
  var rankB = MANAGER_STATUS_RANK[b.status];
  if (rankA === undefined) rankA = 9;
  if (rankB === undefined) rankB = 9;
  if (rankA !== rankB) return rankA - rankB;

  // Settlement ids are `S-<year>-<month>` (2.2), so a plain string compare puts
  // the newest month first.
  if (a.settlement_id !== b.settlement_id) {
    return (a.settlement_id < b.settlement_id) ? 1 : -1;
  }

  var coordA = a.coordinator.user_id;
  var coordB = b.coordinator.user_id;
  if (coordA !== coordB) return (coordA < coordB) ? -1 : 1;

  if (a.kind !== b.kind) return (a.kind < b.kind) ? -1 : 1;
  if (a.entry_id !== b.entry_id) return (a.entry_id < b.entry_id) ? -1 : 1;

  return 0;
}

/**
 * Roll up the whole filtered result.
 * @param {Array<Object>} entries
 * @return {Object}
 */
function summarisePending(entries) {
  var counts = {
    total: entries.length,
    by_status: { confirmed: 0, approved: 0, returned: 0 },
    by_period: { 'old': 0, 'new': 0, unrouted: 0 },
    by_kind: { expense: 0, fuel: 0 }
  };

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];

    if (counts.by_status[entry.status] !== undefined) counts.by_status[entry.status]++;
    if (counts.by_kind[entry.kind] !== undefined) counts.by_kind[entry.kind]++;

    // A row with no period resolves to no Tracking# (6.2) and would be left out
    // of every export, so it is counted rather than folded into a track.
    if (entry.period === 'old' || entry.period === 'new') counts.by_period[entry.period]++;
    else counts.by_period.unrouted++;
  }

  return counts;
}

/**
 * @param {*} value
 * @return {number} a page size within [1, MAX_PENDING_PAGE_SIZE].
 */
function readPageSize(value) {
  if (value === undefined || value === null || normalizeKey(value) === '') {
    return DEFAULT_PENDING_PAGE_SIZE;
  }

  var n = toFiniteNumber(value);
  if (n === null || n !== Math.floor(n) || n < 1) {
    throw appError('validation_failed', 'invalid_page_size', { page_size: 'must_be_a_positive_number' });
  }

  return Math.min(n, MAX_PENDING_PAGE_SIZE);
}

/**
 * @param {*} value
 * @return {number} a 1-based page number.
 */
function readPageNumber(value) {
  if (value === undefined || value === null || normalizeKey(value) === '') return 1;

  var n = toFiniteNumber(value);
  if (n === null || n !== Math.floor(n) || n < 1) {
    throw appError('validation_failed', 'invalid_page', { page: 'must_be_a_positive_number' });
  }

  return n;
}

/* ================================================================== *
 * approve_entry / return_entry (3.6)
 * ================================================================== */

/**
 * The shared opening for the two single-entry decisions.
 *
 * Reads the target row from the named coordinator's sheet and returns it with
 * everything the caller needs to decide.
 *
 * The role is checked twice on purpose: once here, before a payload naming
 * somebody else's data is looked at at all, and again inside
 * resolveCoordinatorSheetAsManager() where the sheet is actually opened. The
 * second one is the guarantee; the first one is so no future caller of this
 * helper can reach a foreign user's row while deciding it does not need a gate.
 *
 * @param {Object} session auth context; must be a manager.
 * @param {Object} body the payload.
 * @return {{ss, userRow, kind, tab, entryId, row, status}}
 * @throws {Object} appError('validation_failed'|'not_found'|'forbidden')
 */
function readDecisionTarget(session, body) {
  requireManager(session);

  var coordinatorUserId = normalizeKey(body.coordinator_user_id);
  if (!coordinatorUserId) {
    throw appError('validation_failed', 'invalid_target', { coordinator_user_id: 'required' });
  }

  var entryId = normalizeKey(body.entry_id);
  if (!entryId) {
    throw appError('validation_failed', 'invalid_entry', { entry_id: 'required' });
  }

  var kind = normalizeEntryKind(body.kind);

  // Resolve FIRST: it is what proves the target exists and is a coordinator, so
  // the registry row read after it is guaranteed to be there.
  var ss = resolveCoordinatorSheetAsManager(session, coordinatorUserId);
  var userRow = findUserById(coordinatorUserId);

  var tab = entrySheetName(kind);
  var row = readRowByKey(ss, tab, 'entry_id', entryId);
  if (!row) throw appError('not_found', 'entry_not_found');

  return {
    ss: ss,
    userRow: userRow,
    kind: kind,
    tab: tab,
    entryId: entryId,
    row: row,
    status: normalizeKey(row.status).toLowerCase() || 'draft'
  };
}

/**
 * Re-read the decided row and shape it for the client, so the screen shows what
 * is actually stored rather than what it hoped it wrote.
 *
 * @param {Object} target from readDecisionTarget().
 * @return {Object}
 */
function readDecidedEntry(target) {
  var row = readRowByKey(target.ss, target.tab, 'entry_id', target.entryId);
  if (!row) throw appError('not_found', 'entry_not_found');

  var settlementId = normalizeKey(row.settlement_id);
  var settlement = readRowByKey(target.ss, 'Settlements', 'settlement_id', settlementId)
    || missingSettlement(settlementId);

  return toManagerEntry(target.kind, row, settlement, target.userRow);
}

/**
 * `approve_entry` — one confirmed entry becomes approved (3.6 / 6.1).
 *
 * What each status does:
 *   - `confirmed` → approved, stamped `approved_by` / `approved_at` from the
 *     session and the clock (rule 8). This is the transition.
 *   - `approved`  → nothing, reported as `changed: false`. Two managers clicking
 *     the same row is not an error, and re-stamping would rewrite the record of
 *     who actually signed it off.
 *   - `exported`  → refused. The row is locked (rule 13).
 *   - `draft` / `returned` → refused. Neither is in front of a manager: a draft
 *     has not been submitted, and a returned row is back with the coordinator.
 *
 * The status is re-read INSIDE the lock. A stale read could approve a row that a
 * coordinator edited a moment ago, which is exactly the sign-off-then-change
 * problem rule 12 exists to prevent.
 *
 * @param {Object} session auth context; must be a manager.
 * @param {Object} payload { coordinator_user_id, kind, entry_id }
 * @return {Object} { entry, changed, previous_status }
 */
function handleApproveEntry(session, payload) {
  requireManager(session);

  var body = payload || {};
  var target = readDecisionTarget(session, body);

  var outcome = withScriptLock(function () {
    var row = readRowByKey(target.ss, target.tab, 'entry_id', target.entryId);
    if (!row) throw appError('not_found', 'entry_not_found');

    var status = normalizeKey(row.status).toLowerCase() || 'draft';

    if (status === 'exported') {
      throw appError('validation_failed', 'entry_exported', { status: status });
    }
    if (status === 'approved') {
      return { changed: false, previous_status: status };
    }
    if (status !== 'confirmed') {
      throw appError('validation_failed', 'entry_not_confirmed', { status: status });
    }

    var stamp = nowIso();

    updateRowByKey(target.ss, target.tab, 'entry_id', target.entryId, {
      status: 'approved',
      approved_by: session.user_id,
      approved_at: stamp,
      // An approval answers whatever the last return said, so the note goes
      // with it rather than hanging on an approved row as a stale rejection.
      return_note: '',
      updated_at: stamp,
      updated_by: session.user_id
    });

    return { changed: true, previous_status: status };
  });

  return {
    entry: readDecidedEntry(target),
    changed: outcome.changed,
    previous_status: outcome.previous_status
  };
}

/**
 * `return_entry` — hand an entry back to the coordinator with a note (3.6).
 *
 * Allowed from `confirmed`, `approved` and `returned` (re-returning replaces the
 * note — a manager may need to say more). Refused for `exported` (rule 13) and
 * for `draft`, which is already the coordinator's and has never been submitted.
 *
 * Returning an APPROVED entry clears `approved_by` / `approved_at`. The row has
 * moved backwards out of approval, and an approval stamp on a returned row would
 * read as a sign-off that no longer holds — the same reasoning as rule 12, from
 * the manager's side instead of the coordinator's.
 *
 * The note itself is required. "Returned" with no reason is a round trip the
 * coordinator cannot act on.
 *
 * @param {Object} session auth context; must be a manager.
 * @param {Object} payload { coordinator_user_id, kind, entry_id, note }
 * @return {Object} { entry, changed, previous_status }
 */
function handleReturnEntry(session, payload) {
  requireManager(session);

  var body = payload || {};

  var note = normalizeKey(body.note);
  if (!note) {
    throw appError('validation_failed', 'invalid_note', { note: 'required' });
  }
  if (note.length > MAX_RETURN_NOTE_LENGTH) {
    throw appError('validation_failed', 'invalid_note', { note: 'too_long' });
  }

  var target = readDecisionTarget(session, body);

  var outcome = withScriptLock(function () {
    var row = readRowByKey(target.ss, target.tab, 'entry_id', target.entryId);
    if (!row) throw appError('not_found', 'entry_not_found');

    var status = normalizeKey(row.status).toLowerCase() || 'draft';

    if (status === 'exported') {
      throw appError('validation_failed', 'entry_exported', { status: status });
    }
    if (MANAGER_REVIEW_STATUSES.indexOf(status) === -1) {
      throw appError('validation_failed', 'entry_not_returnable', { status: status });
    }

    var stamp = nowIso();

    updateRowByKey(target.ss, target.tab, 'entry_id', target.entryId, {
      status: 'returned',
      return_note: note,
      approved_by: '',
      approved_at: '',
      updated_at: stamp,
      updated_by: session.user_id
    });

    return { changed: true, previous_status: status };
  });

  return {
    entry: readDecidedEntry(target),
    changed: outcome.changed,
    previous_status: outcome.previous_status
  };
}

/* ================================================================== *
 * approve_batch (3.6)
 * ================================================================== */

/**
 * `approve_batch` — approve every `confirmed` row matching a filter (3.6).
 *
 * The filter is the same four fields as `list_pending`, so the manager approves
 * exactly the list he was just looking at.
 *
 * Two guards, both about not doing something enormous by accident:
 *
 *   - **The filter may not be empty.** "Approve everything anyone has ever
 *     confirmed" is not a thing a manager means to click, and there is no undo
 *     — un-approving is a return, one row at a time, with a note.
 *   - **MAX_APPROVE_BATCH_ROWS.** Over the cap the whole call is refused before
 *     a single row is written, and the manager is asked to narrow the filter.
 *
 * Only `confirmed` rows are touched. Approved rows are already approved,
 * returned rows are with their coordinator, and exported rows are locked
 * (rule 13) — none of them are silently swept up by a bulk action.
 *
 * The sweep collects every target across every coordinator BEFORE anything is
 * written, then flushes. A cap that tripped halfway through would leave some
 * coordinators approved and others not, with nothing on screen to say where the
 * line fell.
 *
 * The script lock is held across the whole read-then-write, not just the write,
 * so a coordinator cannot edit a row (reverting it to `confirmed`, rule 12) in
 * the window between it being selected and being stamped. MAX_APPROVE_BATCH_ROWS
 * is what keeps that window short.
 *
 * @param {Object} session auth context; must be a manager.
 * @param {Object} payload { filter: {team?, coordinator?, period?, month?} } —
 *        the four fields may also be sent flat, as list_pending takes them.
 * @return {Object} { approved, scanned, by_coordinator, filter, errors, skipped }
 */
function handleApproveBatch(session, payload) {
  requireManager(session);

  var body = payload || {};
  var source = (body.filter && typeof body.filter === 'object' && !(body.filter instanceof Array))
    ? body.filter
    : body;

  var filter = readPendingFilter(source);
  if (isEmptyPendingFilter(filter)) {
    throw appError('validation_failed', 'filter_required', { filter: 'at_least_one_criterion' });
  }

  var result = withScriptLock(function () {
    var claims = [];        // { block, offsets, user_id, count }
    var scanned = 0;
    var matched = 0;

    var sweep = forEachCoordinator(function (userRow, ss) {
      if (!coordinatorMatchesFilter(filter, userRow)) return;

      var settlements = readSettlementMap(ss);

      for (var k = 0; k < ENTRY_KINDS.length; k++) {
        var block = openRowBlock(ss, entrySheetName(ENTRY_KINDS[k]));
        var rows = block.rows();
        var offsets = [];

        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          if ((normalizeKey(row.status).toLowerCase() || 'draft') !== 'confirmed') continue;

          scanned++;

          var settlement = settlements[normalizeKey(row.settlement_id)] || null;
          if (!entryMatchesFilter(filter, row, settlement)) continue;

          offsets.push(row._offset);
        }

        if (!offsets.length) continue;

        matched += offsets.length;
        claims.push({
          block: block,
          offsets: offsets,
          user_id: normalizeKey(userRow.user_id),
          display_name: normalizeKey(userRow.display_name)
        });
      }
    });

    // Nothing has been written yet — the blocks are in-memory snapshots until
    // flush(). Refusing here leaves every sheet untouched.
    if (matched > MAX_APPROVE_BATCH_ROWS) {
      // Not 'too_many_rows': that message already belongs to the Excel imports
      // in Admin.gs, and the client maps a message to one sentence.
      throw appError('validation_failed', 'batch_too_large', {
        rows: 'max_' + MAX_APPROVE_BATCH_ROWS + '_matched_' + matched
      });
    }

    var stamp = nowIso();
    var byCoordinator = {};

    for (var c = 0; c < claims.length; c++) {
      var claim = claims[c];

      for (var o = 0; o < claim.offsets.length; o++) {
        claim.block.patch(claim.offsets[o], {
          status: 'approved',
          approved_by: session.user_id,
          approved_at: stamp,
          return_note: '',
          updated_at: stamp,
          updated_by: session.user_id
        });
      }

      claim.block.flush();

      if (!byCoordinator[claim.user_id]) {
        byCoordinator[claim.user_id] = {
          user_id: claim.user_id,
          display_name: claim.display_name,
          approved: 0
        };
      }
      byCoordinator[claim.user_id].approved += claim.offsets.length;
    }

    return {
      approved: matched,
      scanned: scanned,
      by_coordinator: Object.keys(byCoordinator).map(function (id) {
        return byCoordinator[id];
      }),
      sweep: sweep
    };
  });

  return {
    approved: result.approved,
    scanned: result.scanned,
    by_coordinator: result.by_coordinator,
    filter: filter,
    coordinators_visited: result.sweep.visited,
    errors: result.sweep.errors,
    skipped: result.sweep.skipped
  };
}
