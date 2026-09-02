/**
 * Admin.gs — the manager-only administration actions (CLAUDE.md 3.4).
 *
 * Four tabs of the shared config spreadsheet live here: Users (which *is* the
 * coordinator registry), Teams, SiteJC and Lists. Every handler below opens with
 * requireManager() (rule 5) — the frontend hides the Admin screens for UX, this
 * file is the actual gate.
 *
 * reset_user_password is the one exception and the split is deliberate:
 *
 *   - A user changing their OWN password. Any role. This is the forced-reset
 *     path from 4.3, and it CLEARS force_password_change.
 *   - A manager resetting SOMEONE ELSE'S password (the People screen).
 *     Manager-only, and it SETS force_password_change so the owner must pick
 *     their own on next login.
 *
 * Two guarantees this file must never break:
 *
 *   - **No sheet id leaves the script (rule 3).** A manager may WRITE a
 *     coordinator's `coordinator_sheet_id`, but list_users never reads one back.
 *     It reports `coordinator_sheet_configured` as a boolean instead.
 *   - **The last active manager cannot be deactivated (rule 25).** Three paths
 *     can reach that state — deactivate_user, update_user setting active=false,
 *     and update_user demoting a manager to coordinator — so all three run
 *     through assertNotLastManager().
 *
 * Passwords arrive already SHA-256'd by the browser (rule 7). Nothing here ever
 * sees, hashes, or logs a plain-text password.
 */

/** The two roles (2.1). */
var USER_ROLES = ['coordinator', 'manager'];

/** The two periods a SiteJC row may carry (2.1). */
var SITE_PERIODS = ['old', 'new'];

/** The list_name values the Lists tab groups by (2.1). */
var LIST_NAMES = ['projects', 'categories', 'areas', 'drivers', 'months'];

/** Ceiling on one bulk_import_site_jc call, so a huge paste cannot time out. */
var MAX_BULK_SITE_JC_ROWS = 10000;

/* Per-request caches (CLAUDE.md 2.4). Apps Script gives each request a fresh
 * global scope, so these need no cross-request invalidation — only the
 * invalidate* calls after a write within the same request. */
var __teamsCache = null;
var __siteJcCache = null;
var __listsCache = null;

/* list name -> its active option strings; built on top of the two above. */
var __entryListCache = null;

/* ================================================================== *
 * Shared readers — the per-request caches promised by CLAUDE.md 2.4.
 * Coordinator.gs and Validate.gs read the lookup through these too; the
 * tabs are owned here, so the accessors live here.
 * ================================================================== */

/**
 * Every Teams row, cached for this request.
 * @return {Array<Object>} raw rows (carry `_row`).
 */
function getTeamsRegistry() {
  if (__teamsCache) return __teamsCache;
  __teamsCache = readAllRows(openConfigSpreadsheet(), 'Teams');
  return __teamsCache;
}

/** Drop the cached Teams rows after a write. */
function invalidateTeamsRegistry() {
  __teamsCache = null;
  __entryListCache = null;      // the team option list is built out of these
}

/**
 * Every SiteJC row, cached for this request.
 * @return {Array<Object>} raw rows (carry `_row`).
 */
function getSiteJcRows() {
  if (__siteJcCache) return __siteJcCache;
  __siteJcCache = readAllRows(openConfigSpreadsheet(), 'SiteJC');
  return __siteJcCache;
}

/** Drop the cached SiteJC rows after a write. */
function invalidateSiteJc() {
  __siteJcCache = null;
}

/**
 * The Site ID -> candidate job codes lookup, keyed by NORMALIZED site id.
 *
 * **A site maps to a LIST, not to one job code.** The source tracking file gives
 * a site a fresh job code every time a task is raised against it, so `K3602`
 * legitimately carries `ABD02` (07-Dec-2025) and `ABD12` (23-Sep-2025) at the
 * same time — and both of them are `old`, so the period cannot tell them apart
 * either. Which one an entry means is decided by its `task_date` against the day
 * the coordinator is settling — a choice made in the grid (pickCandidate() in
 * js/coordinator/gridAutofill.js), not here: an entry stores the job code it
 * resolved at save time, so the server never re-picks one. This map exists so
 * validation can ask whether a site is known at all, and so the admin screen and
 * the grid can both read the whole lookup in one call.
 *
 * Site ids match case-insensitively: real site lists are typed by many hands and
 * carry `k3799` next to `K3666`. A coordinator typing `K3799` from paperwork must
 * still get the row, because `period` is what routes an entry to the old vs new
 * tracking number — a case mismatch would silently break the old/new split.
 * The site id is STORED exactly as it was entered; only comparisons normalize.
 *
 * @return {Object} normalized site_id ->
 *         Array<{site_id, job_code, task_date, period}>, newest task_date first.
 */
function getSiteJcMap() {
  var rows = getSiteJcRows();
  var map = {};

  for (var i = 0; i < rows.length; i++) {
    var siteId = normalizeKey(rows[i].site_id);
    var jobCode = normalizeKey(rows[i].job_code);
    if (!siteId || !jobCode) continue;

    var key = normalizeSiteId(siteId);
    if (!map[key]) map[key] = [];

    map[key].push({
      site_id: siteId,
      job_code: jobCode,
      task_date: normalizeTaskDate(rows[i].task_date),
      period: normalizePeriod(rows[i].period)
    });
  }

  var keys = Object.keys(map);
  for (var k = 0; k < keys.length; k++) map[keys[k]].sort(compareByTaskDateDesc);

  return map;
}

/**
 * Order candidates newest-first, with undated ones last.
 *
 * ISO dates sort correctly as strings, which is the whole reason task_date is
 * stored as `YYYY-MM-DD` (2.3). A blank date is not "the oldest" — it is
 * unknown — so it goes to the end rather than to the bottom of the date order.
 *
 * @param {Object} a
 * @param {Object} b
 * @return {number}
 */
function compareByTaskDateDesc(a, b) {
  if (!a.task_date && !b.task_date) return 0;
  if (!a.task_date) return 1;
  if (!b.task_date) return -1;
  return (a.task_date < b.task_date) ? 1 : ((a.task_date > b.task_date) ? -1 : 0);
}

/**
 * A task date as a stored `YYYY-MM-DD` string, or '' when there is not one.
 *
 * The client parses the uploaded spreadsheet and sends ISO (3.4), so this is
 * mostly a shape check — but it has to accept a **Date** too, and that case is
 * the subtle one. Writing `2025-12-07` into a cell makes Sheets parse it into a
 * real date value, so the very next read of the row hands this a Date rather
 * than the string that was written.
 *
 * It is read back in LOCAL terms (getFullYear/getMonth/getDate), never UTC.
 * Sheets builds that Date at midnight in the spreadsheet's own timezone, so a
 * UTC reading of it lands on the previous evening and yields the previous DAY —
 * which at a year boundary would move `01-Jan-2026` back to 2025 and flip the
 * row from `new` to `old`. Local getters round-trip it exactly.
 *
 * @param {*} v
 * @return {string}
 */
