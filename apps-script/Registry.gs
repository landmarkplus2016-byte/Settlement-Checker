/**
 * Registry.gs — the Users tab is both the account list and the
 * coordinator -> spreadsheet registry (CLAUDE.md 2.1).
 *
 * This file is where the coordinator-isolation guarantee lives (rule 4 / 3.8):
 * a coordinator's spreadsheet id is read from the row of the user *in the
 * session*, and from nowhere else. No payload field, no argument, and no other
 * file may name a coordinator's sheet id. Nothing here ever returns an id to a
 * caller — it returns an opened Spreadsheet.
 */

/* Per-request cache of the registry (CLAUDE.md 2.4). */
var __usersCache = null;

/* ------------------------------------------------------------------ *
 * Reading the registry
 * ------------------------------------------------------------------ */

/**
 * All Users rows, raw and cached for this request.
 *
 * INTERNAL ONLY — these rows carry `password_hash` and `coordinator_sheet_id`.
 * Never put one in a response; shape it with toPublicUser() first.
 *
 * @return {Array<Object>}
 */
function getUsersRegistry() {
  if (__usersCache) return __usersCache;
  __usersCache = readAllRows(openConfigSpreadsheet(), 'Users');
  return __usersCache;
}

/** Drop the cached registry after a write to Users. */
function invalidateUsersRegistry() {
  __usersCache = null;
}

/**
 * Look a user up by primary key.
 * @param {string} userId
 * @return {Object|null} the raw row.
 */
function findUserById(userId) {
  var target = normalizeKey(userId);
  if (!target) return null;

  var users = getUsersRegistry();
  for (var i = 0; i < users.length; i++) {
    if (normalizeKey(users[i].user_id) === target) return users[i];
  }
  return null;
}

/**
 * Look a user up by username, case-insensitively (3.2).
 * @param {string} username
 * @return {Object|null} the raw row.
 */
function findUserByUsername(username) {
  var target = normalizeKey(username).toLowerCase();
  if (!target) return null;

  var users = getUsersRegistry();
  for (var i = 0; i < users.length; i++) {
    if (normalizeKey(users[i].username).toLowerCase() === target) return users[i];
  }
  return null;
}

/**
 * The client-safe shape of a user (3.2). Exactly these four fields — never
 * `password_hash`, never `coordinator_sheet_id`, in any response, ever.
 * @param {Object} row a raw Users row.
 * @return {Object}
 */
function toPublicUser(row) {
  return {
    user_id: normalizeKey(row.user_id),
    display_name: normalizeKey(row.display_name),
    display_name_ar: normalizeKey(row.display_name_ar),
    role: normalizeKey(row.role)
  };
}

/* ------------------------------------------------------------------ *
 * Role guards
 * ------------------------------------------------------------------ */

/**
 * @param {Object} session auth context from validateSession().
 * @throws {Object} appError('forbidden') unless the caller is a manager.
 */
function requireManager(session) {
  if (!session || normalizeKey(session.role) !== 'manager') {
    throw appError('forbidden', 'manager_only');
  }
}

/**
 * @param {Object} session auth context from validateSession().
 * @throws {Object} appError('forbidden') unless the caller is a coordinator.
 */
function requireCoordinator(session) {
  if (!session || normalizeKey(session.role) !== 'coordinator') {
    throw appError('forbidden', 'coordinator_only');
  }
}

/**
 * @param {Object} session
 * @return {boolean} true when the caller is a manager. For handlers that serve
 *         both roles and only narrow WHAT is returned, not whether it is.
 */
function isManagerSession(session) {
  return !!session && normalizeKey(session.role) === 'manager';
}

/**
 * The reference data every signed-in user may read: the active Teams, the active
 * Lists, and the Site -> Job Code lookup.
 *
 * These three READS are deliberately not manager-only, and the reason is in
 * CLAUDE.md itself. 3.4 lists them under the admin actions, but 6.6.3 requires a
 * coordinator's grid to resolve a Site ID against SiteJC as he types, and 6.6.4
 * requires project / category / area / team to be in-cell dropdowns. A
 * coordinator who cannot read that data cannot be given either feature, so the
 * two sections contradict each other and this resolves it the only way that
 * leaves the app buildable.
 *
 * Nothing is given away by it: this is shared configuration with no personal
 * data, no money and no spreadsheet ids, and it is data the coordinator would
 * otherwise be typing in by hand from the same list. Every WRITE to these tabs
 * stays manager-only (rule 5), and non-managers only ever see ACTIVE rows.
 *
 * @param {Object} session auth context.
 * @throws {Object} appError('unauthenticated') when there is no session at all.
 */
