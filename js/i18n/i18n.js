/**
 * i18n.js — t() and setLang() (CLAUDE.md 8.1, 8.2).
 *
 * The chosen language lives in state.js (localStorage `sc_lang`); this file
 * owns the dictionaries, the lookup, and applying `dir`/`lang` to <html>.
 *
 * Import direction is one-way — i18n imports state, never the other way round.
 */

import { en } from './en.js';
import { ar } from './ar.js';
import { getLang as readLang, setLang as storeLang } from '../state.js';

/** The two dictionaries, keyed by language code. */
const DICTS = { en, ar };

export const SUPPORTED_LANGS = ['en', 'ar'];
export const DEFAULT_LANG = 'en';

/** Fired on <window> after setLang(); screens re-render on it. */
export const LANG_CHANGE_EVENT = 'sc:langchange';

/**
 * The active language code.
 * @return {string} 'en' | 'ar'
 */
export function getLang() {
  const lang = readLang();
  return SUPPORTED_LANGS.includes(lang) ? lang : DEFAULT_LANG;
}

/** @return {boolean} true when the document should read right-to-left. */
export function isRtl() {
  return getLang() === 'ar';
}

/**
 * Translate one key.
 *
 * A key missing from the active dictionary falls back to English, then to the
 * key itself — a visibly wrong string is easier to spot and fix than an empty
 * one. `{name}` placeholders are filled from `vars`.
 *
 * @param {string} key snake_case key present in en.js and ar.js.
 * @param {Object} [vars] values for {placeholders}.
 * @return {string}
 */
export function t(key, vars) {
  const dict = DICTS[getLang()] || en;
  let str = dict[key];

  if (str === undefined) str = en[key];
  if (str === undefined) return key;

  if (!vars) return str;

  return String(str).replace(/\{(\w+)\}/g, function (match, name) {
    const value = vars[name];
    return (value === undefined || value === null) ? match : String(value);
  });
}

/**
 * Switch language and flip the document.
 *
 * Sets <html lang> and <html dir> — the single switch behind every logical CSS
 * property in the stylesheets (rule 24).
 *
 * @param {string} lang 'en' | 'ar'; anything else falls back to English.
 * @param {boolean} [persist=true] false while booting, when we are only
 *   applying the server's `primary_language` default and must not overwrite a
 *   choice the user has not made yet.
 * @return {string} the language actually applied.
 */
export function setLang(lang, persist = true) {
  const next = SUPPORTED_LANGS.includes(lang) ? lang : DEFAULT_LANG;

  if (persist) storeLang(next);

  const html = document.documentElement;
  html.setAttribute('lang', next);
  html.setAttribute('dir', next === 'ar' ? 'rtl' : 'ltr');

  window.dispatchEvent(new CustomEvent(LANG_CHANGE_EVENT, { detail: { lang: next } }));

  return next;
}

/**
 * The sentence to show a user for a failed api.call().
 *
 * Two levels, most specific first: the server's snake_case `message`
 * ('invalid_credentials') via `err_msg_*`, then the envelope's fixed error code
 * ('unauthenticated') via `err_*`. An error with neither is a client bug and
 * shows the generic line rather than a stack trace.
 *
 * Duck-typed on `code`/`serverMessage` so this file never has to import
 * api.js — that would be a cycle.
 *
 * @param {{code?: string, serverMessage?: string}} err
 * @return {string} a translated sentence.
 */
export function errorMessage(err) {
  const dict = DICTS[getLang()] || en;

  const specific = err && err.serverMessage ? 'err_msg_' + err.serverMessage : '';
  if (specific && (dict[specific] !== undefined || en[specific] !== undefined)) {
    return t(specific);
  }

  const byCode = err && err.code ? 'err_' + err.code : '';
  if (byCode && (dict[byCode] !== undefined || en[byCode] !== undefined)) {
    return t(byCode);
  }

  return t('err_unknown');
}