function normalizeTaskDate(v) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';

    return v.getFullYear() + '-' +
           padTwo(v.getMonth() + 1) + '-' +
           padTwo(v.getDate());
  }

  var s = normalizeKey(v);
  if (!s) return '';

  var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!match) return '';

  var month = parseInt(match[2], 10);
  var day = parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';

  return match[1] + '-' + match[2] + '-' + match[3];
}

/**
 * @param {number} n
 * @return {string} two digits, zero-padded.
 */
function padTwo(n) {
  return (n < 10 ? '0' : '') + n;
}

/**
 * The period a task date falls in (rule 14).
 *
 * The imported tracking file is the only authority on old vs new: the year of
 * the task date decides it against `fiscal_new_from_year`, and the file's own
 * Old/New column is not read at all. A task with no usable date counts as `new`
 * — the project owner's rule, and the safe direction, since new is the track
 * still open.
 *
 * @param {*} taskDate
 * @return {string} 'old' | 'new'
 */
function derivePeriodFromTaskDate(taskDate) {
  var iso = normalizeTaskDate(taskDate);
  if (!iso) return 'new';

  return (parseInt(iso.substring(0, 4), 10) >= getFiscalNewFromYear()) ? 'new' : 'old';
}

/**
 * The composite key of a SiteJC row (2.1).
 *
 * A site alone stopped being unique the moment the lookup started carrying every
 * task raised against it, so identity is site + job code — the pair the source
 * file spells as one `K4429-ABD01` cell.
 *
 * @param {*} siteId
 * @param {*} jobCode
 * @return {string}
 */
function siteJcKey(siteId, jobCode) {
  return normalizeSiteId(siteId) + ' ' + normalizeSiteId(jobCode);
}

/**
 * The comparison form of a Site ID. Every site lookup in the app — here, in
 * Validate.gs, and in the grid's autofill — must agree on this.
 * @param {*} v
 * @return {string}
 */
function normalizeSiteId(v) {
  return normalizeKey(v).toUpperCase();
}

/**
 * Coerce a period cell to 'old' | 'new', or '' when it is neither.
 * @param {*} v
 * @return {string}
 */
function normalizePeriod(v) {
  var p = normalizeKey(v).toLowerCase();
  return (SITE_PERIODS.indexOf(p) === -1) ? '' : p;
}

/**
 * Every Lists row, cached for this request.
 * @return {Array<Object>} raw rows (carry `_row`).
 */
function getListsRows() {
  if (__listsCache) return __listsCache;
  __listsCache = readAllRows(openConfigSpreadsheet(), 'Lists');
  return __listsCache;
}

/** Drop the cached Lists rows after a write. */
function invalidateLists() {
  __listsCache = null;
  __entryListCache = null;      // the five option lists are built out of these
}

/* ------------------------------------------------------------------ *
 * The reference lists, as plain option arrays (6.6.4)
 *
 * Coordinator.gs settles an entry's list cells onto these spellings on the way
 * into a sheet, and Validate.gs warns about a cell that matches none of them.
 * Both read through here so there is one answer to "what are the valid teams",
 * cached for the request like everything else in 2.4.
 * ------------------------------------------------------------------ */

/**
 * The comparison form of a list value.
 *
 * Case-folded, ends trimmed, runs of whitespace collapsed — the three ways two
 * people write the same option. Deliberately nothing else: this is a normaliser,
 * not a fuzzy match, and `POC-3` and `POC3` must stay two different things.
 *
 * The client applies exactly this rule in js/utils/lists.js. When one changes,
 * the other changes with it — the same standing arrangement Validate.gs has with
 * js/utils/validate.js.
 *
 * @param {*} value
 * @return {string} '' for blank.
 */
function listMatchKey(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The ACTIVE options of one entry list.
 *
 * Active only, on purpose: these drive what a new value is corrected to and what
 * counts as recognised, and a deactivated option is one an admin has taken out of
 * circulation. A row that already carries it keeps it — nothing here rewrites a
 * stored value that matches nothing (see canonicalEntryListValue).
 *
 * @param {string} field 'month' | 'project' | 'category' | 'area' | 'driver' |
 *        'team' — the ENTRY_LIST_FIELDS keys.
 * @return {Array<string>} [] for an unknown field, or a list nobody has filled in.
 */
function getEntryListOptions(field) {
  var name = ENTRY_LIST_FIELDS[field];
  if (!name) return [];

  /*
   * Memoised per request on top of the row caches above. validateEntries() asks
   * for all six lists on every row of a tab, and rebuilding each of them out of
   * the raw Lists rows two hundred times is real time for no new information.
   */
  if (!__entryListCache) __entryListCache = {};
  if (__entryListCache[name]) return __entryListCache[name];

  if (name === 'teams') {
    var teams = getTeamsRegistry();
    var names = [];

    for (var t = 0; t < teams.length; t++) {
      if (!normalizeBoolean(teams[t].active)) continue;
      var teamName = normalizeKey(teams[t].name);
      if (teamName) names.push(teamName);
    }

    __entryListCache[name] = names;
    return names;
  }

  var rows = getListsRows();
  var values = [];

  for (var i = 0; i < rows.length; i++) {
    if (normalizeKey(rows[i].list_name).toLowerCase() !== name) continue;
    if (!normalizeBoolean(rows[i].active)) continue;

    var value = normalizeKey(rows[i].value);
    if (value) values.push(value);
  }

  __entryListCache[name] = values;
  return values;
}

/* ================================================================== *
 * Users — the accounts tab, which is also the coordinator registry (2.1)
 * ================================================================== */

/**
 * The admin-screen shape of a user.
 *
 * `coordinator_sheet_id` is deliberately absent and replaced by a boolean.
 * A manager needs to know whether a coordinator's sheet is wired up; nobody
 * outside this script ever needs the id itself (rule 3).
 *
 * @param {Object} row a raw Users row.
 * @return {Object}
 */
function toAdminUser(row) {
  return {
    user_id: normalizeKey(row.user_id),
    username: normalizeKey(row.username),
    display_name: normalizeKey(row.display_name),
    display_name_ar: normalizeKey(row.display_name_ar),
    role: normalizeKey(row.role),
    active: normalizeBoolean(row.active),
    force_password_change: normalizeBoolean(row.force_password_change),
    coordinator_sheet_configured: !!normalizeKey(row.coordinator_sheet_id),
    last_login_at: toStampString(row.last_login_at),
    created_at: toStampString(row.created_at),
    updated_at: toStampString(row.updated_at),
    updated_by: normalizeKey(row.updated_by)
  };
}

/**
 * A timestamp cell as an ISO string. Sheets hands an ISO string we wrote back as
 * either the same string or a Date, depending on the column's formatting.
 * @param {*} v
 * @return {string}
 */
function toStampString(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : v.toISOString();
  }
  return normalizeKey(v);
}

/**
 * `list_users` (3.4) — the People screen.
 *
 * @param {Object} session auth context from validateSession().
 * @param {Object} payload { include_inactive? } — default true; the People screen
 *        must show deactivated people so they can be reactivated.
 * @return {Object} { users: [...], total, active_manager_count }
 */
