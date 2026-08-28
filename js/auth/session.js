/**
 * session.js — signing out, and what to do when the server says the session is
 * gone (CLAUDE.md 4.1, 4.4).
 *
 * The token is memory-only, so "ending a session" is two things: telling the
 * server to drop its Sessions row, and clearing memory. Grid drafts in
 * localStorage are never touched — a coordinator's unsaved typing must outlive
 * a sign-out (6.5).
 */

import { api } from '../api.js';
import { clearSession, isAuthenticated } from '../state.js';

/**
 * Sign out. The server call is best-effort: if it fails, the local session is
 * still cleared, because leaving a signed-out user holding a token would be
 * worse than an orphaned Sessions row (the nightly sweep removes it anyway).
 *
 * @return {Promise<void>}
 */
export async function logout() {
  if (isAuthenticated()) {
    try {
      await api.call('logout');
    } catch (err) {
      console.warn('logout call failed; clearing the local session anyway.');
    }
  }

  clearSession();
  window.location.hash = '#/login';
}

/**
 * Drop the local session after the server has rejected the token, and send the
 * user back to login without a server round trip.
 */
export function endSessionLocally() {
  clearSession();
  window.location.hash = '#/login';
}

/**
 * Did this error mean "your session is over"?
 * @param {{code?: string}} err
 * @return {boolean}
 */
export function isSessionError(err) {
  return !!err && err.code === 'unauthenticated';
}
