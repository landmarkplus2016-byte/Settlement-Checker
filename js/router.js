/**
 * router.js — hash routing (CLAUDE.md 5.2, rule 20).
 *
 * GitHub Pages serves static files and has no server-side routing, so the route
 * is always read from location.hash.
 *
 * STAGE 3 STUB. Every authenticated route below renders a placeholder; Stage 4
 * replaces these with the real coordinator top-bar shell and manager sidebar
 * shell, and hands each route to its screen module. What is already real here
 * and must stay real:
 *   - unauthenticated → login, whatever the hash says
 *   - a coordinator on a manager route (or the reverse) → #/dashboard
 *   - re-render on language change
 *
 * The role check here is UX only. The server is the gate (rules 4, 5).
 */

import { isAuthenticated, getRole, getUser, getDisplayName, mustChangePassword } from './state.js';
import { t, getLang, setLang, LANG_CHANGE_EVENT } from './i18n/i18n.js';
import { escapeHtml, mount, qs } from './utils/dom.js';
import { renderLogin, bindLoginEvents } from './auth/login.js';
import { renderChangePassword, bindChangePasswordEvents } from './auth/changePassword.js';
import { logout } from './auth/session.js';

/** Routes only a manager may open (5.2). */
const MANAGER_ROUTES = ['#/approvals', '#/export', '#/admin'];

/** Routes only a coordinator may open. */
const COORDINATOR_ROUTES = ['#/settlement'];

/** Called when the user asks to re-point this device; set by main.js. */
let onChangeUrl = null;

/** Listeners are attached once, however many times boot() runs. */
let listening = false;

/**
 * True while a boot screen (setup, connection failure) owns #app. Those screens
 * are outside routing, so a hash change or a language switch underneath them
 * must not paint over them.
 */
let suspended = false;

/**
 * Start routing. Re-entrant: boot() may run more than once (retry, changed
 * URL), but the listeners are only ever attached the first time.
 *
 * @param {Object} [options]
 * @param {Function} [options.onChangeUrl]
 */
export function startRouter(options = {}) {
  onChangeUrl = options.onChangeUrl || null;
  suspended = false;

  if (!listening) {
    window.addEventListener('hashchange', renderRoute);

    // A language switch redraws whatever is on screen; nothing here re-fetches.
    window.addEventListener(LANG_CHANGE_EVENT, renderRoute);
    listening = true;
  }

  renderRoute();
}

/**
 * Hand #app to (or take it back from) a boot screen.
 * @param {boolean} value
 */
export function setRouterSuspended(value) {
  suspended = !!value;
}

/**
 * Go to a route. Setting the hash to its current value fires no hashchange, so
 * render directly in that case — otherwise signing in while already on
 * #/dashboard would leave the login screen up.
 *
 * @param {string} hash e.g. '#/dashboard'
 */
export function navigate(hash) {
  if (window.location.hash === hash) {
    renderRoute();
  } else {
    window.location.hash = hash;
  }
}

/**
 * Render whatever the current hash asks for.
 */