function handleListUsers(session, payload) {
  requireManager(session);

  var body = payload || {};
  var includeInactive = (body.include_inactive === undefined)
    ? true
    : normalizeBoolean(body.include_inactive);

  var rows = getUsersRegistry();
  var users = [];
  var activeManagers = 0;

  for (var i = 0; i < rows.length; i++) {
    var user = toAdminUser(rows[i]);
    if (!user.user_id) continue;
    if (user.active && user.role === 'manager') activeManagers++;
    if (!includeInactive && !user.active) continue;
    users.push(user);
  }

  users.sort(function (a, b) { return a.user_id < b.user_id ? -1 : (a.user_id > b.user_id ? 1 : 0); });

  return { users: users, total: users.length, active_manager_count: activeManagers };
}

/**
 * `create_user` (3.4).
 *
 * A coordinator row MUST carry a `coordinator_sheet_id` and a manager row must
 * not: the Users tab is the registry (2.1), and a coordinator without a sheet is
 * an account that can log in and then fail on every action.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { username, password_hash, display_name, display_name_ar?,
 *                           role, coordinator_sheet_id?, force_password_change? }
 * @return {Object} { user: <admin shape> }
 */
function handleCreateUser(session, payload) {
  requireManager(session);

  var body = payload || {};
  var fieldErrors = {};

  var username = normalizeKey(body.username);
  if (!username) fieldErrors.username = 'required';
  else if (username.length > 60) fieldErrors.username = 'too_long';
  else if (/\s/.test(username)) fieldErrors.username = 'no_whitespace';

  var passwordHash = normalizeKey(body.password_hash).toLowerCase();
  if (!passwordHash) fieldErrors.password_hash = 'required';
  else if (!SHA256_HEX.test(passwordHash)) fieldErrors.password_hash = 'must_be_sha256_hex';

  var displayName = normalizeKey(body.display_name);
  if (!displayName) fieldErrors.display_name = 'required';
  else if (displayName.length > 100) fieldErrors.display_name = 'too_long';

  var displayNameAr = normalizeKey(body.display_name_ar);
  if (displayNameAr.length > 100) fieldErrors.display_name_ar = 'too_long';

  var role = normalizeKey(body.role).toLowerCase();
  if (!role) fieldErrors.role = 'required';
  else if (USER_ROLES.indexOf(role) === -1) fieldErrors.role = 'must_be_coordinator_or_manager';

  var sheetId = normalizeKey(body.coordinator_sheet_id);
  if (role === 'coordinator' && !sheetId) fieldErrors.coordinator_sheet_id = 'required_for_coordinator';
  if (role === 'manager' && sheetId) fieldErrors.coordinator_sheet_id = 'must_be_blank_for_manager';

  if (!fieldErrors.username && findUserByUsername(username)) {
    fieldErrors.username = 'already_taken';
  }

  if (Object.keys(fieldErrors).length) {
    throw appError('validation_failed', 'invalid_user', fieldErrors);
  }

  var forceChange = (body.force_password_change === undefined)
    ? true
    : normalizeBoolean(body.force_password_change);

  var created = withScriptLock(function () {
    var ss = openConfigSpreadsheet();

    // Re-read inside the lock: the uniqueness check above ran against the cached
    // registry, and two managers could be adding the same username at once.
    var rows = readAllRows(ss, 'Users');
    var ids = [];
    for (var i = 0; i < rows.length; i++) {
      ids.push(normalizeKey(rows[i].user_id));
      if (normalizeKey(rows[i].username).toLowerCase() === username.toLowerCase()) {
        throw appError('conflict', 'username_already_taken', { username: 'already_taken' });
      }
    }

    var stamp = nowIso();
    var written = appendRow(ss, 'Users', {
      user_id: nextId('U-', ids),
      username: username,
      password_hash: passwordHash,
      display_name: displayName,
      display_name_ar: displayNameAr,
      role: role,
      coordinator_sheet_id: sheetId,
      active: 'TRUE',
      force_password_change: forceChange ? 'TRUE' : 'FALSE',
      last_login_at: '',
      created_at: stamp,
      updated_at: stamp,
      updated_by: session.user_id
    });

    invalidateUsersRegistry();
    return written;
  });

  return { user: toAdminUser(created) };
}

/**
 * `update_user` (3.4).
 *
 * Only the keys actually present in the payload are touched, so the People
 * screen can PATCH one field. Passwords are not editable here — that is
 * reset_user_password.
 *
 * Role changes carry the sheet-id rule with them: promoting a coordinator to
 * manager CLEARS their sheet id, demoting a manager to coordinator REQUIRES one.
 * Either direction can strand the last manager, so both go through
 * assertNotLastManager().
 *
 * @param {Object} session auth context.
 * @param {Object} payload { user_id, username?, display_name?, display_name_ar?,
 *                           role?, coordinator_sheet_id?, active? }
 * @return {Object} { user: <admin shape> }
 */
function handleUpdateUser(session, payload) {
  requireManager(session);

  var body = payload || {};
  var userId = normalizeKey(body.user_id);
  if (!userId) throw appError('validation_failed', 'invalid_user', { user_id: 'required' });

  var current = findUserById(userId);
  if (!current) throw appError('not_found', 'user_not_found');

  var fieldErrors = {};
  var patch = {};

  var currentRole = normalizeKey(current.role).toLowerCase();
  var nextRole = currentRole;

  if (hasField(body, 'role')) {
    nextRole = normalizeKey(body.role).toLowerCase();
    if (USER_ROLES.indexOf(nextRole) === -1) {
      fieldErrors.role = 'must_be_coordinator_or_manager';
      nextRole = currentRole;
    } else if (nextRole !== currentRole) {
      patch.role = nextRole;
    }
  }

  var nextActive = normalizeBoolean(current.active);
  if (hasField(body, 'active')) {
    nextActive = normalizeBoolean(body.active);
    patch.active = nextActive ? 'TRUE' : 'FALSE';
  }

  if (hasField(body, 'username')) {
    var username = normalizeKey(body.username);
    if (!username) fieldErrors.username = 'required';
    else if (username.length > 60) fieldErrors.username = 'too_long';
    else if (/\s/.test(username)) fieldErrors.username = 'no_whitespace';
    else {
      var clash = findUserByUsername(username);
      if (clash && normalizeKey(clash.user_id) !== userId) fieldErrors.username = 'already_taken';
      else patch.username = username;
    }
  }

  if (hasField(body, 'display_name')) {
    var displayName = normalizeKey(body.display_name);
    if (!displayName) fieldErrors.display_name = 'required';
    else if (displayName.length > 100) fieldErrors.display_name = 'too_long';
    else patch.display_name = displayName;
  }

  if (hasField(body, 'display_name_ar')) {
    var displayNameAr = normalizeKey(body.display_name_ar);
    if (displayNameAr.length > 100) fieldErrors.display_name_ar = 'too_long';
    else patch.display_name_ar = displayNameAr;
  }

  // The sheet id is resolved against the role the user will HAVE, not the one
  // they had, so { role:'manager' } alone is enough to clear a stale id.
  var sheetId = hasField(body, 'coordinator_sheet_id')
    ? normalizeKey(body.coordinator_sheet_id)
    : normalizeKey(current.coordinator_sheet_id);

  if (nextRole === 'manager') {
    if (hasField(body, 'coordinator_sheet_id') && sheetId) {
      fieldErrors.coordinator_sheet_id = 'must_be_blank_for_manager';
    } else if (sheetId) {
      patch.coordinator_sheet_id = '';   // promoted: drop the id they no longer use
    }
  } else {
    if (!sheetId) fieldErrors.coordinator_sheet_id = 'required_for_coordinator';
    else if (sheetId !== normalizeKey(current.coordinator_sheet_id)) {
      patch.coordinator_sheet_id = sheetId;
    }
  }

  if (Object.keys(fieldErrors).length) {
    throw appError('validation_failed', 'invalid_user', fieldErrors);
  }

  // Rule 25, from both directions: losing the role and losing the account both
  // remove an active manager.
  var stillActiveManager = nextActive && nextRole === 'manager';
  if (!stillActiveManager) assertNotLastManager(userId);

  if (!Object.keys(patch).length) {
    return { user: toAdminUser(current), updated: [] };
  }

  var applied = Object.keys(patch);
  patch.updated_at = nowIso();
  patch.updated_by = session.user_id;

  var result = withScriptLock(function () {
    var ss = openConfigSpreadsheet();

    var written = updateRowByKey(ss, 'Users', 'user_id', userId, patch);
    if (!written) throw appError('not_found', 'user_not_found');

    // A deactivated or demoted user must not keep acting under the rights they
    // had a moment ago. validateSession() already refuses an inactive user, but
    // dropping the session makes it immediate and visible.
    if (!nextActive || nextRole !== currentRole) deleteSessionsForUser(ss, userId);

    invalidateUsersRegistry();
    return written;
  });

  return { user: toAdminUser(result), updated: applied };
}

