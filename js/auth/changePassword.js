/**
 * changePassword.js — setting your own password (CLAUDE.md 4.3).
 *
 * Reached two ways:
 *   - FORCED. The account's `force_password_change` is set, so login sends the
 *     user here and the router refuses every other route until it is cleared.
 *     "before anything else" in 4.3 is enforced in router.js, not here.
 *   - VOLUNTARY. The user chose to change a password that was working fine.
 *
 * The screen is the same either way; only the wording and the escape hatch
 * differ. A forced user is never trapped — they can always sign out.
 *
 * As with login, the password is SHA-256'd in the browser before the request is
 * built (rule 7). Neither field's plain-text value leaves this module, and both
 * are wiped from the DOM the moment the call succeeds.
 */

import { api, ApiError } from '../api.js';
import { mustChangePassword, clearMustChangePassword } from '../state.js';
import { t, getLang, setLang, errorMessage } from '../i18n/i18n.js';
import { escapeHtml, qs, setMessage, setBusy } from '../utils/dom.js';
import { sha256Hex } from '../utils/hash.js';
import { logout } from './session.js';
import { toastSuccess } from '../components/toast.js';
import { renderBrandMark } from '../components/brandMark.js';

/**
 * The shortest password we will send. Length is the only strength rule we can
 * apply, and it has to be applied here: the server receives a 64-character
 * digest and cannot tell a 4-character password from a 40-character one.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * The change-password screen.
 * @return {string} HTML
 */
export function renderChangePassword() {
  const lang = getLang();
  const forced = mustChangePassword();

  return `
    <div class="screen-centered">
      <form class="auth-card" id="change-password-form" novalidate>

        <div class="auth-head">
          ${renderBrandMark()}
          <div class="auth-title">${escapeHtml(t('change_password_title'))}</div>
          <div class="auth-subtitle">
            ${escapeHtml(forced ? t('change_password_forced_subtitle') : t('change_password_subtitle'))}
          </div>
        </div>

        ${forced ? `<div class="alert alert-warning" role="status">${escapeHtml(t('change_password_forced_notice'))}</div>` : ''}

        <div class="stack">
          <div class="field">
            <label class="label" for="new-password">${escapeHtml(t('change_password_new'))}</label>
            <input class="input" id="new-password" name="new_password" type="password"
                   autocomplete="new-password">
            <span class="field-hint">${escapeHtml(t('change_password_hint', { min: MIN_PASSWORD_LENGTH }))}</span>
          </div>

          <div class="field">
            <label class="label" for="confirm-password">${escapeHtml(t('change_password_confirm'))}</label>
            <input class="input" id="confirm-password" name="confirm_password" type="password"
                   autocomplete="new-password">
          </div>

          <div class="alert alert-danger hidden" id="change-password-error" role="alert"></div>

          <button class="btn btn-primary btn-block btn-lg" id="change-password-submit" type="submit">
            ${escapeHtml(t('change_password_submit'))}
          </button>

          <button class="btn btn-ghost btn-block btn-sm" id="change-password-signout" type="button">
            ${escapeHtml(t('sign_out'))}
          </button>
        </div>
      </form>

      <div class="lang-toggle" id="change-password-lang">
        <button type="button" data-lang="en" aria-pressed="${lang === 'en'}">${escapeHtml(t('lang_en'))}</button>
        <button type="button" data-lang="ar" aria-pressed="${lang === 'ar'}">${escapeHtml(t('lang_ar'))}</button>
      </div>
    </div>
  `;
}

/**
 * Wire the screen.
 *
 * @param {Object} [handlers]
 * @param {Function} [handlers.onSuccess] called once the server has stored the
 *   new password and the flag is cleared. Defaults to going to the dashboard.
 */
export function bindChangePasswordEvents(handlers = {}) {
  const form = qs('#change-password-form');
  if (!form) return;

  const newEl = qs('#new-password');
  const confirmEl = qs('#confirm-password');
  const errorEl = qs('#change-password-error');
  const submitEl = qs('#change-password-submit');

  if (newEl) newEl.focus();

  const langToggle = qs('#change-password-lang');
  if (langToggle) {
    langToggle.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-lang]');
      if (button) setLang(button.dataset.lang);
    });
  }

  // A forced user must never be stuck on this screen with no way out.
  const signOutEl = qs('#change-password-signout');
  if (signOutEl) {
    signOutEl.addEventListener('click', function () { logout(); });
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();

    const password = newEl ? newEl.value : '';
    const confirmation = confirmEl ? confirmEl.value : '';

    setMessage(errorEl, '');

    if (!password) {
      setMessage(errorEl, t('change_password_required'));
      if (newEl) newEl.focus();
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setMessage(errorEl, t('change_password_too_short', { min: MIN_PASSWORD_LENGTH }));
      if (newEl) newEl.focus();
      return;
    }
    if (password !== confirmation) {
      setMessage(errorEl, t('change_password_mismatch'));
      if (confirmEl) {
        confirmEl.value = '';
        confirmEl.focus();
      }
      return;
    }

    setBusy(submitEl, true, t('change_password_submit'), t('change_password_working'));

    try {
      const passwordHash = await sha256Hex(password);

      /*
       * No user_id in the payload. An absent one means "me" to the server
       * (Admin.gs), so this request cannot even express targeting somebody
       * else — the same posture as the coordinator actions in 3.8.
       */
      await api.call('reset_user_password', { password_hash: passwordHash });

      // Only after the server has confirmed the write (rule 8: the flag lives
      // on the Users row; this just mirrors it).
      clearMustChangePassword();

      if (newEl) newEl.value = '';
      if (confirmEl) confirmEl.value = '';

      toastSuccess(t('change_password_success'));

      if (typeof handlers.onSuccess === 'function') {
        handlers.onSuccess();
      } else {
        window.location.hash = '#/dashboard';
      }

    } catch (err) {
      setBusy(submitEl, false, t('change_password_submit'), t('change_password_working'));

      if (err && err.code === 'insecure_context') {
        setMessage(errorEl, t('err_msg_insecure_context'));
        return;
      }

      setMessage(errorEl, errorMessage(err instanceof ApiError ? err : { code: 'unknown' }));

      if (confirmEl) confirmEl.value = '';
      if (newEl) newEl.focus();
    }
  });
}
