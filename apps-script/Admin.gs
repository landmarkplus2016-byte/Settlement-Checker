/**
 * Admin.gs — the manager-only administration actions (CLAUDE.md 3.4).
 *
 * STAGE 3.2 brings forward exactly ONE of them: reset_user_password. The change-
 * password screen (js/auth/changePassword.js) cannot work without it — clearing
 * `force_password_change` is a write to the Users tab, and only the server may
 * make it (rule 8). The remaining ten actions in 3.4 (list_users, create_user,
 * update_user, deactivate_user, teams, site_jc, lists) belong to Stage 5.1 and
 * are not here yet.
 *
 * reset_user_password has two callers with different rights, and the split is
 * the whole point of this file:
 *
 *   - A user changing their OWN password. Any role. This is the forced-reset
 *     path from 4.3, and it CLEARS force_password_change.
 *   - A manager resetting SOMEONE ELSE'S password (Stage 5.2's People screen).
 *     Manager-only (rule 5), and it SETS force_password_change so the owner must
 *     pick their own on next login.
 *
 * In both cases the password arrives already SHA-256'd by the browser (rule 7).
 * Nothing here ever sees, hashes, or logs a plain-text password.
 */

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