/**
 * `reset_user_password` (3.4).
 *
 * Target resolution is deliberate: an ABSENT user_id means "me". A coordinator's
 * client never names a user at all, so a coordinator payload cannot even express
 * targeting someone else. Naming another user_id is what trips the manager check.
 *
 * @param {Object} session auth context from validateSession().
 * @param {Object} payload { password_hash, user_id?, force_password_change? }
 * @return {Object} { user_id, force_password_change, self }
 * @throws {Object} appError('validation_failed'|'forbidden'|'not_found')
 */
function handleResetUserPassword(session, payload) {
  var body = payload || {};

  var callerId = normalizeKey(session.user_id);
  var namedId = normalizeKey(body.user_id);
  var targetId = namedId || callerId;
  var isSelf = (targetId === callerId);

  // Changing someone else's password is a manager act (rule 5). Changing your
  // own is not — otherwise a coordinator could never satisfy a forced reset.
  if (!isSelf) requireManager(session);

  var passwordHash = normalizeKey(body.password_hash).toLowerCase();
  if (!passwordHash) {
    throw appError('validation_failed', 'invalid_password', { password_hash: 'required' });
  }
  if (!SHA256_HEX.test(passwordHash)) {
    // Same guard as login (Auth.gs): a plain-text password would land here, and
    // by then rule 7 has already been broken. Refuse rather than hash it.
    throw appError('validation_failed', 'invalid_password_hash', { password_hash: 'must_be_sha256_hex' });
  }

  var target = findUserById(targetId);
  if (!target) throw appError('not_found', 'user_not_found');
  if (!normalizeBoolean(target.active)) throw appError('forbidden', 'user_inactive');

  // A forced reset that accepts the temporary password again would defeat the
  // whole flow, so the new hash must differ from the stored one.
  if (normalizeKey(target.password_hash).toLowerCase() === passwordHash) {
    throw appError('validation_failed', 'password_unchanged', { password_hash: 'must_differ' });
  }

  // Self-service clears the flag; a manager's reset raises it, unless the
  // manager explicitly says otherwise.
  var forceChange = isSelf
    ? false
    : (body.force_password_change === undefined ? true : normalizeBoolean(body.force_password_change));

  withScriptLock(function () {
    var ss = openConfigSpreadsheet();

    var written = updateRowByKey(ss, 'Users', 'user_id', targetId, {
      password_hash: passwordHash,
      force_password_change: forceChange ? 'TRUE' : 'FALSE',
      updated_at: nowIso(),
      updated_by: callerId
    });

    // updateRowByKey returns null when the key vanished between the lookup
    // above and the lock. Reporting success on a write that did not happen
    // would leave the user believing a password that does not exist.
    if (!written) throw appError('not_found', 'user_not_found');

    // A password someone else changed ends that person's session; a password you
    // changed yourself does not, so a forced reset does not bounce you straight
    // back to the login screen.
    if (!isSelf) deleteSessionsForUser(ss, targetId);

    invalidateUsersRegistry();
  });

  return {
    user_id: targetId,
    force_password_change: forceChange,
    self: isSelf
  };
}

/**
 * `deactivate_user` (3.4). Deactivation instead of deletion (2.1) — a user's
 * history stays attached to their id forever, so a row is never removed.
 *
 * Also reactivates: pass `active: true`. Reactivating cannot break rule 25, so
 * only the deactivating direction is guarded.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { user_id, active? } — `active` defaults to false.
 * @return {Object} { user: <admin shape> }
 */
function handleDeactivateUser(session, payload) {
  requireManager(session);

  var body = payload || {};
  var userId = normalizeKey(body.user_id);
  if (!userId) throw appError('validation_failed', 'invalid_user', { user_id: 'required' });

  var current = findUserById(userId);
  if (!current) throw appError('not_found', 'user_not_found');

  var active = (body.active === undefined) ? false : normalizeBoolean(body.active);

  if (normalizeBoolean(current.active) === active) {
    return { user: toAdminUser(current), changed: false };
  }

  if (!active) assertNotLastManager(userId);

  var result = withScriptLock(function () {
    var ss = openConfigSpreadsheet();

    var written = updateRowByKey(ss, 'Users', 'user_id', userId, {
      active: active ? 'TRUE' : 'FALSE',
      updated_at: nowIso(),
      updated_by: session.user_id
    });
    if (!written) throw appError('not_found', 'user_not_found');

    if (!active) deleteSessionsForUser(ss, userId);

    invalidateUsersRegistry();
    return written;
  });

  return { user: toAdminUser(result), changed: true };
}

/**
 * Rule 25 — "cannot deactivate the last manager", validated server-side.
 *
 * Phrased as "would removing this user's active-manager status leave none?", so
 * it covers deactivation and demotion alike. Counting every OTHER active manager
 * is what makes it safe to call before the write.
 *
 * @param {string} userId the user about to stop being an active manager.
 * @throws {Object} appError('conflict','last_manager') when nobody else is left.
 */
