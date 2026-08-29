/**
 * dashboard.js (manager) — the consolidated view's landing screen
 * (CLAUDE.md 5.1).
 *
 * The four tiles are the manager's answer to "is there anything waiting on me?",
 * so they are read from the same source the Approvals screen reads:
 * `list_pending` with no filter (3.6). Its `counts` roll-up covers the WHOLE
 * result, not the page, which is why this asks for a single row — the numbers
 * come back complete and the payload does not.
 *
 * That also settles what each tile means:
 *
 *   - **Awaiting approval** — `confirmed`, the queue on #/approvals.
 *   - **Approved, not exported** — `approved`. `list_pending` never returns an
 *     `exported` row (MANAGER_REVIEW_STATUSES), so an approved row here is by
 *     construction one that has not been settled yet.
 *   - **Returned, open** — `returned`, still with its coordinator.
 *   - **Active coordinators** — the registry, from `list_users`.
 *
 * A sweep that could not read every coordinator's sheet is reported, never
 * hidden: these counts would be short by exactly the rows it could not see, and
 * a manager reading "0 awaiting" has to be able to trust it (3.6).
 *
 * The quick actions are real navigation — the manager's route into the three
 * things they actually do: approve, export, and administer.
 */

import { api } from '../api.js';
import { t, errorMessage, getLang } from '../i18n/i18n.js';
import { escapeHtml, qs } from '../utils/dom.js';
import { renderLoadError } from '../components/table.js';

/** The roll-up from the last `list_pending`, or null while loading / on failure. */
let counts = null;

/** Active coordinators from the registry, or null while loading / on failure. */
let activeCoordinators = null;

/** Coordinators the last sweep could not read or had to skip (3.6). */
let sweep = { errors: [], skipped: [] };

/** user_id -> Users row, so a sweep problem can be reported by name. */
let people = {};

/**
 * The manager dashboard.
 * @return {string} HTML
 */
export function renderManagerDashboard() {
  return `
    <div class="page" id="manager-dashboard">
      <div class="page-title-row">
        <div>
          <h1>${escapeHtml(t('dashboard_title'))}</h1>
          <div class="page-subtitle">${escapeHtml(t('manager_dashboard_subtitle'))}</div>
        </div>
      </div>

      <div class="stat-row" id="manager-stats">${renderStats()}</div>

      <div id="manager-stats-note"></div>

      <div class="mt-6">
        <div class="section-title">${escapeHtml(t('quick_actions'))}</div>
        <div class="action-row">
          ${actionCard('#/approvals', '✓', 'nav_approvals', 'action_approvals_text')}
          ${actionCard('#/export', '↧', 'nav_export', 'action_export_text')}
          ${actionCard('#/admin/teams', '⚙', 'nav_admin', 'action_admin_text')}
        </div>
      </div>
    </div>
  `;
}

/** Wire the dashboard and load its numbers. */
export function bindManagerDashboardEvents() {
  const page = qs('#manager-dashboard');
  if (!page) return;

  counts = null;
  activeCoordinators = null;
  sweep = { errors: [], skipped: [] };
  people = {};

  page.addEventListener('click', function (event) {
    if (event.target.closest('[data-action="retry"]')) load();
  });

  load();
}

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

/**
 * Load both reads at once and paint whatever arrives.
 *
 * They are settled independently on purpose: a registry read that fails costs
 * one tile, and blanking the review counts because of it would hide the numbers
 * the manager actually came here for.
 */
async function load() {
  counts = null;
  activeCoordinators = null;
  sweep = { errors: [], skipped: [] };
  paintStats();
  paintNote('');

  const [pending, users] = await Promise.all([
    /*
     * page_size 1 because only `counts` is used here, and it is computed over
     * the whole filtered result rather than the page (3.6). The sweep still
     * opens every coordinator's sheet — that is the cost of a consolidated
     * count, and there is no cheaper action that answers this question.
     */
    settle(api.call('list_pending', { page: 1, page_size: 1 })),
    settle(api.call('list_users', { include_inactive: false }))
  ]);

  if (pending.data) {
    counts = pending.data.counts || null;
    sweep = {
      errors: pending.data.errors || [],
      skipped: pending.data.skipped || []
    };
  }

  if (users.data) {
    const list = users.data.users || [];

    people = {};
    list.forEach(function (user) { people[user.user_id] = user; });

    activeCoordinators = list.filter(function (user) {
      return user.role === 'coordinator' && user.active;
    }).length;
  }

  paintStats();
  paintNote(pending.error);
}

