/**
 * dashboard.js (coordinator) — "his settlements" (CLAUDE.md 5.1).
 *
 * One row per coordinator-month, each carrying an account and the TWO
 * independent tracking numbers, with an Old and a New status that move
 * separately (rules 9 and 10). Every row opens its grid at
 * `#/settlement/<id>` — this is the only way into the entry screen.
 *
 * The stat tiles are derived from the same `get_my_settlements` roll-up rather
 * than from separate counting calls: the server already returns per-track
 * counts, and a second read of the same sheets to recount them would be slower
 * and could disagree with the table underneath it.
 */

import { api } from '../api.js';
import { t, errorMessage } from '../i18n/i18n.js';
import { escapeHtml, qs } from '../utils/dom.js';
import { renderLoading, renderLoadError, renderEmpty } from '../components/table.js';

/** The settlements from the last load. */
let settlements = [];

/**
 * The coordinator dashboard.
 * @return {string} HTML
 */
export function renderCoordinatorDashboard() {
  return `
    <div class="page" id="coordinator-dashboard">
      <div class="page-title-row">
        <div>
          <h1>${escapeHtml(t('dashboard_title'))}</h1>
          <div class="page-subtitle">${escapeHtml(t('coordinator_dashboard_subtitle'))}</div>
        </div>
      </div>

      <div class="stat-row" id="coordinator-stats">
        ${statCard('stat_open_settlements', '—')}
        ${statCard('stat_draft_entries', '—')}
        ${statCard('stat_awaiting_approval', '—')}
        ${statCard('stat_returned_to_me', '—')}
      </div>

      <div class="card mt-6">
        <div class="card-header">
          <span class="card-title">${escapeHtml(t('my_settlements'))}</span>
        </div>
        <div id="settlements-body">${renderLoading()}</div>
      </div>
    </div>
  `;
}

/** Wire the dashboard and load it. */
export function bindCoordinatorDashboardEvents() {
  const page = qs('#coordinator-dashboard');
  if (!page) return;

  settlements = [];

  page.addEventListener('click', function (event) {
    if (event.target.closest('[data-action="retry"]')) load();
  });

  load();
}

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

/** Fetch the settlements and paint the table and the tiles. */
async function load() {
  const body = qs('#settlements-body');
  if (!body) return;

  body.innerHTML = renderLoading();

  try {
    const data = await api.call('get_my_settlements', {});
    settlements = (data && data.settlements) || [];

    body.innerHTML = renderTable();
    paintStats();

  } catch (err) {
    settlements = [];
    body.innerHTML = renderLoadError(errorMessage(err));
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** @return {string} HTML */
function renderTable() {
  if (!settlements.length) {
    return renderEmpty(t('no_settlements_title'), t('no_settlements_text'), '▤');
  }

  return `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>${escapeHtml(t('col_settlement'))}</th>
            <th>${escapeHtml(t('col_month'))}</th>
            <th>${escapeHtml(t('col_account'))}</th>
            <th>${escapeHtml(t('period_old'))}</th>
            <th>${escapeHtml(t('period_new'))}</th>
            <th class="col-actions"><span class="sr-only">${escapeHtml(t('actions'))}</span></th>
          </tr>
        </thead>
        <tbody>
          ${settlements.map(renderRow).join('')}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * One settlement. The two tracks get a column each, because they move
 * independently and a single combined status would hide exactly that.
 *
 * @param {Object} settlement
 * @return {string} HTML
 */
function renderRow(settlement) {
  const href = '#/settlement/' + encodeURIComponent(settlement.settlement_id);

  return `
    <tr>
      <td class="num text-bold">
        <a href="${href}">${escapeHtml(settlement.settlement_id)}</a>
      </td>
      <td>${escapeHtml(settlement.month)} <span class="num text-muted">${escapeHtml(settlement.fiscal_year)}</span></td>
      <td class="num">${escapeHtml(settlement.account)}</td>
      ${trackCell(settlement.tracks.old, 'old')}
      ${trackCell(settlement.tracks.new, 'new')}
      <td class="col-actions">
        <a class="btn btn-secondary btn-sm" href="${href}">${escapeHtml(t('open'))}</a>
      </td>
    </tr>
  `;
}

/**
 * One track's cell: its status, and the Tracking# it settles against (6.2).
 * @param {Object} track
 * @param {string} period
 * @return {string} HTML
 */
function trackCell(track, period) {
  return `
    <td>
      <div class="row-tight">
        <span class="badge badge-${escapeHtml(track.status)}">${escapeHtml(t('track_status_' + track.status))}</span>
        ${track.total ? `<span class="text-tiny text-muted num">${track.total}</span>` : ''}
      </div>
      <div class="text-tiny text-muted">
        ${track.tracking_no_set
          ? `<span class="num">#${escapeHtml(track.tracking_no)}</span>`
          : escapeHtml(t('tracking_placeholder'))}
      </div>
    </td>
  `;
}

/**
 * Fill the four tiles from the roll-up already on screen.
 *
 * "Open settlements" counts a settlement as open while either track still has
 * anything that is not exported — a month is not finished until both tracks are.
 */
function paintStats() {
  let open = 0;
  let draft = 0;
  let awaiting = 0;
  let returned = 0;

  settlements.forEach(function (settlement) {
    let unfinished = false;

    ['old', 'new'].forEach(function (period) {
      const counts = settlement.tracks[period].counts;

      draft += counts.draft;
      awaiting += counts.confirmed;
      returned += counts.returned;

      if (counts.draft || counts.confirmed || counts.approved || counts.returned) unfinished = true;
    });

    if (unfinished) open++;
  });

  const host = qs('#coordinator-stats');
  if (!host) return;

  host.innerHTML = [
    statCard('stat_open_settlements', open),
    statCard('stat_draft_entries', draft),
    statCard('stat_awaiting_approval', awaiting),
    statCard('stat_returned_to_me', returned)
  ].join('');
}

/**
 * One stat tile.
 * @param {string} labelKey
 * @param {number|string} value '—' while the data has not arrived.
 * @return {string} HTML
 */
function statCard(labelKey, value) {
  const pending = value === '—';

  return `
    <div class="stat-card">
      <div class="stat-label">${escapeHtml(t(labelKey))}</div>
      <div class="stat-value${pending ? ' is-pending' : ' num'}">${escapeHtml(String(value))}</div>
      ${pending ? `<div class="stat-foot">${escapeHtml(t('loading'))}</div>` : ''}
    </div>
  `;
}
