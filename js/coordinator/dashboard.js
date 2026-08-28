/**
 * dashboard.js (coordinator) — "his settlements" (CLAUDE.md 5.1).
 *
 * STAGE 4: layout only. The data action this screen reads,
 * `get_my_settlements` (3.5), does not exist until Stage 6.1, so the stats show
 * '—' and the table shows its empty state. Nothing here fabricates a settlement
 * to fill the space.
 *
 * What IS real is the shape: one row per coordinator-month, each carrying an
 * account and the two independent tracking numbers, with an Old and a New
 * status that move separately (rules 9 and 10). Stage 6 fills the tbody and
 * makes each row link to #/settlement/<id>.
 */

import { t } from '../i18n/i18n.js';
import { escapeHtml } from '../utils/dom.js';

/**
 * The coordinator dashboard.
 * @return {string} HTML
 */
export function renderCoordinatorDashboard() {
  return `
    <div class="page">
      <div class="page-title-row">
        <div>
          <h1>${escapeHtml(t('dashboard_title'))}</h1>
          <div class="page-subtitle">${escapeHtml(t('coordinator_dashboard_subtitle'))}</div>
        </div>
      </div>

      <div class="stat-row">
        ${statCard('stat_open_settlements')}
        ${statCard('stat_draft_entries')}
        ${statCard('stat_awaiting_approval')}
        ${statCard('stat_returned_to_me')}
      </div>

      <div class="card mt-6">
        <div class="card-header">
          <span class="card-title">${escapeHtml(t('my_settlements'))}</span>
        </div>

        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>${escapeHtml(t('col_settlement'))}</th>
                <th>${escapeHtml(t('col_month'))}</th>
                <th>${escapeHtml(t('col_account'))}</th>
                <th>${escapeHtml(t('col_old_track'))}</th>
                <th>${escapeHtml(t('col_new_track'))}</th>
              </tr>
            </thead>
            <tbody id="settlements-body">
              <tr>
                <td class="table-empty" colspan="5">
                  <div class="empty-state">
                    <div class="empty-icon" aria-hidden="true">▤</div>
                    <div class="empty-title">${escapeHtml(t('no_settlements_title'))}</div>
                    <div class="empty-text">${escapeHtml(t('no_settlements_text'))}</div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

/**
 * Wire the dashboard. Nothing to wire yet — the rows that will carry click
 * handlers do not exist until Stage 6. Kept so the router's call site does not
 * change when they do.
 */
export function bindCoordinatorDashboardEvents() {
  /* Stage 6: row -> #/settlement/<id>, and the "new settlement" action. */
}

/**
 * One placeholder stat tile.
 * @param {string} labelKey i18n key for the label.
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
