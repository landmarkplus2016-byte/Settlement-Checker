/**
 * Auth.gs — login, logout, and the session check that guards every other action
 * (CLAUDE.md 3.2, 3.8, 4).
 *
 * Passwords never reach this file in plain text. The browser SHA-256s them
 * (js/utils/hash.js) and sends hex; all this file does is compare two strings
 * (rule 7). If a payload arrives with something that is not a 64-char hex
 * digest, it is rejected rather than hashed here — hashing server-side would
 * mean a plain-text password had already travelled.
 */

/** A SHA-256 digest as lowercase hex. */
var SHA256_HEX = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ *
 * Session validation
 * ------------------------------------------------------------------ */

/**
 * Validate a token and build the auth context every handler receives.
 * Runs at the top of every action except ping, get_config and login (3.8).
 *
 * The returned context carries the session row and the user row together, so
 * both `session.role` and `session.user.role` read correctly. `role` is taken
 * from the *Users* row, not the cached copy on the Sessions row, so a role
 * changed after login takes effect on the next call rather than at next login.
 *
 * Note what `user` does NOT contain: `coordinator_sheet_id` or `password_hash`.
 * The sheet id is re-read inside Registry.resolveCoordinatorSheet() at the
 * moment it is needed, and exists nowhere else.
 *
 * @param {string} token
 * @return {Object} { token, user_id, role, expires_at, device_id, session, user }
 * @throws {Object} appError('unauthenticated')
 */
function validateSession(token) {
  var key = normalizeKey(token);
  if (!key) throw appError('unauthenticated', 'missing_token');

  var ss = openConfigSpreadsheet();
  var row = readRowByKey(ss, 'Sessions', 'token', key);
  if (!row) throw appError('unauthenticated', 'invalid_token');

  var expiresAt = parseTimestamp(row.expires_at);
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    // Tidy up as we go; the nightly trigger is the bulk sweeper (4.5). A failure
    // to delete must not mask the real reason for rejecting the call.
    try {
      deleteRowByKey(ss, 'Sessions', 'token', key);
    } catch (err) {
      console.warn('Could not delete expired session: ' + err);
    }
    throw appError('unauthenticated', 'session_expired');
  }

  var user = findUserById(row.user_id);
  if (!user) throw appError('unauthenticated', 'user_not_found');
  if (!normalizeBoolean(user.active)) throw appError('unauthenticated', 'user_inactive');

  var role = normalizeKey(user.role);

  return {
    token: key,
    user_id: normalizeKey(user.user_id),
    role: role,
    expires_at: row.expires_at,
    device_id: normalizeKey(row.device_id),

    session: {
      token: key,
      user_id: normalizeKey(row.user_id),
      role: normalizeKey(row.role),
      created_at: row.created_at,
      expires_at: row.expires_at,
      device_id: normalizeKey(row.device_id)
    },

    user: {
      user_id: normalizeKey(user.user_id),
      username: normalizeKey(user.username),
      display_name: normalizeKey(user.display_name),
      display_name_ar: normalizeKey(user.display_name_ar),
      role: role,
      active: true,
      force_password_change: normalizeBoolean(user.force_password_change)
    }
  };
}

/* ------------------------------------------------------------------ *
 * login / logout
 * ------------------------------------------------------------------ */

/**
 * `login` — no token (3.2).
 *
 * One active session per user: creating a session deletes every existing one
 * for that user_id, so logging in on a second device signs the first out.
 *
 * @param {Object} payload { username, password_hash, device_id }
 * @return {Object} { token, user, must_change_password }
 * @throws {Object} appError('validation_failed'|'unauthenticated')
 */
