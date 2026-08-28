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
import { openModal } from '../components/modal.js';
import { toastSuccess } from '../components/toast.js';

/** The settlements from the last load. */
let settlements = [];

/**
 * `Lists.months`, fetched the first time the New-settlement dialog opens and
 * kept for the life of the screen. The month must be one of these — the server
 * rejects anything else as `unknown_month` — so it is a select, never free text.
 */
let monthOptions = null;

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
        <span class="spacer"></span>
        <button class="btn btn-primary" type="button" data-action="new-settlement">
          ${escapeHtml(t('settlement_new'))}
        </button>
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
    if (event.target.closest('[data-action="new-settlement"]')) openNewSettlement();
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
 * Creating a settlement — the way into the grid
 * ------------------------------------------------------------------ */

/**
 * The New-settlement dialog.
 *
 * A settlement is one coordinator + one month (rule 9), and it is the container
 * every entry hangs off — so this is the only door into the grid. It carries the
 * account and the two tracking numbers, because those are batch-level facts set
 * once for the month, not per row.
 *
 * Both tracking numbers are optional here. `confirm_track` refuses to move a
 * track whose number is unset (3.5), so a coordinator can start typing entries
 * on the day he opens the month and fill in the numbers when finance issues
 * them — the header on the settlement screen edits them later.
 */
async function openNewSettlement() {
  if (!monthOptions) {
    try {
      const data = await api.call('list_lists', { list_name: 'months' });
      monthOptions = ((data && data.lists && data.lists.months) || [])
        .map(function (option) { return option.value; });
    } catch (err) {
      monthOptions = [];
    }
  }

  const year = String(new Date().getFullYear());

  openModal({
    title: t('settlement_new'),
    confirmLabel: t('create'),

    bodyHtml: `
      <div class="field">
        <label class="label" for="new-month">${escapeHtml(t('col_month'))}</label>
        ${renderMonthControl()}
      </div>

      <div class="field">
        <label class="label" for="new-account">${escapeHtml(t('col_account'))}</label>
        <input class="input num" id="new-account" type="text" maxlength="40"
               placeholder="${escapeHtml(t('settlement_account_placeholder'))}">
      </div>

      <div class="field">
        <label class="label" for="new-old-tracking">${escapeHtml(t('settlement_old_tracking'))}</label>
        <input class="input num" id="new-old-tracking" type="number" min="1" step="1"
               placeholder="${escapeHtml(t('settlement_tracking_optional'))}">
      </div>

      <div class="field">
        <label class="label" for="new-new-tracking">${escapeHtml(t('settlement_new_tracking'))}</label>
        <input class="input num" id="new-new-tracking" type="number" min="1" step="1"
               placeholder="${escapeHtml(t('settlement_tracking_optional'))}">
      </div>
    `,

    onConfirm: async function (ctx) {
      const month = ctx.value('#new-month');
      const account = ctx.value('#new-account');

      // Checked here only to save a round trip; Coordinator.gs validates both
      // again and owns the answer.
      if (!month) {
        ctx.setError(t('settlement_month_required'));
        return false;
      }
      if (!account) {
        ctx.setError(t('settlement_account_required'));
        return false;
      }

      const data = await api.call('create_settlement', {
        month: month,
        account: account,
        fiscal_year: year,
        old_tracking_no: ctx.value('#new-old-tracking'),
        new_tracking_no: ctx.value('#new-new-tracking')
      });

      const created = data && data.settlement;
      if (!created) return;

      toastSuccess(t('settlement_created'));

      // Straight into the grid — creating a month and then hunting for its row
      // is a step with no purpose.
      location.hash = '#/settlement/' + encodeURIComponent(created.settlement_id);
    }
  });
}

/**
 * The month field.
 *
 * Normally a select over `Lists.months`, so a typed "Augst" cannot become a
 * second August. On a fresh install that list is empty, and the server accepts
 * any non-empty label precisely so the app is usable before an admin has been
 * near the Lists screen (isKnownMonthLabel in Coordinator.gs) — so we fall back
 * to a text box rather than a select with nothing in it.
 *
 * @return {string} HTML
 */
function renderMonthControl() {
  if (!monthOptions.length) {
    return `
      <input class="input" id="new-month" type="text" maxlength="20"
             placeholder="${escapeHtml(t('settlement_month_placeholder'))}">
      <div class="field-hint">${escapeHtml(t('settlement_no_months'))}</div>`;
  }

  return `
    <select class="select" id="new-month">
      <option value="">${escapeHtml(t('settlement_pick_month'))}</option>
      ${monthOptions.map(function (month) {
        return `<option value="${escapeHtml(month)}">${escapeHtml(month)}</option>`;
      }).join('')}
    </select>`;
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