function assertNotLastManager(userId) {
  var target = normalizeKey(userId);
  var users = getUsersRegistry();

  for (var i = 0; i < users.length; i++) {
    var row = users[i];
    if (normalizeKey(row.user_id) === target) continue;
    if (normalizeKey(row.role).toLowerCase() !== 'manager') continue;
    if (normalizeBoolean(row.active)) return;   // someone else is still holding it
  }

  var wasActiveManager = false;
  var self = findUserById(target);
  if (self) {
    wasActiveManager = normalizeBoolean(self.active) &&
      normalizeKey(self.role).toLowerCase() === 'manager';
  }

  // Only complain when this user actually IS the last active manager. Changing a
  // coordinator in a one-manager system must not be blocked.
  if (wasActiveManager) {
    throw appError('conflict', 'last_manager', { user_id: 'cannot_remove_last_manager' });
  }
}

/* ================================================================== *
 * Teams (2.1) — add and toggle. Never hard-delete: an inactive team stays
 * off new entries, but old entries keep the team they were filed under.
 * ================================================================== */

/**
 * @param {Object} row a raw Teams row.
 * @return {Object}
 */
function toPublicTeam(row) {
  return {
    team_id: normalizeKey(row.team_id),
    name: normalizeKey(row.name),
    active: normalizeBoolean(row.active),
    created_at: toStampString(row.created_at),
    updated_at: toStampString(row.updated_at),
    updated_by: normalizeKey(row.updated_by)
  };
}

/**
 * `list_teams` (3.4).
 * @param {Object} session auth context.
 * @param {Object} payload { include_inactive? } — default true (the admin screen
 *        needs the inactive ones to reactivate them).
 * @return {Object} { teams: [...], total }
 */
function handleListTeams(session, payload) {
  // Readable by any signed-in user — the grid's team dropdown (6.6.4) needs it.
  // See requireAnySession() in Registry.gs for why, and note that a non-manager
  // never sees an inactive team.
  requireAnySession(session);

  var body = payload || {};
  var includeInactive = isManagerSession(session)
    ? ((body.include_inactive === undefined) ? true : normalizeBoolean(body.include_inactive))
    : false;

  var rows = getTeamsRegistry();
  var teams = [];

  for (var i = 0; i < rows.length; i++) {
    var team = toPublicTeam(rows[i]);
    if (!team.team_id) continue;
    if (!includeInactive && !team.active) continue;
    teams.push(team);
  }

  teams.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });

  return { teams: teams, total: teams.length };
}

/**
 * `create_team` (3.4).
 * @param {Object} session auth context.
 * @param {Object} payload { name }
 * @return {Object} { team }
 */
function handleCreateTeam(session, payload) {
  requireManager(session);

  var name = normalizeKey((payload || {}).name);
  if (!name) throw appError('validation_failed', 'invalid_team', { name: 'required' });
  if (name.length > 100) throw appError('validation_failed', 'invalid_team', { name: 'too_long' });

  var created = withScriptLock(function () {
    var ss = openConfigSpreadsheet();

    // Re-read under the lock — this is both the duplicate check and the id
    // allocation, and both must see the same snapshot.
    var rows = readAllRows(ss, 'Teams');
    var ids = [];
    for (var i = 0; i < rows.length; i++) {
      ids.push(normalizeKey(rows[i].team_id));
      if (normalizeKey(rows[i].name).toLowerCase() === name.toLowerCase()) {
        throw appError('conflict', 'team_name_taken', { name: 'already_exists' });
      }
    }

    var stamp = nowIso();
    var written = appendRow(ss, 'Teams', {
      team_id: nextId('T-', ids),
      name: name,
      active: 'TRUE',
      created_at: stamp,
      updated_at: stamp,
      updated_by: session.user_id
    });

    invalidateTeamsRegistry();
    return written;
  });

  return { team: toPublicTeam(created) };
}

/**
 * `update_team` (3.4) — rename and/or toggle `active`. There is no delete_team,
 * by design: entries already filed under a team must keep resolving its name.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { team_id, name?, active? }
 * @return {Object} { team, updated: [keys] }
 */
function handleUpdateTeam(session, payload) {
  requireManager(session);

  var body = payload || {};
  var teamId = normalizeKey(body.team_id);
  if (!teamId) throw appError('validation_failed', 'invalid_team', { team_id: 'required' });

  var rows = getTeamsRegistry();
  var current = null;
  for (var i = 0; i < rows.length; i++) {
    if (normalizeKey(rows[i].team_id) === teamId) { current = rows[i]; break; }
  }
  if (!current) throw appError('not_found', 'team_not_found');

  var patch = {};

  if (hasField(body, 'name')) {
    var name = normalizeKey(body.name);
    if (!name) throw appError('validation_failed', 'invalid_team', { name: 'required' });
    if (name.length > 100) throw appError('validation_failed', 'invalid_team', { name: 'too_long' });

    for (var j = 0; j < rows.length; j++) {
      if (normalizeKey(rows[j].team_id) === teamId) continue;
      if (normalizeKey(rows[j].name).toLowerCase() === name.toLowerCase()) {
        throw appError('conflict', 'team_name_taken', { name: 'already_exists' });
      }
    }
    if (name !== normalizeKey(current.name)) patch.name = name;
  }

  if (hasField(body, 'active')) {
    var active = normalizeBoolean(body.active);
    if (active !== normalizeBoolean(current.active)) patch.active = active ? 'TRUE' : 'FALSE';
  }

  if (!Object.keys(patch).length) {
    return { team: toPublicTeam(current), updated: [] };
  }

  var applied = Object.keys(patch);
  patch.updated_at = nowIso();
  patch.updated_by = session.user_id;

  var result = withScriptLock(function () {
    var written = updateRowByKey(openConfigSpreadsheet(), 'Teams', 'team_id', teamId, patch);
    if (!written) throw appError('not_found', 'team_not_found');
    invalidateTeamsRegistry();
    return written;
  });

  return { team: toPublicTeam(result), updated: applied };
}

/* ================================================================== *
 * SiteJC (2.1) — the Site ID -> Job Code + period lookup.
 *
 * This is the tab that folds "JC Finder" into entry, and `period` is the field
 * that routes a row to the old or the new Tracking# (rule 14 / 6.2).
 *
 * A row is one TASK, not one site: the source tracking file raises a fresh job
 * code against a site every time work is ordered there, so identity is the pair
 * site_id + job_code (siteJcKey) and a site legitimately carries several. The
 * `task_date` that comes with each pair is what tells them apart, and it is also
 * the only authority on the period — see derivePeriodFromTaskDate.
 *
 * Matching is case-insensitive throughout (see getSiteJcMap). The id is stored
 * exactly as typed.
 * ================================================================== */

/**
 * @param {Object} row a raw SiteJC row.
 * @return {Object}
 */
function toPublicSiteJc(row) {
  return {
    site_id: normalizeKey(row.site_id),
    job_code: normalizeKey(row.job_code),
    task_date: normalizeTaskDate(row.task_date),
    period: normalizePeriod(row.period),
    updated_at: toStampString(row.updated_at),
    updated_by: normalizeKey(row.updated_by)
  };
}

/**
 * `list_site_jc` (3.4).
 *
 * The whole lookup comes back in one call — the admin screen filters and pages
 * client-side, and the grid's autofill wants the map in memory anyway. `search`
 * is offered for a targeted lookup against a large sheet.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { search?, period? }
 * @return {Object} { sites: [...], total, returned }
 */
