/**
 * topbar.js — the coordinator shell's chrome (CLAUDE.md 5.1).
 *
 * "A slim top bar + a content area." White surface, navy brand, no sidebar —
 * the coordinator has two screens (Dashboard and a Settlement), so a full nav
 * rail would be furniture. The boldness is spent on the grid instead (8.3).
 *
 * Renders only; the router owns what goes underneath it.
 */

import { getUser, getDisplayName } from '../state.js';
import { t, getLang, setLang } from '../i18n/i18n.js';
import { escapeHtml, qs } from '../utils/dom.js';
import { logout } from '../auth/session.js';

/**
 * The coordinator top bar.
 *
 * @param {string} [activeHash] the current route, so the Dashboard link can
 *   show as active.
 * @return {string} HTML
 */
export function renderTopbar(activeHash) {
  const lang = getLang();
  const name = getDisplayName(lang);
  const user = getUser() || {};
  const onDashboard = !activeHash || activeHash.indexOf('#/dashboard') === 0;

  return `
    <header class="topbar">
      <div class="brand-mark">${escapeHtml(t('brand_mark'))}</div>
      <div class="brand">
        <div class="brand-name">${escapeHtml(t('brand_name'))}</div>
        <div class="brand-tagline">${escapeHtml(t('brand_tagline'))}</div>
      </div>

      <nav class="topbar-nav">
        <a class="topbar-link${onDashboard ? ' is-active' : ''}" href="#/dashboard">
          <span class="nav-icon" aria-hidden="true">▦</span>${escapeHtml(t('nav_dashboard'))}
        </a>
      </nav>

      <div class="spacer"></div>

      <div class="lang-toggle" id="topbar-lang">
        <button type="button" data-lang="en" aria-pressed="${lang === 'en'}">${escapeHtml(t('lang_en'))}</button>
        <button type="button" data-lang="ar" aria-pressed="${lang === 'ar'}">${escapeHtml(t('lang_ar'))}</button>
      </div>

      <div class="topbar-user">
        <span class="text-small text-bold">${escapeHtml(name)}</span>
        <span class="text-tiny text-muted">${escapeHtml(roleLabel(user.role))}</span>
      </div>
      <div class="avatar" aria-hidden="true">${escapeHtml(initial(name))}</div>

      <button class="btn btn-secondary btn-sm" id="topbar-logout" type="button">
        ${escapeHtml(t('sign_out'))}
      </button>
    </header>
  `;
}

/**
 * Wire the top bar. Navigation itself needs no JavaScript — the links are real
 * hash hrefs and the router listens for hashchange (rule 20).
 */
export function bindTopbarEvents() {
  const langToggle = qs('#topbar-lang');
  if (langToggle) {
    langToggle.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-lang]');
      if (button) setLang(button.dataset.lang);
    });
  }

  const logoutButton = qs('#topbar-logout');
  if (logoutButton) {
    logoutButton.addEventListener('click', function () { logout(); });
  }
}

/**
 * @param {string} role
 * @return {string} translated role name.
 */
export function roleLabel(role) {
  return role === 'manager' ? t('role_manager') : t('role_coordinator');
}

/**
 * First character of a display name, for the avatar.
 * @param {string} name
 * @return {string}
 */
export function initial(name) {
  const trimmed = String(name || '').trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
}