function handleLogin(payload) {
  var body = payload || {};
  var username = normalizeKey(body.username);
  var passwordHash = normalizeKey(body.password_hash).toLowerCase();
  var deviceId = normalizeKey(body.device_id).substring(0, 100);

  var fieldErrors = {};
  if (!username) fieldErrors.username = 'required';
  if (!passwordHash) {
    fieldErrors.password_hash = 'required';
  } else if (!SHA256_HEX.test(passwordHash)) {
    // Guards rule 7 from the other side: a plain-text password would land here.
    fieldErrors.password_hash = 'must_be_sha256_hex';
  }
  if (Object.keys(fieldErrors).length) {
    throw appError('validation_failed', 'invalid_login_payload', fieldErrors);
  }

  var user = findUserByUsername(username);

  // Same error for unknown user, inactive user and wrong password — never tell
  // an anonymous caller which usernames exist.
  var stored = user ? normalizeKey(user.password_hash).toLowerCase() : '';
  var credentialsOk =
    !!user &&
    normalizeBoolean(user.active) &&
    stored !== '' &&
    stored === passwordHash;

  if (!credentialsOk) throw appError('unauthenticated', 'invalid_credentials');

  var userId = normalizeKey(user.user_id);
  var role = normalizeKey(user.role);
  var expiryHours = getSessionExpiryHours();

  var token = withScriptLock(function () {
    var ss = openConfigSpreadsheet();

    deleteSessionsForUser(ss, userId);

    var now = new Date();
    var newToken = generateUuid();

    appendRow(ss, 'Sessions', {
      token: newToken,
      user_id: userId,
      role: role,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + expiryHours * 3600000).toISOString(),
      device_id: deviceId
    });

    updateRowByKey(ss, 'Users', 'user_id', userId, { last_login_at: now.toISOString() });
    invalidateUsersRegistry();

    return newToken;
  });

  return {
    token: token,
    user: toPublicUser(user),
    must_change_password: normalizeBoolean(user.force_password_change)
  };
}

/**
 * `logout` — deletes the caller's session row.
 * @param {Object} session auth context from validateSession().
 * @return {Object}
 */
function handleLogout(session) {
  deleteRowByKey(openConfigSpreadsheet(), 'Sessions', 'token', session.token);
  return { logged_out: true };
}

/* ------------------------------------------------------------------ *
 * Sessions housekeeping
 * ------------------------------------------------------------------ */

/**
 * Delete every session belonging to one user. Rows are removed bottom-up so
 * earlier deletions do not shift the indices of later ones.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss the config spreadsheet.
 * @param {string} userId
 * @return {number} rows deleted.
 */
function deleteSessionsForUser(ss, userId) {
  var target = normalizeKey(userId);
  var rows = readAllRows(ss, 'Sessions');
  var doomed = [];

  for (var i = 0; i < rows.length; i++) {
    if (normalizeKey(rows[i].user_id) === target) doomed.push(rows[i]._row);
  }

  doomed.sort(function (a, b) { return b - a; });

  var sheet = getSheet(ss, 'Sessions');
  for (var d = 0; d < doomed.length; d++) sheet.deleteRow(doomed[d]);

  return doomed.length;
}

/**
 * Nightly cleanup (CLAUDE.md 4.5). Attach a time-driven trigger to this
 * function in the Apps Script editor: Triggers -> Add trigger ->
 * cleanupExpiredSessions, time-driven, day timer.
 *
 * Deletes sessions whose expires_at is blank or in the past. A row whose
 * expires_at cannot be parsed is left alone rather than guessed at — a broken
 * timestamp is a bug to look at, not a licence to delete live sessions.
 *
 * @return {number} rows deleted.
 */
function cleanupExpiredSessions() {
  return withScriptLock(function () {
    var ss = openConfigSpreadsheet();
    var rows = readAllRows(ss, 'Sessions');
    var now = Date.now();
    var doomed = [];

    for (var i = 0; i < rows.length; i++) {
      var raw = rows[i].expires_at;
      if (raw === '' || raw === null || raw === undefined) {
        doomed.push(rows[i]._row);
        continue;
      }
      var expiresAt = parseTimestamp(raw);
      if (expiresAt && expiresAt.getTime() <= now) doomed.push(rows[i]._row);
    }

    doomed.sort(function (a, b) { return b - a; });

    var sheet = getSheet(ss, 'Sessions');
    for (var d = 0; d < doomed.length; d++) sheet.deleteRow(doomed[d]);

    console.log('cleanupExpiredSessions removed ' + doomed.length + ' row(s)');
    return doomed.length;
  });
}