function handleListSiteJc(session, payload) {
  // Readable by any signed-in user: 6.6.3 makes this lookup the thing that fills
  // in a Job Code and a period as a coordinator types a Site ID. See
  // requireAnySession() in Registry.gs.
  requireAnySession(session);

  var body = payload || {};
  var search = normalizeSiteId(body.search);
  var period = normalizePeriod(body.period);

  var rows = getSiteJcRows();
  var sites = [];
  var total = 0;

  for (var i = 0; i < rows.length; i++) {
    var site = toPublicSiteJc(rows[i]);
    if (!site.site_id) continue;
    total++;

    if (period && site.period !== period) continue;
    if (search &&
        normalizeSiteId(site.site_id).indexOf(search) === -1 &&
        normalizeSiteId(site.job_code).indexOf(search) === -1) continue;

    sites.push(site);
  }

  // Site first, then newest task date — so a site's several job codes arrive
  // together, in the order the picker will offer them.
  sites.sort(function (a, b) {
    var x = normalizeSiteId(a.site_id), y = normalizeSiteId(b.site_id);
    if (x !== y) return x < y ? -1 : 1;
    return compareByTaskDateDesc(a, b);
  });

  return { sites: sites, total: total, returned: sites.length };
}

/**
 * `upsert_site_jc` (3.4) — add or correct one site + job code pair.
 *
 * Keyed on the PAIR, so adding a second job code to a site creates a row rather
 * than overwriting the first (2.1). Two fields are treated as "leave alone when
 * the caller does not mention them", because the admin screen's inline period
 * flip sends nothing but the key and the new period:
 *
 *   - an absent `task_date` keeps the stored one,
 *   - an absent `period` is derived from whatever task_date ends up stored.
 *
 * A period that IS sent wins, and stands until the next upload re-derives it
 * from the file (rule 14) — which is what the screen's hint says.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { site_id, job_code, task_date?, period? }
 * @return {Object} { site, created: boolean }
 */
function handleUpsertSiteJc(session, payload) {
  requireManager(session);

  var body = payload || {};
  var stamp = nowIso();

  var result = withScriptLock(function () {
    var ss = openConfigSpreadsheet();

    // Re-read under the lock: an upsert must see the current sheet to decide
    // between patching a row and appending a new one.
    var rows = readAllRows(ss, 'SiteJC');
    var target = siteJcKey(body.site_id, body.job_code);
    var existing = null;

    for (var i = 0; i < rows.length; i++) {
      if (siteJcKey(rows[i].site_id, rows[i].job_code) === target) { existing = rows[i]; break; }
    }

    var merged = {
      site_id: body.site_id,
      job_code: body.job_code,
      task_date: Object.prototype.hasOwnProperty.call(body, 'task_date')
        ? body.task_date
        : (existing ? existing.task_date : ''),
      period: normalizeKey(body.period) || null
    };

    var clean = validateSiteJcRow(merged);

    var record = {
      site_id: clean.site_id,
      job_code: clean.job_code,
      task_date: clean.task_date,
      period: clean.period,
      updated_at: stamp,
      updated_by: session.user_id
    };

    var written;
    if (existing) {
      written = updateRowAt(ss, 'SiteJC', existing._row, record);
    } else {
      written = appendRow(ss, 'SiteJC', record);
    }

    invalidateSiteJc();
    return { row: written, created: !existing };
  });

  return { site: toPublicSiteJc(result.row), created: result.created };
}

/**
 * `bulk_import_site_jc` (3.4) — the "Upload Excel" path.
 *
 * The client parses the tracking .xlsx with xlsx-js-style and sends JSON; this
 * validates every row BEFORE writing any of them, so a bad cell on row 400 does
 * not leave the lookup half-imported.
 *
 * Two things this does NOT take from the client:
 *
 *   - **The period.** It is re-derived here from `task_date` against
 *     `fiscal_new_from_year` (rule 14). The uploaded file's own Old/New column is
 *     never read — one authority for the old/new split, and it is the date.
 *   - **What the sheet already holds.** The default `mode` is `replace`: the
 *     uploaded file becomes the lookup, and a site+job-code pair that has left
 *     the file leaves the lookup with it. The source is a dated full export, so
 *     merging would keep cancelled tasks alive forever. `mode: 'merge'` keeps the
 *     old upsert-only behaviour for a partial file.
 *
 * Within the payload, rows are deduped by site_id + job_code and the LAST one
 * wins — an upload carrying both `k3799-ABD01` and `K3799-abd01` writes one row.
 *
 * The write is batched into one clear plus one setValues(). A per-row update
 * would re-read the whole tab thousands of times and time out.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { rows: [{site_id, job_code, task_date}, ...], mode? }
 * @return {Object} { imported, created, updated, unchanged, removed,
 *                    duplicates_collapsed, mode }
 */