/**
 * Await a call without letting a rejection escape.
 * @param {Promise} promise
 * @return {Promise<{data: Object|null, error: string}>} error is translated.
 */
function settle(promise) {
  return promise.then(
    function (data) { return { data: data, error: '' }; },
    function (err) { return { data: null, error: errorMessage(err) }; }
  );
}

/* ------------------------------------------------------------------ *
 * Painting
 * ------------------------------------------------------------------ */

/** Refill the tiles from whatever state `load()` left behind. */
function paintStats() {
  const host = qs('#manager-stats');
  if (host) host.innerHTML = renderStats();
}

/**
 * The failure / incomplete-sweep block under the tiles.
 * @param {string} error translated, or '' when the counts loaded.
 */
function paintNote(error) {
  const host = qs('#manager-stats-note');
  if (!host) return;

  if (error) {
    host.innerHTML = `<div class="card mt-4">${renderLoadError(error)}</div>`;
    return;
  }

  host.innerHTML = renderSweepWarning();
}

/**
 * The four tiles.
 * @return {string} HTML
 */
function renderStats() {
  const byStatus = (counts && counts.by_status) || null;

  return [
    statCard('stat_awaiting_approval', byStatus ? byStatus.confirmed : null),
    statCard('stat_approved_unexported', byStatus ? byStatus.approved : null),
    statCard('stat_returned_open', byStatus ? byStatus.returned : null),
    statCard('stat_active_coordinators', activeCoordinators)
  ].join('');
}

/**
 * Coordinators whose sheets could not be read (3.6). The tiles above are short
 * by whatever those sheets hold, so this is stated rather than swallowed.
 *
 * @return {string} HTML
 */
function renderSweepWarning() {
  const problems = sweep.errors.concat(sweep.skipped);
  if (!problems.length) return '';

  const names = problems.map(function (problem) {
    const user = people[problem.user_id];
    return user ? personName(user) : problem.user_id;
  });

  return `
    <div class="alert alert-warning mt-4">
      ${escapeHtml(t('sweep_incomplete', { names: names.join(t('list_separator')) }))}
    </div>
  `;
}

/**
 * One stat tile.
 * @param {string} labelKey
 * @param {number|null} value null while the number has not arrived.
 * @return {string} HTML
 */
function statCard(labelKey, value) {
  const pending = value === null || value === undefined;

  return `
    <div class="stat-card">
      <div class="stat-label">${escapeHtml(t(labelKey))}</div>
      <div class="stat-value${pending ? ' is-pending' : ' num'}">${escapeHtml(pending ? '—' : String(value))}</div>
      ${pending ? `<div class="stat-foot">${escapeHtml(t('loading'))}</div>` : ''}
    </div>
  `;
}

/**
 * One quick-action card.
 * @param {string} href hash route.
 * @param {string} icon
 * @param {string} titleKey
 * @param {string} textKey
 * @return {string} HTML
 */
function actionCard(href, icon, titleKey, textKey) {
  return `
    <a class="action-card" href="${href}">
      <span class="action-card-title">
        <span class="nav-icon" aria-hidden="true">${icon}</span>${escapeHtml(t(titleKey))}
      </span>
      <span class="action-card-text">${escapeHtml(t(textKey))}</span>
    </a>
  `;
}

/**
 * A person's name in the active language (8.1).
 * @param {Object|null|undefined} person
 * @return {string}
 */
function personName(person) {
  if (!person) return '';
  if (getLang() === 'ar' && person.display_name_ar) return person.display_name_ar;
  return person.display_name || person.user_id || '';
}
