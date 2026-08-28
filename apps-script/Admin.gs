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
var MAX_BULK_SITE_JC_ROWS = 5000;

/* Per-request caches (CLAUDE.md 2.4). Apps Script gives each request a fresh
 * global scope, so these need no cross-request invalidation — only the
 * invalidate* calls after a write within the same request. */
var __teamsCache = null;
var __siteJcCache = null;
var __listsCache = null;

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
 * The Site ID -> { job_code, period } lookup, keyed by NORMALIZED site id.
 *
 * Site ids match case-insensitively: real site lists are typed by many hands and
 * carry `k3799` next to `K3666`. A coordinator typing `K3799` from paperwork must
 * still get the row, because `period` is what routes an entry to the old vs new
 * tracking number — a case mismatch would silently break the old/new split.
 * The site id is STORED exactly as it was entered; only comparisons normalize.
 *
 * @return {Object} normalized site_id -> { site_id, job_code, period }
 */
function getSiteJcMap() {
  var rows = getSiteJcRows();
  var map = {};

  for (var i = 0; i < rows.length; i++) {
    var siteId = normalizeKey(rows[i].site_id);
    if (!siteId) continue;
    map[normalizeSiteId(siteId)] = {
      site_id: siteId,
      job_code: normalizeKey(rows[i].job_code),
      period: normalizePeriod(rows[i].period)
    };
  }
  return map;
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
 * that routes a row to the old or the new Tracking# (rule 14 / 6.2). It is
 * therefore required on every write, never inferred.
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

  sites.sort(function (a, b) {
    var x = normalizeSiteId(a.site_id), y = normalizeSiteId(b.site_id);
    return x < y ? -1 : (x > y ? 1 : 0);
  });

  return { sites: sites, total: total, returned: sites.length };
}

/**
 * `upsert_site_jc` (3.4) — add or correct one site.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { site_id, job_code, period }
 * @return {Object} { site, created: boolean }
 */