function handleBulkImportSiteJc(session, payload) {
  requireManager(session);

  var body = payload || {};
  var mode = (normalizeKey(body.mode).toLowerCase() === 'merge') ? 'merge' : 'replace';

  var incoming = body.rows || body.sites;
  if (!(incoming instanceof Array)) {
    throw appError('validation_failed', 'invalid_rows', { rows: 'must_be_array' });
  }
  if (!incoming.length) {
    throw appError('validation_failed', 'no_rows', { rows: 'required' });
  }
  if (incoming.length > MAX_BULK_SITE_JC_ROWS) {
    throw appError('validation_failed', 'too_many_rows', {
      rows: 'max_' + MAX_BULK_SITE_JC_ROWS
    });
  }

  // Pass 1 — validate everything, collecting every failure so the manager fixes
  // the spreadsheet once rather than one row per upload attempt.
  var fieldErrors = {};
  var byKey = {};
  var order = [];
  var collapsed = 0;

  for (var i = 0; i < incoming.length; i++) {
    var raw = incoming[i] || {};
    var clean;

    try {
      clean = validateSiteJcRow({
        site_id: raw.site_id,
        job_code: raw.job_code,
        task_date: raw.task_date,
        period: null                       // always derived from the date here
      });
    } catch (err) {
      var errs = (err && err.field_errors) ? err.field_errors : { row: 'invalid' };
      var keys = Object.keys(errs);
      for (var k = 0; k < keys.length; k++) {
        fieldErrors['rows[' + i + '].' + keys[k]] = errs[keys[k]];
      }
      continue;
    }

    var key = siteJcKey(clean.site_id, clean.job_code);
    if (Object.prototype.hasOwnProperty.call(byKey, key)) collapsed++;
    else order.push(key);
    byKey[key] = clean;
  }

  if (Object.keys(fieldErrors).length) {
    throw appError('validation_failed', 'invalid_site_jc_rows', fieldErrors);
  }

  var stamp = nowIso();
  var actor = session.user_id;

  var result = withScriptLock(function () {
    var ss = openConfigSpreadsheet();
    var sheet = getSheet(ss, 'SiteJC');
    var headers = getHeaders(ss, 'SiteJC');
    var lastRow = sheet.getLastRow();

    var colSite = headers.indexOf('site_id');
    var colJc = headers.indexOf('job_code');
    var colTaskDate = headers.indexOf('task_date');
    var colPeriod = headers.indexOf('period');
    if (colSite === -1 || colJc === -1 || colTaskDate === -1 || colPeriod === -1) {
      throw appError('server_error', 'sitejc_headers_missing');
    }
    var colUpdatedAt = headers.indexOf('updated_at');
    var colUpdatedBy = headers.indexOf('updated_by');

    // One read of the whole data block; every comparison happens in memory.
    var data = (lastRow >= 2)
      ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
      : [];

    var stored = {};
    for (var r = 0; r < data.length; r++) {
      var storedKey = siteJcKey(data[r][colSite], data[r][colJc]);
      if (storedKey !== ' ') stored[storedKey] = data[r];
    }

    var created = 0;
    var updated = 0;
    var unchanged = 0;
    var lines = [];

    for (var o = 0; o < order.length; o++) {
      var row = byKey[order[o]];
      var was = stored[order[o]] || null;

      /*
       * Keep the stored spelling of the pair when we already have it: the import
       * corrects the DATA, not how somebody once capitalised a key. Everything
       * else on the row comes from the file.
       */
      var line = [];
      for (var c = 0; c < headers.length; c++) line.push(was ? was[c] : '');

      var same = !!was &&
        normalizeTaskDate(was[colTaskDate]) === row.task_date &&
        normalizePeriod(was[colPeriod]) === row.period;

      if (!was) line[colSite] = row.site_id;
      if (!was) line[colJc] = row.job_code;
      line[colTaskDate] = row.task_date;
      line[colPeriod] = row.period;

      if (!was) created++;
      else if (same) unchanged++;
      else updated++;

      // An unchanged row keeps its audit stamp — "updated_at" should mean the
      // last time the value moved, not the last time a file mentioned it.
      if (!same) {
        if (colUpdatedAt !== -1) line[colUpdatedAt] = stamp;
        if (colUpdatedBy !== -1) line[colUpdatedBy] = actor;
      }

      lines.push(line);
    }

    var removed = 0;

    if (mode === 'merge') {
      // Everything the file did not mention stays, exactly as it is.
      var keptKeys = Object.keys(stored);
      for (var m = 0; m < keptKeys.length; m++) {
        if (!Object.prototype.hasOwnProperty.call(byKey, keptKeys[m])) {
          lines.push(stored[keptKeys[m]]);
        }
      }
    } else {
      var storedKeys = Object.keys(stored);
      for (var s = 0; s < storedKeys.length; s++) {
        if (!Object.prototype.hasOwnProperty.call(byKey, storedKeys[s])) removed++;
      }
    }

    // Clear then write: a replace that shrinks the tab must not leave the tail
    // of the previous list sitting under the new one.
    if (lastRow >= 2) {
      sheet.getRange(2, 1, lastRow - 1, sheet.getMaxColumns()).clearContent();
    }
    if (lines.length) {
      ensureRowCapacity(sheet, lines.length + 1);
      sheet.getRange(2, 1, lines.length, headers.length).setValues(lines);
    }

    invalidateSiteJc();
    return { created: created, updated: updated, unchanged: unchanged, removed: removed };
  });

  return {
    imported: result.created + result.updated + result.unchanged,
    created: result.created,
    updated: result.updated,
    unchanged: result.unchanged,
    removed: result.removed,
    duplicates_collapsed: collapsed,
    mode: mode
  };
}

/**
 * `delete_site_jc` (3.4).
 *
 * One of only three hard-deletes in the app (the others being an expired session
 * and a `draft` entry). It is safe here because SiteJC is reference data, not a
 * record: an entry stores its own resolved job_code and period at save time, so
 * removing a stale lookup row never rewrites history.
 *
 * With a `job_code` it removes that one pair; without one it removes every job
 * code the site carries, which is how a site is retired now that it holds a list
 * (2.1). Rows are deleted bottom-up so the earlier `_row` numbers stay valid.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { site_id, job_code? }
 * @return {Object} { deleted: true, site_id, removed }
 */
function handleDeleteSiteJc(session, payload) {
  requireManager(session);

  var body = payload || {};
  var siteId = normalizeKey(body.site_id);
  if (!siteId) throw appError('validation_failed', 'invalid_site', { site_id: 'required' });

  var jobCode = normalizeKey(body.job_code);
  var targetSite = normalizeSiteId(siteId);
  var targetPair = jobCode ? siteJcKey(siteId, jobCode) : '';

  var stored = withScriptLock(function () {
    var ss = openConfigSpreadsheet();
    var rows = readAllRows(ss, 'SiteJC');
    var sheet = getSheet(ss, 'SiteJC');
    var hits = [];

    for (var i = 0; i < rows.length; i++) {
      var matches = targetPair
        ? siteJcKey(rows[i].site_id, rows[i].job_code) === targetPair
        : normalizeSiteId(rows[i].site_id) === targetSite;

      if (matches) hits.push(rows[i]);
    }

    if (!hits.length) return null;

    for (var h = hits.length - 1; h >= 0; h--) sheet.deleteRow(hits[h]._row);

    invalidateSiteJc();
    return { site_id: normalizeKey(hits[0].site_id), removed: hits.length };
  });

  if (stored === null) throw appError('not_found', 'site_not_found');

  return { deleted: true, site_id: stored.site_id, removed: stored.removed };
}

/**
 * Validate one SiteJC row.
 *
 * `period` is derived from `task_date` unless the caller passes one explicitly
 * (rule 14) — the import never does, the admin screen's manual add and inline
 * flip both do.
 *
 * @param {Object} raw { site_id, job_code, task_date?, period? }
 * @return {Object} the cleaned row.
 * @throws {Object} appError('validation_failed') carrying per-field reasons.
 */
function validateSiteJcRow(raw) {
  var fieldErrors = {};

  var siteId = normalizeKey(raw.site_id);
  if (!siteId) fieldErrors.site_id = 'required';
  else if (siteId.length > 60) fieldErrors.site_id = 'too_long';
  else if (siteId.indexOf('/') !== -1) fieldErrors.site_id = 'must_be_single_site';

  var jobCode = normalizeKey(raw.job_code);
  if (!jobCode) fieldErrors.job_code = 'required';
  else if (jobCode.length > 60) fieldErrors.job_code = 'too_long';
  else if (jobCode.indexOf('/') !== -1) fieldErrors.job_code = 'must_be_single_job_code';

  /*
   * A task date that was SENT but is not a date is an error; an absent one is
   * not. The source file carries undated tasks, and the owner's rule is that
   * they settle as `new` rather than being refused at the door.
   */
  var taskDate = normalizeTaskDate(raw.task_date);
  if (!taskDate && normalizeKey(raw.task_date)) fieldErrors.task_date = 'must_be_iso_date';

  var period = normalizePeriod(raw.period);
  if (!period) {
    if (normalizeKey(raw.period)) fieldErrors.period = 'must_be_old_or_new';
    else period = derivePeriodFromTaskDate(taskDate);
  }

  if (Object.keys(fieldErrors).length) {
    throw appError('validation_failed', 'invalid_site_jc', fieldErrors);
  }

  return { site_id: siteId, job_code: jobCode, task_date: taskDate, period: period };
}