function requireAnySession(session) {
  if (!session || !normalizeKey(session.user_id)) {
    throw appError('unauthenticated', 'missing_session');
  }
}

/* ------------------------------------------------------------------ *
 * Resolving spreadsheets
 * ------------------------------------------------------------------ */

/**
 * The calling coordinator's own spreadsheet.
 *
 * The id is read from the Users row identified by `session.user_id`. There is
 * deliberately no parameter for naming a different user or a sheet id: this
 * function is the whole reason a coordinator cannot reach another coordinator's
 * data even by forging a request (rule 4).
 *
 * @param {Object} session auth context from validateSession().
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function resolveCoordinatorSheet(session) {
  requireCoordinator(session);

  var row = findUserById(session.user_id);
  if (!row) throw appError('unauthenticated', 'user_not_found');
  if (!normalizeBoolean(row.active)) throw appError('forbidden', 'user_inactive');

  var sheetId = normalizeKey(row.coordinator_sheet_id);
  if (!sheetId) throw appError('server_error', 'coordinator_sheet_not_configured');

  return openById(sheetId);
}

/**
 * A named coordinator's spreadsheet, for a manager acting on someone else's
 * data — approve_entry, return_entry, export (3.6 / 3.7). This is the one path
 * that reaches another user's sheet, and it is gated on role here so no caller
 * can forget the check.
 *
 * @param {Object} session auth context; must be a manager.
 * @param {string} coordinatorUserId the target coordinator.
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function resolveCoordinatorSheetAsManager(session, coordinatorUserId) {
  requireManager(session);

  var row = findUserById(coordinatorUserId);
  if (!row) throw appError('not_found', 'coordinator_not_found');
  if (normalizeKey(row.role) !== 'coordinator') throw appError('not_found', 'coordinator_not_found');

  var sheetId = normalizeKey(row.coordinator_sheet_id);
  if (!sheetId) throw appError('server_error', 'coordinator_sheet_not_configured');

  return openById(sheetId);
}

/**
 * Guard for coordinator actions: a coordinator payload may not name a sheet or
 * another user (3.8 — "a coordinator_sheet_id or foreign user_id in a
 * coordinator payload is a forbidden"). Call this at the top of every
 * coordinator handler, before touching the payload.
 *
 * @param {Object} session auth context.
 * @param {Object} payload
 */
function assertNoSheetTargeting(session, payload) {
  var body = payload || {};

  if (normalizeKey(body.coordinator_sheet_id) || normalizeKey(body.sheet_id) ||
      normalizeKey(body.spreadsheet_id)) {
    throw appError('forbidden', 'sheet_targeting_not_allowed');
  }

  var named = normalizeKey(body.user_id) || normalizeKey(body.coordinator_user_id);
  if (named && named !== normalizeKey(session.user_id)) {
    throw appError('forbidden', 'foreign_user_not_allowed');
  }
}

/* ------------------------------------------------------------------ *
 * Walking every coordinator
 * ------------------------------------------------------------------ */

/**
 * Open every active coordinator's spreadsheet in turn and hand it to `fn`.
 * This is how the manager screens consolidate across sheets (3.6 / 3.7).
 *
 * The caller must have already called requireManager() — this function does not
 * check the role, because it does not know which action it is serving.
 *
 * One unreadable sheet does not abort the whole sweep, but it is NOT swallowed:
 * it is reported in `errors`. Callers MUST surface a non-empty `errors` to the
 * manager. Presenting a partial consolidation as complete would let an entry go
 * unapproved without anyone noticing.
 *
 * @param {function(Object, GoogleAppsScript.Spreadsheet.Spreadsheet)} fn
 *        called as fn(userRow, spreadsheet) for each active coordinator.
 * @return {{visited:number, skipped:Array<Object>, errors:Array<Object>}}
 */
function forEachCoordinator(fn) {
  var users = getUsersRegistry();
  var visited = 0;
  var skipped = [];
  var errors = [];

  for (var i = 0; i < users.length; i++) {
    var row = users[i];
    if (normalizeKey(row.role) !== 'coordinator') continue;
    if (!normalizeBoolean(row.active)) continue;

    var sheetId = normalizeKey(row.coordinator_sheet_id);
    if (!sheetId) {
      skipped.push({ user_id: normalizeKey(row.user_id), reason: 'coordinator_sheet_not_configured' });
      continue;
    }

    try {
      fn(row, openById(sheetId));
      visited++;
    } catch (err) {
      errors.push({
        user_id: normalizeKey(row.user_id),
        reason: (err && err.message) ? String(err.message) : 'sheet_unreadable'
      });
    }
  }

  return { visited: visited, skipped: skipped, errors: errors };
}