function handleUpsertSiteJc(session, payload) {
  requireManager(session);

  var clean = validateSiteJcRow(payload || {});
  var stamp = nowIso();

  var result = withScriptLock(function () {
    var ss = openConfigSpreadsheet();

    // Re-read under the lock: an upsert must see the current sheet to decide
    // between patching a row and appending a new one.
    var rows = readAllRows(ss, 'SiteJC');
    var target = normalizeSiteId(clean.site_id);
    var existing = null;

    for (var i = 0; i < rows.length; i++) {
      if (normalizeSiteId(rows[i].site_id) === target) { existing = rows[i]; break; }
    }

    var record = {
      site_id: clean.site_id,
      job_code: clean.job_code,
      period: clean.period,
      updated_at: stamp,
      updated_by: session.user_id
    };

    var written;
    if (existing) {
      // Address the row by the id AS STORED — a case-insensitive match found it,
      // but updateRowByKey compares exactly.
      written = updateRowByKey(ss, 'SiteJC', 'site_id', normalizeKey(existing.site_id), record);
      if (!written) throw appError('not_found', 'site_not_found');
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
 * The client parses the .xlsx with SheetJS and sends JSON; this validates every
 * row BEFORE writing any of them, so a bad cell on row 400 does not leave the
 * lookup half-imported. `period` is required on every row (3.4).
 *
 * Within the payload, rows are deduped by normalized site_id and the LAST one
 * wins — an upload carrying both `k3799` and `K3799` updates one row rather than
 * creating two.
 *
 * The write is batched: existing rows are patched in a single setValues() over
 * the data range and new rows appended in one more. A per-row updateRowByKey
 * would re-read the whole tab thousands of times and time out.
 *
 * @param {Object} session auth context.
 * @param {Object} payload { rows: [{site_id, job_code, period}, ...] }
 * @return {Object} { imported, created, updated, duplicates_collapsed }
 */
function handleBulkImportSiteJc(session, payload) {
  requireManager(session);

  var body = payload || {};
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
    var clean;
    try {
      clean = validateSiteJcRow(incoming[i] || {});
    } catch (err) {
      var errs = (err && err.field_errors) ? err.field_errors : { row: 'invalid' };
      var keys = Object.keys(errs);
      for (var k = 0; k < keys.length; k++) {
        fieldErrors['rows[' + i + '].' + keys[k]] = errs[keys[k]];
      }
      continue;
    }

    var key = normalizeSiteId(clean.site_id);
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
    var colPeriod = headers.indexOf('period');
    if (colSite === -1 || colJc === -1 || colPeriod === -1) {
      throw appError('server_error', 'sitejc_headers_missing');
    }
    var colUpdatedAt = headers.indexOf('updated_at');
    var colUpdatedBy = headers.indexOf('updated_by');

    // One read of the whole data block; every patch happens in memory.
    var data = (lastRow >= 2)
      ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
      : [];

    var index = {};
    for (var r = 0; r < data.length; r++) {
      var key = normalizeSiteId(data[r][colSite]);
      if (key) index[key] = r;
    }

    var updated = 0;
    var appends = [];

    for (var o = 0; o < order.length; o++) {
      var siteKey = order[o];
      var row = byKey[siteKey];

      if (Object.prototype.hasOwnProperty.call(index, siteKey)) {
        var at = index[siteKey];
        // Keep the stored site_id spelling; the import corrects the data, not
        // how somebody once capitalised the key.
        data[at][colJc] = row.job_code;
        data[at][colPeriod] = row.period;
        if (colUpdatedAt !== -1) data[at][colUpdatedAt] = stamp;
        if (colUpdatedBy !== -1) data[at][colUpdatedBy] = actor;
        updated++;
      } else {
        var line = [];
        for (var c = 0; c < headers.length; c++) line.push('');
        line[colSite] = row.site_id;
        line[colJc] = row.job_code;
        line[colPeriod] = row.period;
        if (colUpdatedAt !== -1) line[colUpdatedAt] = stamp;
        if (colUpdatedBy !== -1) line[colUpdatedBy] = actor;
        appends.push(line);
      }
    }

    if (updated && data.length) {
      sheet.getRange(2, 1, data.length, headers.length).setValues(data);
    }
    if (appends.length) {
      ensureRowCapacity(sheet, lastRow + appends.length);
      sheet.getRange(lastRow + 1, 1, appends.length, headers.length).setValues(appends);
    }

    invalidateSiteJc();
    return { created: appends.length, updated: updated };
  });

  return {
    imported: result.created + result.updated,
    created: result.created,
    updated: result.updated,
    duplicates_collapsed: collapsed
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
 * @param {Object} session auth context.
 * @param {Object} payload { site_id }
 * @return {Object} { deleted: true, site_id }
 */
function handleDeleteSiteJc(session, payload) {
  requireManager(session);

  var siteId = normalizeKey((payload || {}).site_id);
  if (!siteId) throw appError('validation_failed', 'invalid_site', { site_id: 'required' });

  var target = normalizeSiteId(siteId);

  var stored = withScriptLock(function () {
    var ss = openConfigSpreadsheet();
    var rows = readAllRows(ss, 'SiteJC');

    for (var i = 0; i < rows.length; i++) {
      if (normalizeSiteId(rows[i].site_id) !== target) continue;

      getSheet(ss, 'SiteJC').deleteRow(rows[i]._row);
      invalidateSiteJc();
      return normalizeKey(rows[i].site_id);
    }
    return null;
  });

  if (stored === null) throw appError('not_found', 'site_not_found');

  return { deleted: true, site_id: stored };
}

/**
 * Validate one SiteJC row.
 * @param {Object} raw { site_id, job_code, period }
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

  // Required, never inferred: `period` is what routes an entry to the old or the
  // new Tracking# (rule 14).
  var period = normalizePeriod(raw.period);
  if (!period) {
    fieldErrors.period = normalizeKey(raw.period) ? 'must_be_old_or_new' : 'required';
  }

  if (Object.keys(fieldErrors).length) {
    throw appError('validation_failed', 'invalid_site_jc', fieldErrors);
  }

  return { site_id: siteId, job_code: jobCode, period: period };
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
