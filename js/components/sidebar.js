/**
 * sidebar.js — the app shell's chrome, for BOTH roles (CLAUDE.md 5.1).
 *
 * Manager: "Dashboard, Approvals, Export, Admin". Admin has sub-tabs: Teams,
 * Site→JC, People, Lists.
 * Coordinator: Dashboard, plus the settlement he currently has open.
 *
 * The coordinator used to get a slim top bar instead, on the reasoning that two
 * screens do not need a nav rail. The project owner asked for one shell: the
 * coordinator sees the same navy rail the manager does, so the app looks like
 * one product rather than two. His rail is shorter because his job is smaller —
 * that is the only difference.
 *
 * Deep navy, per 8.3. Proportions (230px, 10px/22px links, the 3px active rail)
 * come from design/Settlement App.html.
 *
 * The head carries the company logo above the app's own name: the white artwork
 * is made for a dark ground, which is exactly what the rail is. It keeps its
 * intrinsic width/height attributes so the rail does not shift while it loads,
 * and the app name stays underneath it — the logo says whose app this is, the
 * brand line says which app it is.
 *
 * The foot carries the two things that are the same on every screen for both
 * roles: the language toggle and sign out, plus Refresh — which re-runs the
 * current route rather than reloading the browser, because the token is
 * memory-only (4.2) and a reload would cost a login.
 *
 * The Admin sub-tabs are revealed only while an admin route is open: Admin
 * itself links to the first tab, so one click gets you in and the sub-list then
 * shows where you are. That avoids an expand/collapse state with nowhere to
 * live across a full re-render.
 */

import { getUser, getDisplayName } from '../state.js';
import { t, getLang, setLang } from '../i18n/i18n.js';
import { escapeHtml, qs } from '../utils/dom.js';
import { logout } from '../auth/session.js';
import { refreshRoute } from '../router.js';

/**
 * The top-level destinations per role (5.2). `match` is the hash prefix that
 * counts as "you are here" — Admin matches every #/admin/* route, not just its
 * own link.
 */
const NAV_BY_ROLE = {
  manager: [
    { href: '#/dashboard', match: '#/dashboard', labelKey: 'nav_dashboard', icon: '▦' },
    { href: '#/approvals', match: '#/approvals', labelKey: 'nav_approvals', icon: '✓' },
    { href: '#/export',    match: '#/export',    labelKey: 'nav_export',    icon: '↧' },
    { href: '#/admin/teams', match: '#/admin',   labelKey: 'nav_admin',     icon: '⚙' }
  ],

  coordinator: [
    { href: '#/dashboard', match: '#/dashboard', labelKey: 'nav_dashboard', icon: '▦' }
  ]
};

/** Admin's sub-tabs, in the order 5.1 lists them. */
const ADMIN_TABS = [
  { href: '#/admin/teams',  labelKey: 'nav_teams' },
  { href: '#/admin/sitejc', labelKey: 'nav_sitejc' },
  { href: '#/admin/people', labelKey: 'nav_people' },
  { href: '#/admin/lists',  labelKey: 'nav_lists' }
];

/**
 * The sidebar for the signed-in user's role.
 *
 * @param {string} activeHash the current route, for the active highlight.
 * @return {string} HTML
 */
