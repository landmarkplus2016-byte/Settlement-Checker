/**
 * router.js — hash routing and the two role shells (CLAUDE.md 5.1, 5.2, 5.3;
 * rule 20).
 *
 * GitHub Pages serves static files and has no server-side routing, so the route
 * is always read from location.hash.
 *
 * Every render is a full re-render: the screen's render* function returns an
 * HTML string, it goes into #app inside the role's shell, then the matching
 * bind* functions attach listeners (5.3). The one screen that will opt out of
 * this is the grid, which updates cells in place (6.5) — it will still be
 * *mounted* from here, it just will not be re-rendered on every keystroke.
 *
 * The role checks here are UX. The server is the real gate (rules 4, 5): it
 * resolves a coordinator's sheet from the session and re-checks `role` at the
 * top of every manager action, so a forged hash buys nothing.
 */

import { isAuthenticated, getRole, mustChangePassword } from './state.js';
import { t, LANG_CHANGE_EVENT } from './i18n/i18n.js';
import { escapeHtml, mount } from './utils/dom.js';

import { renderLogin, bindLoginEvents } from './auth/login.js';
import { renderChangePassword, bindChangePasswordEvents } from './auth/changePassword.js';

import { renderTopbar, bindTopbarEvents } from './components/topbar.js';
import { renderSidebar, bindSidebarEvents } from './components/sidebar.js';
import { logout } from './auth/session.js';

import { renderCoordinatorDashboard, bindCoordinatorDashboardEvents } from './coordinator/dashboard.js';
import { renderManagerDashboard, bindManagerDashboardEvents } from './manager/dashboard.js';
import { renderApprovals, bindApprovalsEvents } from './manager/approvals.js';
import { renderExport, bindExportEvents } from './manager/export.js';

import { renderSettlementPage, bindSettlementPageEvents } from './coordinator/settlement.js';

import { renderTeams, bindTeamsEvents } from './admin/teams.js';
import { renderSiteJc, bindSiteJcEvents } from './admin/siteJc.js';
import { renderUsers, bindUsersEvents } from './admin/users.js';
import { renderLists, bindListsEvents } from './admin/lists.js';

/**
 * The route table — CLAUDE.md 5.2, in the order it lists them.
 *
 * `roles` is the whole cross-role rule: a hash whose route does not list the
 * caller's role redirects to #/dashboard. `params` pulls the capture groups out
 * of the pattern (only #/settlement/<id> has one).
 */