export function renderRoute() {
  if (suspended) return;

  const hash = window.location.hash || '#/dashboard';

  if (!isAuthenticated()) {
    mount(renderLogin());
    bindLoginEvents({
      onSuccess: function (result) {
        navigate(result && result.must_change_password ? '#/change-password' : '#/dashboard');
      },
      onChangeUrl: onChangeUrl
    });
    return;
  }

  /*
   * "force_password_change sends the user to the change-password screen before
   * anything else" (4.3). This is that gate, and it sits above every other
   * check on purpose: a flagged user typing #/dashboard, #/approvals or any
   * admin route into the address bar lands back here.
   *
   * Client-side, so it is UX, not security — the flag is only about making the
   * user pick their own password, and every real permission is checked by the
   * server anyway (rules 4, 5).
   */
  if (mustChangePassword() && hash.indexOf('#/change-password') !== 0) {
    return navigate('#/change-password');
  }

  if (hash.indexOf('#/change-password') === 0) {
    mount(renderChangePassword());
    bindChangePasswordEvents({
      onSuccess: function () { navigate('#/dashboard'); }
    });
    return;
  }

  const role = getRole();

  // Wrong-role routes bounce to the dashboard (5.2).
  if (matches(hash, MANAGER_ROUTES) && role !== 'manager') return navigate('#/dashboard');
  if (matches(hash, COORDINATOR_ROUTES) && role !== 'coordinator') return navigate('#/dashboard');

  if (hash === '#/login' || hash.indexOf('#/dashboard') === 0) {
    return renderShell(
      t('dashboard_title'),
      role === 'manager'
        ? t('placeholder_manager_dashboard')
        : t('placeholder_coordinator_dashboard')
    );
  }

  // Stage 4 gives each of these its own screen; until then a signed-in user on
  // a valid-for-their-role route sees the placeholder rather than a dead page.
  if (matches(hash, MANAGER_ROUTES) || matches(hash, COORDINATOR_ROUTES)) {
    return renderShell(
      t('dashboard_title'),
      role === 'manager'
        ? t('placeholder_manager_dashboard')
        : t('placeholder_coordinator_dashboard')
    );
  }

  return renderShell(t('not_found_title'), t('not_found_subtitle'));
}

/**
 * @param {string} hash
 * @param {Array<string>} prefixes
 * @return {boolean}
 */
function matches(hash, prefixes) {
  return prefixes.some(function (prefix) { return hash.indexOf(prefix) === 0; });
}

/* ------------------------------------------------------------------ *
 * The Stage 3 placeholder shell
 * ------------------------------------------------------------------ */

/**
 * A minimal signed-in frame: brand, user, language toggle, sign out, and a card
 * saying what will live here. Replaced wholesale in Stage 4 by
 * js/components/topbar.js and js/components/sidebar.js.
 *
 * @param {string} title
 * @param {string} body
 */
function renderShell(title, body) {
  const lang = getLang();
  const user = getUser() || {};
  const name = getDisplayName(lang);
  const roleLabel = user.role === 'manager' ? t('role_manager') : t('role_coordinator');

  mount(`
    <header class="topbar">
      <div class="brand-mark">${escapeHtml(t('brand_mark'))}</div>
      <div class="brand">
        <div class="brand-name">${escapeHtml(t('brand_name'))}</div>
        <div class="brand-tagline">${escapeHtml(t('brand_tagline'))}</div>
      </div>

      <div class="spacer"></div>

      <div class="lang-toggle" id="shell-lang">
        <button type="button" data-lang="en" aria-pressed="${lang === 'en'}">${escapeHtml(t('lang_en'))}</button>
        <button type="button" data-lang="ar" aria-pressed="${lang === 'ar'}">${escapeHtml(t('lang_ar'))}</button>
      </div>

      <div class="topbar-user">
        <span class="text-small text-bold">${escapeHtml(name)}</span>
        <span class="text-tiny text-muted">${escapeHtml(roleLabel)}</span>
      </div>
      <div class="avatar">${escapeHtml(initial(name))}</div>

      <button class="btn btn-secondary btn-sm" id="shell-logout" type="button">
        ${escapeHtml(t('sign_out'))}
      </button>
    </header>

    <main class="page">
      <div class="page-header">
        <h1>${escapeHtml(title)}</h1>
        <span class="badge badge-neutral">${escapeHtml(roleLabel)}</span>
      </div>

      <div class="card card-padded stack-2">
        <div class="text-secondary">${escapeHtml(t('signed_in_as', { name: name }))}</div>
        <p class="text-secondary">${escapeHtml(body)}</p>
      </div>
    </main>
  `);

  bindShellEvents();
}

/**
 * Wire the placeholder shell's chrome.
 */
function bindShellEvents() {
  const langToggle = qs('#shell-lang');
  if (langToggle) {
    langToggle.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-lang]');
      if (button) setLang(button.dataset.lang);
    });
  }

  const logoutButton = qs('#shell-logout');
  if (logoutButton) {
    logoutButton.addEventListener('click', function () { logout(); });
  }
}

/**
 * First character of a display name, for the avatar.
 * @param {string} name
 * @return {string}
 */
function initial(name) {
  const trimmed = String(name || '').trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
}
