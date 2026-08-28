/**
 * login.js — the sign-in screen (CLAUDE.md 3.2, 4.3).
 *
 * The password is SHA-256'd here, in the browser, before the request is built
 * (rule 7). The plain-text value exists only inside the input element and the
 * local `password` variable, and is never logged, stored, or sent.
 *
 * On success the session goes into memory only (state.js) and the hash router
 * takes over.
 */

import { api, ApiError } from '../api.js';
import { setSession, getDeviceId, getDisplayName } from '../state.js';
import { t, getLang, setLang, errorMessage } from '../i18n/i18n.js';
import { escapeHtml, qs, setMessage, setBusy } from '../utils/dom.js';
import { sha256Hex } from '../utils/hash.js';
import { toastSuccess } from '../components/toast.js';

/**
 * The sign-in screen.
 * @return {string} HTML
 */
export function renderLogin() {
  const lang = getLang();

  return `
    <div class="screen-centered">
      <form class="auth-card" id="login-form" novalidate autocomplete="on">

        <div class="auth-head">
          <div class="brand-mark">${escapeHtml(t('brand_mark'))}</div>
          <div class="auth-title">${escapeHtml(t('login_title'))}</div>
          <div class="auth-subtitle">${escapeHtml(t('login_subtitle'))}</div>
        </div>

        <div class="stack">
          <div class="field">
            <label class="label" for="login-username">${escapeHtml(t('login_username'))}</label>
            <input class="input" id="login-username" name="username" type="text"
                   autocomplete="username" autocapitalize="none" spellcheck="false"
                   placeholder="${escapeHtml(t('login_username_placeholder'))}">
          </div>

          <div class="field">
            <label class="label" for="login-password">${escapeHtml(t('login_password'))}</label>
            <input class="input" id="login-password" name="password" type="password"
                   autocomplete="current-password">
          </div>

          <div class="alert alert-danger hidden" id="login-error" role="alert"></div>

          <button class="btn btn-primary btn-block btn-lg" id="login-submit" type="submit">
            ${escapeHtml(t('login_submit'))}
          </button>
        </div>
      </form>

      <div class="row-tight">
        <div class="lang-toggle" id="login-lang">
          <button type="button" data-lang="en" aria-pressed="${lang === 'en'}">${escapeHtml(t('lang_en'))}</button>
          <button type="button" data-lang="ar" aria-pressed="${lang === 'ar'}">${escapeHtml(t('lang_ar'))}</button>
        </div>
        <button class="btn btn-ghost btn-sm" id="login-change-url" type="button">
          ${escapeHtml(t('setup_change_url'))}
        </button>
      </div>
    </div>
  `;
}

/**
 * Wire the screen.
 *
 * @param {Object} [handlers]
 * @param {Function} [handlers.onSuccess] called with the login response once
 *   the session is in memory. Defaults to routing by must_change_password.
 * @param {Function} [handlers.onChangeUrl] called when the user asks to point
 *   this device at a different Web App URL.
 */
export function bindLoginEvents(handlers = {}) {
  const form = qs('#login-form');
  if (!form) return;

  const usernameEl = qs('#login-username');
  const passwordEl = qs('#login-password');
  const errorEl = qs('#login-error');
  const submitEl = qs('#login-submit');

  if (usernameEl) usernameEl.focus();

  // Language toggle — re-render happens in the router, which listens for the
  // language-change event.
  const langToggle = qs('#login-lang');
  if (langToggle) {
    langToggle.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-lang]');
      if (button) setLang(button.dataset.lang);
    });
  }

  const changeUrlEl = qs('#login-change-url');
  if (changeUrlEl && typeof handlers.onChangeUrl === 'function') {
    changeUrlEl.addEventListener('click', handlers.onChangeUrl);
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();

    const username = (usernameEl ? usernameEl.value : '').trim();
    const password = passwordEl ? passwordEl.value : '';

    setMessage(errorEl, '');

    if (!username) {
      setMessage(errorEl, t('login_username_required'));
      if (usernameEl) usernameEl.focus();
      return;
    }
    if (!password) {
      setMessage(errorEl, t('login_password_required'));
      if (passwordEl) passwordEl.focus();
      return;
    }

    setBusy(submitEl, true, t('login_submit'), t('login_working'));

    try {
      const passwordHash = await sha256Hex(password);

      const result = await api.call('login', {
        username: username,
        password_hash: passwordHash,
        device_id: getDeviceId()
      });

      // Memory only — a refresh returns to this screen by design (4.2). The
      // forced-reset flag rides along so the router can gate on it (4.3).
      setSession(result.token, result.user, result.must_change_password);

      if (passwordEl) passwordEl.value = '';

      // The toast lives outside #app, so it survives the screen swap below.
      toastSuccess(t('login_welcome_back', { name: getDisplayName(getLang()) }));

      if (typeof handlers.onSuccess === 'function') {
        handlers.onSuccess(result);
      } else {
        defaultOnSuccess(result);
      }

    } catch (err) {
      setBusy(submitEl, false, t('login_submit'), t('login_working'));

      // WebCrypto missing (file:// or plain http) — never a credentials problem.
      if (err && err.code === 'insecure_context') {
        setMessage(errorEl, t('err_msg_insecure_context'));
        return;
      }

      setMessage(errorEl, errorMessage(err instanceof ApiError ? err : { code: 'unknown' }));

      if (passwordEl) {
        passwordEl.value = '';
        passwordEl.focus();
      }
    }
  });
}

/**
 * Where a successful login goes when the caller supplies no handler: the
 * change-password screen when the account is flagged, otherwise the role
 * dashboard (3.2, 4.3). The router passes its own navigate()-based handler.
 * @param {Object} result the login response.
 */
function defaultOnSuccess(result) {
  window.location.hash = result && result.must_change_password
    ? '#/change-password'
    : '#/dashboard';
}