/* ================================================================== *
 * Lists (2.1) — the dropdown reference data, grouped by list_name.
 *
 * The tab has no primary key, so the write model is "replace one named list
 * wholesale". That is also what the admin screen does: it edits a list as a
 * whole and saves it.
 * ================================================================== */

/**
 * `list_lists` (3.4).
 * @param {Object} session auth context.
 * @param {Object} payload { list_name?, include_inactive? } — default: every
 *        list, including inactive options.
 * @return {Object} { lists: { projects: [...], ... } }
 */
function handleListLists(session, payload) {
  // Readable by any signed-in user — the grid's project / category / area /
  // driver dropdowns (6.6.4). See requireAnySession() in Registry.gs.
  requireAnySession(session);

  var body = payload || {};
  var only = normalizeKey(body.list_name).toLowerCase();
  if (only && LIST_NAMES.indexOf(only) === -1) {
    throw appError('validation_failed', 'invalid_list_name', { list_name: 'unknown_list' });
  }
  var includeInactive = isManagerSession(session)
    ? ((body.include_inactive === undefined) ? true : normalizeBoolean(body.include_inactive))
    : false;

  var lists = {};
  var names = only ? [only] : LIST_NAMES;
  for (var n = 0; n < names.length; n++) lists[names[n]] = [];

  var rows = getListsRows();
  for (var i = 0; i < rows.length; i++) {
    var name = normalizeKey(rows[i].list_name).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(lists, name)) continue;

    var value = normalizeKey(rows[i].value);
    if (!value) continue;

    var active = normalizeBoolean(rows[i].active);
    if (!includeInactive && !active) continue;

    var sortOrder = parseInt(rows[i].sort_order, 10);
    lists[name].push({
      value: value,
      active: active,
      sort_order: isFinite(sortOrder) ? sortOrder : (i + 1)
    });
  }

  for (var m = 0; m < names.length; m++) {
    lists[names[m]].sort(function (a, b) {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a.value < b.value ? -1 : (a.value > b.value ? 1 : 0);
    });
  }

  return { lists: lists };
}

/**
 * `update_lists` (3.4) — replace one or more named lists wholesale.
 *
 * Accepts either shape:
 *   { list_name: 'projects', items: [{value, active?, sort_order?}, ...] }
 *   { lists: { projects: [...], areas: [...] } }
 *
 * Items may also be bare strings; they become active options in payload order.
 *
 * Lists that are not named are left untouched. Removing an option here is a real
 * removal — this tab is reference data, and an entry already stores the string it
 * was filed under, so dropping an option never rewrites an entry.
 *
 * @param {Object} session auth context.
 * @param {Object} payload
 * @return {Object} { updated: [list names], lists: {...} }
 */
function handleUpdateLists(session, payload) {
  requireManager(session);

  var body = payload || {};

  var incoming = {};
  if (body.lists && typeof body.lists === 'object' && !(body.lists instanceof Array)) {
    incoming = body.lists;
  } else if (hasField(body, 'list_name')) {
    incoming[normalizeKey(body.list_name)] = body.items || body.values || [];
  } else {
    throw appError('validation_failed', 'no_lists', { lists: 'required' });
  }

  var names = Object.keys(incoming);
  if (!names.length) throw appError('validation_failed', 'no_lists', { lists: 'required' });

  // Validate every list before touching the sheet, so one bad option cannot
  // leave half the dropdowns rewritten.
  var fieldErrors = {};
  var clean = {};

  for (var n = 0; n < names.length; n++) {
    var name = normalizeKey(names[n]).toLowerCase();
    if (LIST_NAMES.indexOf(name) === -1) {
      fieldErrors[names[n]] = 'unknown_list';
      continue;
    }

    var items = incoming[names[n]];
    if (!(items instanceof Array)) {
      fieldErrors[name] = 'must_be_array';
      continue;
    }

    var seen = {};
    var cleanItems = [];

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var isString = (typeof item === 'string');
      var value = normalizeKey(isString ? item : (item ? item.value : ''));

      if (!value) { fieldErrors[name + '[' + i + '].value'] = 'required'; continue; }
      if (value.length > 100) { fieldErrors[name + '[' + i + '].value'] = 'too_long'; continue; }

      var dedupe = value.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(seen, dedupe)) {
        fieldErrors[name + '[' + i + '].value'] = 'duplicate';
        continue;
      }
      seen[dedupe] = true;

      var active = (!isString && item && hasField(item, 'active')) ? normalizeBoolean(item.active) : true;

      var sortOrder = (!isString && item) ? parseInt(item.sort_order, 10) : NaN;
      if (!isFinite(sortOrder)) sortOrder = cleanItems.length + 1;

      cleanItems.push({ value: value, active: active, sort_order: sortOrder });
    }

    clean[name] = cleanItems;
  }

  if (Object.keys(fieldErrors).length) {
    throw appError('validation_failed', 'invalid_lists', fieldErrors);
  }

  var applied = Object.keys(clean);

  withScriptLock(function () {
    var ss = openConfigSpreadsheet();
    var sheet = getSheet(ss, 'Lists');
    var headers = getHeaders(ss, 'Lists');
    var lastRow = sheet.getLastRow();

    var colName = headers.indexOf('list_name');
    var colValue = headers.indexOf('value');
    if (colName === -1 || colValue === -1) {
      throw appError('server_error', 'lists_headers_missing');
    }
    var colActive = headers.indexOf('active');
    var colSort = headers.indexOf('sort_order');

    // Rebuild the whole tab: every row of a list NOT being replaced is carried
    // over verbatim, then the replacement lists are written after them.
    var kept = [];
    if (lastRow >= 2) {
      var data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
      for (var r = 0; r < data.length; r++) {
        var rowName = normalizeKey(data[r][colName]).toLowerCase();
        if (!rowName) continue;
        if (applied.indexOf(rowName) !== -1) continue;   // being replaced
        kept.push(data[r]);
      }
    }

    var out = kept;
    for (var a = 0; a < applied.length; a++) {
      var listName = applied[a];
      var items = clean[listName];

      for (var i = 0; i < items.length; i++) {
        var line = [];
        for (var c = 0; c < headers.length; c++) line.push('');
        line[colName] = listName;
        line[colValue] = items[i].value;
        if (colActive !== -1) line[colActive] = items[i].active ? 'TRUE' : 'FALSE';
        if (colSort !== -1) line[colSort] = items[i].sort_order;
        out.push(line);
      }
    }

    if (lastRow >= 2) {
      sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
    }
    if (out.length) {
      ensureRowCapacity(sheet, out.length + 1);
      sheet.getRange(2, 1, out.length, headers.length).setValues(out);
    }

    invalidateLists();
  });

  return { updated: applied, lists: handleListLists(session, {}).lists };
}

/* ------------------------------------------------------------------ *
 * Local helper
 * ------------------------------------------------------------------ */

/**
 * Was this key actually sent? The PATCH handlers above distinguish "absent, leave
 * alone" from "sent as empty, clear it", so `!obj.key` is not good enough.
 * @param {Object} obj
 * @param {string} key
 * @return {boolean}
 */
function hasField(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}