const ROUTES = [
  { name: 'dashboard',    pattern: /^#\/dashboard$/,          roles: ['coordinator', 'manager'] },
  { name: 'settlement',   pattern: /^#\/settlement\/(.+)$/,   roles: ['coordinator'], params: ['settlement_id'] },
  { name: 'approvals',    pattern: /^#\/approvals$/,          roles: ['manager'] },
  { name: 'export',       pattern: /^#\/export$/,             roles: ['manager'] },
  { name: 'admin_teams',  pattern: /^#\/admin\/teams$/,       roles: ['manager'] },
  { name: 'admin_sitejc', pattern: /^#\/admin\/sitejc$/,      roles: ['manager'] },
  { name: 'admin_people', pattern: /^#\/admin\/people$/,      roles: ['manager'] },
  { name: 'admin_lists',  pattern: /^#\/admin\/lists$/,       roles: ['manager'] }
];

/** Bare #/admin has no screen of its own; it opens the first sub-tab. */
const ADMIN_DEFAULT = '#/admin/teams';

/**
 * Screens that are routed but not built. Each maps to the i18n keys for its
 * placeholder; removing an entry from here and adding a case to renderScreen()
 * is the whole of wiring a real screen up.
 *
 * Empty now — every route in 5.2 has a screen.
 */
const NOT_BUILT_YET = {};

/**
 * The four admin tabs (5.2). Each is a { render, bind } pair, keyed by route
 * name — they are identical in shape, so listing them beats four more branches
 * in renderScreen().
 */
const ADMIN_SCREENS = {
  admin_teams:  { render: renderTeams,  bind: bindTeamsEvents },
  admin_sitejc: { render: renderSiteJc, bind: bindSiteJcEvents },
  admin_people: { render: renderUsers,  bind: bindUsersEvents },
  admin_lists:  { render: renderLists,  bind: bindListsEvents }
};

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

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * The route pass
 * ------------------------------------------------------------------ */

/**
 * Render whatever the current hash asks for.
 */
export function renderRoute() {
  if (suspended) return;

  const hash = window.location.hash || '#/dashboard';

  // 1. Signed out — the login screen, whatever the hash says.
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
   * 2. "force_password_change sends the user to the change-password screen
   * before anything else" (4.3). Above every other check on purpose: a flagged
   * user typing #/approvals into the address bar lands back here.
   */
  if (mustChangePassword() && hash.indexOf('#/change-password') !== 0) {
    return navigate('#/change-password');
  }

  // 3. The change-password screen stands outside both shells.
  if (hash.indexOf('#/change-password') === 0) {
    mount(renderChangePassword());
    bindChangePasswordEvents({ onSuccess: function () { navigate('#/dashboard'); } });
    return;
  }

  // 4. Bare #/admin is a shortcut to the first admin tab.
  if (hash === '#/admin' || hash === '#/admin/') {
    return navigate(ADMIN_DEFAULT);
  }

  const role = getRole();

  /*
   * 5. A session whose role is neither of the two is a dead end, and it must be
   * caught BEFORE the cross-role check below: that check redirects to
   * #/dashboard, whose route lists both real roles, so an unknown role would
   * fail it again and navigate() — already on that hash — would call straight
   * back into here. An unbounded recursion, on the one path where nothing can
   * ever render. Sign out instead.
   */
  if (role !== 'coordinator' && role !== 'manager') {
    mount(unknownRoleScreen());
    bindUnknownRoleEvents();
    return;
  }

  const route = matchRoute(hash);

  // 6. Unknown hash — inside the shell, so the user keeps their navigation.
  if (!route) {
    return paint(role, hash, notFoundScreen(), null);
  }

  // 7. Cross-role route — redirect to the dashboard both roles share (5.2).
  if (route.roles.indexOf(role) === -1) {
    return navigate('#/dashboard');
  }

  renderScreen(route, role, hash);
}

/**
 * Find the route for a hash.
 * @param {string} hash
 * @return {{name: string, roles: Array<string>, params: Object}|null}
 */
function matchRoute(hash) {
  for (let i = 0; i < ROUTES.length; i++) {
    const route = ROUTES[i];
    const found = route.pattern.exec(hash);
    if (!found) continue;

    const params = {};
    (route.params || []).forEach(function (key, index) {
      params[key] = decodeURIComponent(found[index + 1]);
    });

    return { name: route.name, roles: route.roles, params: params };
  }
  return null;
}

/**
 * Render one matched route: pick the screen, paint it into the role's shell,
 * then bind it (5.3).
 *
 * @param {Object} route from matchRoute().
 * @param {string} role
 * @param {string} hash
 */
function renderScreen(route, role, hash) {
  if (route.name === 'dashboard') {
    if (role === 'manager') {
      return paint(role, hash, renderManagerDashboard(), bindManagerDashboardEvents);
    }
    return paint(role, hash, renderCoordinatorDashboard(), bindCoordinatorDashboardEvents);
  }

  // The consolidated review screen (3.6). Manager-only, enforced server-side.
  if (route.name === 'approvals') {
    return paint(role, hash, renderApprovals(), bindApprovalsEvents);
  }

  // The export builder (3.7). Manager-only, enforced server-side.
  if (route.name === 'export') {
    return paint(role, hash, renderExport(), bindExportEvents);
  }

  /*
   * The settlement grid. The only route with a parameter, and the only screen
   * that manages its own in-place cell updates rather than re-rendering (5.3) —
   * it is still MOUNTED from here like everything else.
   */
  if (route.name === 'settlement') {
    const settlementId = route.params.settlement_id;
    return paint(role, hash, renderSettlementPage(settlementId), function () {
      bindSettlementPageEvents(settlementId);
    });
  }

  /*
   * The admin tabs. Each renders a shell with a loading body synchronously, then
   * its bind* fetches and fills it — paint() takes a string, so a screen that
   * needs data cannot render it on the first pass (5.3).
   */
  const admin = ADMIN_SCREENS[route.name];
  if (admin) {
    return paint(role, hash, admin.render(), admin.bind);
  }

  /*
   * Everything else is routed but not yet built. The placeholder renders inside
   * the correct shell with the correct sidebar item highlighted, so the
   * navigation is genuinely exercised — only the screen body is missing.
   */
  const pending = NOT_BUILT_YET[route.name];
  if (pending) {
    return paint(role, hash, pendingScreen(pending, route.params), null);
  }

  return paint(role, hash, notFoundScreen(), null);
}

/* ------------------------------------------------------------------ *
 * The shells (5.1)
 * ------------------------------------------------------------------ */

/**
 * Put a screen inside the shell for its role and wire everything.
 *
 * Coordinator: slim top bar over the content.
 * Manager:     navy sidebar beside the content.
 *
 * @param {string} role
 * @param {string} hash the active route, for the nav highlight.
 * @param {string} content the screen's HTML.
 * @param {Function|null} bindContent the screen's bind* function.
 */
function paint(role, hash, content, bindContent) {
  if (role === 'manager') {
    mount(`
      <div class="app-layout">
        ${renderSidebar(hash)}
        <main class="content">${content}</main>
      </div>
    `);
    bindSidebarEvents();
  } else {
    mount(`
      <div class="app-column">
        ${renderTopbar(hash)}
        <main class="content">${content}</main>
      </div>
    `);
    bindTopbarEvents();
  }

  if (typeof bindContent === 'function') bindContent();
}

/* ------------------------------------------------------------------ *
 * Filler screens
 * ------------------------------------------------------------------ */

/**
 * A routed-but-not-yet-built screen.
 * @param {{titleKey: string, textKey: string}} pending
 * @param {Object} params route params, shown when there are any.
 * @return {string} HTML
 */
function pendingScreen(pending, params) {
  const settlementId = params && params.settlement_id ? params.settlement_id : '';

  return `
    <div class="page">
      <div class="page-title-row">
        <h1>${escapeHtml(t(pending.titleKey))}</h1>
        ${settlementId ? `<span class="badge badge-neutral num">${escapeHtml(settlementId)}</span>` : ''}
      </div>

      <div class="card">
        <div class="empty-state">
          <div class="empty-icon" aria-hidden="true">▨</div>
          <div class="empty-title">${escapeHtml(t('screen_not_built_title'))}</div>
          <div class="empty-text">${escapeHtml(t(pending.textKey))}</div>
        </div>
      </div>
    </div>
  `;
}

/**
 * A signed-in session whose role is neither `coordinator` nor `manager` — a
 * mistyped Users row, or a role removed after the user logged in. Deliberately
 * shell-less: neither shell would be right, and offering navigation that cannot
 * work would be worse than offering none.
 *
 * @return {string} HTML
 */
function unknownRoleScreen() {
  return `
    <div class="screen-centered">
      <div class="auth-card">
        <div class="auth-head">
          <div class="brand-mark">${escapeHtml(t('brand_mark'))}</div>
          <div class="auth-title">${escapeHtml(t('unknown_role_title'))}</div>
          <div class="auth-subtitle">${escapeHtml(t('unknown_role_text'))}</div>
        </div>
        <button class="btn btn-primary btn-block" id="unknown-role-signout" type="button">
          ${escapeHtml(t('sign_out'))}
        </button>
      </div>
    </div>
  `;
}

/** Wire the unknown-role screen's one action. */
function bindUnknownRoleEvents() {
  const button = document.getElementById('unknown-role-signout');
  if (button) button.addEventListener('click', function () { logout(); });
}

/**
 * An unrecognised hash.
 * @return {string} HTML
 */
function notFoundScreen() {
  return `
    <div class="page">
      <div class="page-title-row">
        <h1>${escapeHtml(t('not_found_title'))}</h1>
      </div>

      <div class="card">
        <div class="empty-state">
          <div class="empty-icon" aria-hidden="true">?</div>
          <div class="empty-title">${escapeHtml(t('not_found_title'))}</div>
          <div class="empty-text">${escapeHtml(t('not_found_subtitle'))}</div>
          <a class="btn btn-primary mt-4" href="#/dashboard">${escapeHtml(t('go_to_dashboard'))}</a>
        </div>
      </div>
    </div>
  `;
}