export function renderSidebar(activeHash) {
  const hash = activeHash || '#/dashboard';
  const lang = getLang();
  const name = getDisplayName(lang);
  const user = getUser() || {};
  const inAdmin = hash.indexOf('#/admin') === 0;

  const items = NAV_BY_ROLE[user.role] || NAV_BY_ROLE.coordinator;

  const links = items.map(function (item) {
    const active = hash.indexOf(item.match) === 0;
    const link = `
      <a class="nav-link${active ? ' is-active' : ''}" href="${item.href}"
         ${active ? 'aria-current="page"' : ''}>
        <span class="nav-icon" aria-hidden="true">${item.icon}</span>${escapeHtml(t(item.labelKey))}
      </a>`;

    // Admin carries its sub-tabs, but only once you are inside it.
    if (item.match === '#/admin' && inAdmin) {
      return link + `<div class="nav-sub">${renderAdminTabs(hash)}</div>`;
    }

    /*
     * The open settlement hangs under Dashboard, because that is where it was
     * opened from and #/settlement/<id> has no nav entry of its own. It appears
     * only while it is open — there is nothing to link to otherwise.
     */
    if (item.match === '#/dashboard' && user.role === 'coordinator') {
      const open = openSettlementId(hash);
      if (open) return link + `<div class="nav-sub">${renderOpenSettlement(open)}</div>`;
    }

    return link;
  }).join('');

  return `
    <aside class="sidebar">
      <div class="sidebar-head">
        <img class="sidebar-logo" src="assets/lmp-logo-white.png"
             alt="${escapeHtml(t('brand_logo_alt'))}" width="360" height="143">
        <div class="sidebar-brand">${escapeHtml(t('brand_name'))}</div>
        <div class="sidebar-tagline">${escapeHtml(t('brand_tagline'))}</div>
      </div>

      <nav class="sidebar-nav">${links}</nav>

      <div class="sidebar-foot">
        <div class="sidebar-user">
          <div class="avatar" aria-hidden="true">${escapeHtml(initial(name))}</div>
          <div>
            <div class="sidebar-user-name">${escapeHtml(name)}</div>
            <div class="sidebar-user-role">${escapeHtml(roleLabel(user.role))}</div>
          </div>
        </div>

        <div class="row-tight sidebar-actions">
          <div class="lang-toggle lang-toggle-on-navy" id="sidebar-lang"
               role="group" aria-label="${escapeHtml(t('language'))}">
            <button type="button" data-lang="en" aria-pressed="${lang === 'en'}">${escapeHtml(t('lang_en'))}</button>
            <button type="button" data-lang="ar" aria-pressed="${lang === 'ar'}">${escapeHtml(t('lang_ar'))}</button>
          </div>
          <div class="spacer"></div>
          <button class="btn btn-sm btn-on-navy btn-refresh" id="sidebar-refresh" type="button"
                  title="${escapeHtml(t('refresh'))}" aria-label="${escapeHtml(t('refresh'))}">
            <span class="refresh-icon" aria-hidden="true">↻</span>
          </button>
          <button class="btn btn-sm btn-on-navy" id="sidebar-logout" type="button">
            ${escapeHtml(t('sign_out'))}
          </button>
        </div>
      </div>
    </aside>
  `;
}

/**
 * The settlement id in `#/settlement/<id>`, or '' on any other route.
 * @param {string} hash
 * @return {string}
 */
function openSettlementId(hash) {
  const match = /^#\/settlement\/(.+)$/.exec(hash || '');
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * The open settlement, as a sub-link under Dashboard. Always the active item —
 * it is only rendered while you are standing on it.
 *
 * The id keeps `.num` so it stays LTR in Arabic (8.1).
 *
 * @param {string} settlementId
 * @return {string} HTML
 */
function renderOpenSettlement(settlementId) {
  return `
    <a class="nav-link is-active" href="#/settlement/${encodeURIComponent(settlementId)}"
       aria-current="page">
      <span class="num">${escapeHtml(settlementId)}</span>
    </a>`;
}

/**
 * The Admin sub-tab list.
 * @param {string} hash the current route.
 * @return {string} HTML
 */
function renderAdminTabs(hash) {
  return ADMIN_TABS.map(function (tab) {
    const active = hash === tab.href;
    return `
      <a class="nav-link${active ? ' is-active' : ''}" href="${tab.href}"
         ${active ? 'aria-current="page"' : ''}>${escapeHtml(t(tab.labelKey))}</a>`;
  }).join('');
}

/**
 * Wire the sidebar. The nav links are plain hash hrefs — only the language
 * toggle, refresh and sign out need handlers.
 */
export function bindSidebarEvents() {
  /*
   * Refresh re-runs the current route: the screen is re-rendered and its bind*
   * re-fetches, so the numbers on it come from the server again. The session
   * lives in memory and is untouched, which is the whole point — nobody signs
   * in again to see a fresh count.
   */
  const refreshButton = qs('#sidebar-refresh');
  if (refreshButton) {
    refreshButton.addEventListener('click', function () { refreshRoute(); });
  }

  const langToggle = qs('#sidebar-lang');
  if (langToggle) {
    langToggle.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-lang]');
      if (button) setLang(button.dataset.lang);
    });
  }

  const logoutButton = qs('#sidebar-logout');
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
