/**
 * dashboard.js (manager) — the consolidated view's landing screen
 * (CLAUDE.md 5.1).
 *
 * STAGE 4: layout and navigation only. The numbers come from `list_pending`
 * (3.6) and the export log (3.7), neither of which exists until Stages 7 and 8,
 * so every stat renders '—'.
 *
 * The quick actions, though, are real navigation — they are the manager's route
 * into the three things they actually do: approve, export, and administer.
 */

import { t } from '../i18n/i18n.js';
import { escapeHtml } from '../utils/dom.js';

/**
 * The manager dashboard.
 * @return {string} HTML
 */
export function renderManagerDashboard() {
  return `
    <div class="page">
      <div class="page-title-row">
        <div>
          <h1>${escapeHtml(t('dashboard_title'))}</h1>
          <div class="page-subtitle">${escapeHtml(t('manager_dashboard_subtitle'))}</div>
        </div>
      </div>

      <div class="stat-row">
        ${statCard('stat_awaiting_approval')}
        ${statCard('stat_approved_unexported')}
        ${statCard('stat_returned_open')}
        ${statCard('stat_active_coordinators')}
      </div>

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

/**
 * Wire the dashboard. The quick actions are plain hash links, so there is
 * nothing to bind yet; the stats get their refresh here in Stage 7.
 */
export function bindManagerDashboardEvents() {
  /* Stage 7/8: load the pending and export counts into the stat tiles. */
}

/**
 * One placeholder stat tile.
 * @param {string} labelKey
 * @return {string} HTML
 */
function statCard(labelKey) {
  return `
    <div class="stat-card">
      <div class="stat-label">${escapeHtml(t(labelKey))}</div>
      <div class="stat-value is-pending">—</div>
      <div class="stat-foot">${escapeHtml(t('stat_pending_data'))}</div>
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
