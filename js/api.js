/**
 * api.js — the ONLY file in the app that talks to Apps Script (CLAUDE.md 3.1,
 * rules 1 and 19). Every screen calls api.call('action', payload); nothing else
 * ever touches fetch(), and nothing anywhere touches Google Sheets directly.
 *
 * Two rules are enforced structurally here:
 *   - The Web App URL is never in code (rule 2). It lives in
 *     localStorage.sc_script_url, set once per device on first launch.
 *   - Nothing is cached (3.1). Every call is a fresh round trip; the Sheets are
 *     the single source of truth and a stale read is a wrong number.
 */

import { getToken } from './state.js';

/** localStorage key holding this device's Web App URL (9.2). */
const SCRIPT_URL_KEY = 'sc_script_url';

/** The three actions the server accepts without a token (Main.gs ACTIONS). */
const PUBLIC_ACTIONS = ['ping', 'get_config', 'login'];

/**
 * A failed call, carrying the server's envelope.
 *
 * `code` is one of the fixed codes in CLAUDE.md 3.1 (`validation_failed`,
 * `unauthenticated`, `forbidden`, `not_found`, `conflict`, `server_error`) plus
 * two the client raises on its own: `network_error` and `script_url_missing`.
 *
 * `serverMessage` is the finer-grained snake_case reason ('invalid_credentials'),
 * which screens map to a specific string via t('err_msg_' + serverMessage).
 */
export class ApiError extends Error {
  /**
   * @param {string} code
   * @param {string} [message] the server's `message`.
   * @param {Object} [fieldErrors] the server's `field_errors`.
   */
  constructor(code, message, fieldErrors) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.serverMessage = message || code;
    this.fieldErrors = fieldErrors || null;
  }
}

/* ------------------------------------------------------------------ *
 * The Web App URL — per device, never committed
 * ------------------------------------------------------------------ */

/**
 * @return {string} the stored Web App URL, or '' when this device is not set up.
 */
export function getScriptUrl() {
  try {
    return window.localStorage.getItem(SCRIPT_URL_KEY) || '';
  } catch (err) {
    return '';
  }
}

/** @return {boolean} */
export function hasScriptUrl() {
  return getScriptUrl() !== '';
}

/**
 * Does this look like an Apps Script Web App URL? Deliberately shape-only — the
 * real check is whether get_config answers (js/main.js does that next).
 *
 * @param {string} url
 * @return {boolean}
 */
export function isValidScriptUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return false;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  return /(^|\.)google(usercontent)?\.com$/.test(parsed.hostname);
}

/**
 * Store this device's Web App URL.
 * @param {string} url
 * @return {string} the trimmed URL that was stored.
 * @throws {ApiError} validation_failed when the URL is not usable.
 */
export function setScriptUrl(url) {
  const trimmed = String(url || '').trim();
  if (!isValidScriptUrl(trimmed)) {
    throw new ApiError('validation_failed', 'invalid_script_url');
  }

  try {
    window.localStorage.setItem(SCRIPT_URL_KEY, trimmed);
  } catch (err) {
    throw new ApiError('server_error', 'local_storage_unavailable');
  }

  return trimmed;
}

/** Forget this device's Web App URL — the "Change server URL" action. */
export function clearScriptUrl() {
  try {
    window.localStorage.removeItem(SCRIPT_URL_KEY);
  } catch (err) {
    console.warn('Could not clear the script URL.');
  }
}

/* ------------------------------------------------------------------ *
 * The call
 * ------------------------------------------------------------------ */

/**
 * Post one action to the Web App and unwrap the envelope.
 *
 * The body goes as `text/plain` on purpose: Apps Script Web Apps do not answer
 * a CORS preflight, and text/plain is a "simple request" that never triggers
 * one. Main.gs ignores the content type and parses the body as JSON.
 *
 * @param {string} action snake_case action name (CLAUDE.md 3.2–3.7).
 * @param {Object} [payload]
 * @return {Promise<*>} the envelope's `data`.
 * @throws {ApiError}
 */
async function call(action, payload) {
  const url = getScriptUrl();
  if (!url) throw new ApiError('script_url_missing', 'script_url_missing');

  const body = { action: action, payload: payload || {} };

  // The token is injected here and nowhere else. Public actions must not carry
  // one; everything else must (3.8).
  if (PUBLIC_ACTIONS.indexOf(action) === -1) {
    const token = getToken();
    if (!token) throw new ApiError('unauthenticated', 'missing_token');
    body.token = token;
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
      redirect: 'follow',       // Apps Script answers through a 302 to googleusercontent
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    // Offline, DNS, blocked, CORS — indistinguishable from here, and the user's
    // next step is the same for all of them.
    throw new ApiError('network_error', 'network_error');
  }

  if (!response.ok) {
    throw new ApiError('server_error', 'http_' + response.status);
  }

  const text = await response.text();

  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (err) {
    // Almost always the Google sign-in page: the deployment's access is not set
    // to "Anyone".
    throw new ApiError('server_error', 'malformed_response');
  }

  if (!envelope || typeof envelope !== 'object') {
    throw new ApiError('server_error', 'malformed_response');
  }

  if (envelope.ok === true) return envelope.data;

  throw new ApiError(
    envelope.error || 'server_error',
    envelope.message || envelope.error || 'server_error',
    envelope.field_errors || null
  );
}

/** The API surface every screen imports. */
export const api = {
  call: call,
  getScriptUrl: getScriptUrl,
  hasScriptUrl: hasScriptUrl,
  setScriptUrl: setScriptUrl,
  clearScriptUrl: clearScriptUrl,
  isValidScriptUrl: isValidScriptUrl
};

export default api;
