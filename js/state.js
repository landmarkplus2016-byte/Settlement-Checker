/**
 * state.js — the app's only mutable state (CLAUDE.md 4.2, 6.5).
 *
 * Three things live here, and the line between them matters:
 *
 *   1. The session {token, user} — MEMORY ONLY. Never localStorage, never
 *      sessionStorage, never a cookie. A refresh loses it and returns the user
 *      to login. That is the intended behaviour (rule: "Never store the session
 *      token in localStorage").
 *   2. The public config from get_config — memory only, re-fetched each boot.
 *   3. Persisted, non-secret preferences and the coordinator's grid drafts —
 *      localStorage, always under an `sc_` prefix (9.2).
 */

/* ------------------------------------------------------------------ *
 * localStorage keys — every one starts `sc_`
 * ------------------------------------------------------------------ */

const LANG_KEY = 'sc_lang';
const DEVICE_ID_KEY = 'sc_device_id';
const DRAFT_PREFIX = 'sc_draft_';

/* ------------------------------------------------------------------ *
 * In-memory state
 * ------------------------------------------------------------------ */

/** @type {{token: string, user: Object, must_change_password: boolean}|null} */
let session = null;

/** @type {Object|null} the four public keys from get_config. */
let config = null;

/* ------------------------------------------------------------------ *
 * localStorage, defensively
 * ------------------------------------------------------------------ */

/**
 * Read one key. Private browsing and disabled storage throw on access rather
 * than returning null, so every touch is wrapped.
 * @param {string} key
 * @return {string|null}
 */
function readLocal(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (err) {
    console.warn('localStorage unavailable for read: ' + key);
    return null;
  }
}

/**
 * Write one key.
 * @param {string} key
 * @param {string} value
 * @return {boolean} false when storage refused the write.
 */
function writeLocal(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (err) {
    console.warn('localStorage unavailable for write: ' + key);
    return false;
  }
}

/**
 * Remove one key.
 * @param {string} key
 */
function removeLocal(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (err) {
    console.warn('localStorage unavailable for remove: ' + key);
  }
}

/* ------------------------------------------------------------------ *
 * Session — memory only
 * ------------------------------------------------------------------ */

/**
 * Store the session returned by `login`.
 * @param {string} token
 * @param {Object} user { user_id, display_name, display_name_ar, role }
 * @param {boolean} [mustChangePassword=false] the account's
 *   `force_password_change` flag; the router gates every route on it (4.3).
 * @return {Object} the stored session.
 */
export function setSession(token, user, mustChangePassword) {
  session = {
    token: token,
    user: user || {},
    must_change_password: !!mustChangePassword
  };
  return session;
}

/** @return {{token: string, user: Object}|null} */
export function getSession() {
  return session;
}

/** @return {string} the session token, or '' when signed out. */
export function getToken() {
  return session ? session.token : '';
}

/** @return {Object|null} the signed-in user, without any sheet id (rule 3). */
export function getUser() {
  return session ? session.user : null;
}

/** @return {string} 'coordinator' | 'manager' | '' */
export function getRole() {
  return (session && session.user && session.user.role) ? session.user.role : '';
}

/** @return {boolean} */
export function isAuthenticated() {
  return !!(session && session.token);
}

/** @return {boolean} */
export function isManager() {
  return getRole() === 'manager';
}

/** @return {boolean} */
export function isCoordinator() {
  return getRole() === 'coordinator';
}

/**
 * Does this account have to set a new password before it can go anywhere else
 * (4.3)? Memory-only like the rest of the session, so it is re-learnt from the
 * next `login` response after a refresh.
 * @return {boolean}
 */
export function mustChangePassword() {
  return !!(session && session.must_change_password);
}

/**
 * Drop the flag once the server has confirmed the new password. Only
 * changePassword.js calls this, and only after a successful
 * `reset_user_password` — never to let a user past the gate.
 */
export function clearMustChangePassword() {
  if (session) session.must_change_password = false;
}

/**
 * Sign out in memory. Drafts are deliberately left alone — a coordinator's
 * unsaved typing must survive a sign-out and a refresh (4.4).
 *
 * Note what is NOT here: no localStorage.clear(), and no removal of any
 * `sc_draft_*` key. That absence is the whole of the guarantee in 4.4.
 */
export function clearSession() {
  session = null;
}

/**
 * The display name for the active language: the Arabic name in AR when there is
 * one, the English name otherwise.
 * @param {string} lang 'en' | 'ar'
 * @return {string}
 */
export function getDisplayName(lang) {
  const user = getUser();
  if (!user) return '';
  if (lang === 'ar' && user.display_name_ar) return user.display_name_ar;
  return user.display_name || user.username || user.user_id || '';
}

/* ------------------------------------------------------------------ *
 * Public config — memory only, re-fetched every boot
 * ------------------------------------------------------------------ */

/**
 * @param {Object} value the get_config response.
 * @return {Object}
 */
export function setConfig(value) {
  config = value || null;
  return config;
}

/** @return {Object|null} */
export function getConfig() {
  return config;
}

/**
 * One config value with a fallback.
 * @param {string} key
 * @param {*} [fallback]
 * @return {*}
 */
export function getConfigValue(key, fallback) {
  if (config && config[key] !== undefined && config[key] !== null && config[key] !== '') {
    return config[key];
  }
  return fallback;
}

/* ------------------------------------------------------------------ *
 * Language — persisted, not secret
 * ------------------------------------------------------------------ */

/**
 * The user's language. An explicit choice wins; otherwise the server's
 * `primary_language`; otherwise English.
 * @return {string} 'en' | 'ar'
 */
export function getLang() {
  const chosen = readLocal(LANG_KEY);
  if (chosen === 'en' || chosen === 'ar') return chosen;

  const fromConfig = getConfigValue('primary_language', 'en');
  return fromConfig === 'ar' ? 'ar' : 'en';
}

/**
 * Persist an explicit language choice. i18n.setLang() calls this; call that,
 * not this, so <html dir> is applied too.
 * @param {string} lang
 */
export function setLang(lang) {
  writeLocal(LANG_KEY, lang === 'ar' ? 'ar' : 'en');
}

/** @return {boolean} true once the user has picked a language themselves. */
export function hasExplicitLang() {
  const chosen = readLocal(LANG_KEY);
  return chosen === 'en' || chosen === 'ar';
}

/* ------------------------------------------------------------------ *
 * Device id — informational, sent with login
 * ------------------------------------------------------------------ */

/**
 * A stable, meaningless id for this browser, stored so the Sessions tab can
 * show which device a session came from. Not a credential.
 * @return {string}
 */
export function getDeviceId() {
  let id = readLocal(DEVICE_ID_KEY);
  if (id) return id;

  id = (window.crypto && window.crypto.randomUUID)
    ? window.crypto.randomUUID()
    : 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

  writeLocal(DEVICE_ID_KEY, id);
  return id;
}

/* ------------------------------------------------------------------ *
 * Grid drafts — the one local-first surface (CLAUDE.md 6.5)
 * ------------------------------------------------------------------ */

/**
 * The localStorage key for one grid: `sc_draft_<settlement_id>_<kind>` (9.2).
 * @param {string} settlementId e.g. 'S-2026-08'
 * @param {string} kind 'expense' | 'fuel'
 * @return {string}
 */
export function draftKey(settlementId, kind) {
  return DRAFT_PREFIX + settlementId + '_' + kind;
}

/**
 * Mirror the in-memory grid rows to localStorage. Called on every cell change,
 * so it must stay cheap and must never throw into the edit path.
 *
 * @param {string} settlementId
 * @param {string} kind 'expense' | 'fuel'
 * @param {Array<Object>} rows
 * @return {string} the `saved_at` stamp that was written, or '' when the write
 *   was refused (quota, private mode). Truthy on success either way, and the
 *   stamp lets a caller recognise the record as its own afterwards.
 */
export function saveDraft(settlementId, kind, rows) {
  const record = {
    settlement_id: settlementId,
    kind: kind,
    saved_at: new Date().toISOString(),
    rows: rows || []
  };

  try {
    return writeLocal(draftKey(settlementId, kind), JSON.stringify(record))
      ? record.saved_at
      : '';
  } catch (err) {
    console.warn('Could not serialise draft: ' + err);
    return '';
  }
}

/**
 * Read a mirrored draft back.
 * @param {string} settlementId
 * @param {string} kind
 * @return {{settlement_id: string, kind: string, saved_at: string, rows: Array}|null}
 */
export function getDraft(settlementId, kind) {
  const raw = readLocal(draftKey(settlementId, kind));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rows)) return null;
    return parsed;
  } catch (err) {
    // A corrupt draft is worse than none — drop it rather than crash the grid.
    console.warn('Discarding unreadable draft: ' + draftKey(settlementId, kind));
    removeLocal(draftKey(settlementId, kind));
    return null;
  }
}

/**
 * Drop one draft. Called after a successful save/confirm, once the server holds
 * the rows.
 * @param {string} settlementId
 * @param {string} kind
 */
export function clearDraft(settlementId, kind) {
  removeLocal(draftKey(settlementId, kind));
}

/**
 * Every draft key currently in localStorage.
 * @return {Array<string>}
 */
export function listDraftKeys() {
  const keys = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.indexOf(DRAFT_PREFIX) === 0) keys.push(key);
    }
  } catch (err) {
    console.warn('localStorage unavailable for draft listing');
  }
  return keys;
}
