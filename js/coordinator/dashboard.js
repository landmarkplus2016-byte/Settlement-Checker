/**
 * dashboard.js (coordinator) — "his settlements" (CLAUDE.md 5.1).
 *
 * One row per settlement — a team may hold several open at once — each carrying
 * an account and the TWO independent tracking numbers, with an Old and a New
 * status that move separately (rules 9 and 10). Every row opens its grid at
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
import { clearDraft } from '../state.js';

/** The settlements from the last load. */
let settlements = [];

/**
 * The active teams, fetched the first time the New-settlement dialog opens and
 * kept for the life of the screen. A settlement belongs to one of these and to
 * nothing else — the server resolves its id and its Tracking#s from the team's
 * counters — so it is a select, never free text.
 */
let teamOptions = null;

/**
 * What the Account box starts on.
 *
 * Every settlement so far has been VF, and retyping it on each new month is two
 * seconds of nothing. Prefilled, never forced — the field stays editable, so a
 * second account costs a retype rather than a code change.
 */
const DEFAULT_ACCOUNT = 'VF';

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

  // Bound once per mount, on the page element. The table below is re-rendered
  // into a child on every load, so delegation here never needs re-binding.
  page.addEventListener('click', function (event) {
    if (event.target.closest('[data-action="retry"]')) return load();
    if (event.target.closest('[data-action="new-settlement"]')) return openNewSettlement();

    const remove = event.target.closest('[data-action="delete-settlement"]');
    if (remove) return openDeleteSettlement(remove.dataset.settlementId);
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
 * The New-settlement dialog — two fields, Team and Account.
 *
 * A settlement is one coordinator's batch for one TEAM (rule 9), and it is the
 * container every entry hangs off — so this is the only door into the grid.
 *
 * There is no month, and no pair of tracking boxes. The month is gone because
 * every entry carries its own date and a batch that runs from 27 August to
 * 3 September is not an August settlement; the tracking boxes are gone because
 * the numbers now issue themselves at Confirm, from the team's own counter
 * (decision 6). Both used to be things a coordinator had to know before he could
 * start typing, and neither told him anything he did not already know.
 *
 * A team can hold as many open settlements as the coordinator needs: each gets
 * its own id from the team's sequence and its own pair of Tracking#s.
 */
async function openNewSettlement() {
  if (!teamOptions) {
    try {
      const data = await api.call('list_teams', {});
      teamOptions = ((data && data.teams) || []).filter(function (team) {
        return team.active;
      });
    } catch (err) {
      teamOptions = [];
    }
  }

  openModal({
    title: t('settlement_new'),
    confirmLabel: t('create'),

    bodyHtml: `
      <div class="field">
        <label class="label" for="new-team">${escapeHtml(t('col_team'))}</label>
        ${renderTeamControl()}
      </div>

      <div class="field">
        <label class="label" for="new-account">${escapeHtml(t('col_account'))}</label>
        <input class="input num" id="new-account" type="text" maxlength="40"
               value="${escapeHtml(DEFAULT_ACCOUNT)}"
               placeholder="${escapeHtml(t('settlement_account_placeholder'))}">
      </div>
    `,

    onConfirm: async function (ctx) {
      const teamId = ctx.value('#new-team');
      const account = ctx.value('#new-account');

      // Checked here only to save a round trip; Coordinator.gs validates both
      // again and owns the answer.
      if (!teamId) {
        ctx.setError(t('settlement_team_required'));
        return false;
      }
      if (!account) {
        ctx.setError(t('settlement_account_required'));
        return false;
      }

      const data = await api.call('create_settlement', {
        team_id: teamId,
        account: account
      });

      const created = data && data.settlement;
      if (!created) return;

      toastSuccess(t('settlement_created'));

      // Straight into the grid — creating a settlement and then hunting for its
      // row is a step with no purpose.
      location.hash = '#/settlement/' + encodeURIComponent(created.settlement_id);
    }
  });
}

/**
 * The team field — a select over the ACTIVE teams, never free text.
 *
 * A settlement's id is spelled out of its team's code (`S-MS-01`) and its
 * Tracking#s come out of that team's counter, so a team the app does not know is
 * not a settlement it can create. When there are no active teams at all the box
 * says so rather than offering an empty select: the answer is for a manager to
 * add one on Admin → Teams, which is not something the coordinator can do here.
 *
 * @return {string} HTML
 */
function renderTeamControl() {
  if (!teamOptions.length) {
    return `
      <select class="select" id="new-team" disabled>
        <option value="">${escapeHtml(t('settlement_pick_team'))}</option>
      </select>
      <div class="field-hint">${escapeHtml(t('settlement_no_teams'))}</div>`;
  }

  return `
    <select class="select" id="new-team">
      <option value="">${escapeHtml(t('settlement_pick_team'))}</option>
      ${teamOptions.map(function (team) {
        return `<option value="${escapeHtml(team.team_id)}">${escapeHtml(team.name)}</option>`;
      }).join('')}
    </select>`;
}

/* ------------------------------------------------------------------ *
 * Deleting a settlement
 * ------------------------------------------------------------------ */

/**
 * Can this settlement be deleted?
 *
 * The same rule the server enforces (handleDeleteSettlement): nothing in it may
 * have left the coordinator's hands. `draft` and `returned` are his; `confirmed`
 * and `approved` are with a manager; `exported` is in a finance file.
 *
 * Read from the roll-up already on screen, so no extra call is needed. The
 * server re-checks every entry under its lock and is the real gate — this only
 * decides whether to offer the button, exactly as the grid declines to give an
 * exported row a tick box (6.6.8). Offering a delete that will be refused is
 * worse than not offering one.
 *
 * @param {Object} settlement
 * @return {boolean}
 */
function isDeletable(settlement) {
  return ['old', 'new'].every(function (period) {
    const counts = settlement.tracks[period].counts;
    return !counts.confirmed && !counts.approved && !counts.exported;
  });
}

/** @param {Object} settlement @return {number} entries across both tracks. */
function entryCount(settlement) {
  return (settlement.tracks.old.total || 0) + (settlement.tracks.new.total || 0);
}

/**
 * Confirm and run `delete_settlement`.
 *
 * The local draft mirror is dropped on success and not before. `sc_draft_*`
 * outlives a sign-out by design (4.4), and a stale one is a grid that re-seeds
 * rows nobody asked for. Settlement ids now come from a counter that only moves
 * forwards, so a deleted id can never come back and collide — but the draft is
 * still dead weight on the device, and clearing it here is where it belongs.
 *
 * @param {string} settlementId
 */
function openDeleteSettlement(settlementId) {
  const settlement = settlements.find(function (row) {
    return row.settlement_id === settlementId;
  });
  if (!settlement) return;

  const count = entryCount(settlement);

  openModal({
    title: t('settlement_delete_title'),
    confirmLabel: t('delete'),
    confirmVariant: 'btn-danger',

    bodyHtml: `
      <div class="stack">
        <p class="text-small text-secondary">
          ${escapeHtml(t('settlement_delete_body', {
            settlement: settlement.settlement_id,
            count: count
          }))}
        </p>
        <p class="text-small text-muted">${escapeHtml(t('settlement_delete_note'))}</p>
      </div>
    `,

    onConfirm: async function () {
      await api.call('delete_settlement', { settlement_id: settlementId });

      clearDraft(settlementId, 'expense');
      clearDraft(settlementId, 'fuel');

      toastSuccess(t('settlement_deleted', { settlement: settlementId }));
      load();
    }
  });
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
            <th>${escapeHtml(t('col_team'))}</th>
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
      <td>${settlementLabel(settlement)}</td>
      <td class="num">${escapeHtml(settlement.account)}</td>
      ${trackCell(settlement.tracks.old, 'old')}
      ${trackCell(settlement.tracks.new, 'new')}
      <td class="col-actions">
        <div class="row-tight row-end">
          <a class="btn btn-secondary btn-sm" href="${href}">${escapeHtml(t('open'))}</a>
          ${isDeletable(settlement) ? `
            <button class="icon-btn icon-btn-danger" type="button"
                    data-action="delete-settlement"
                    data-settlement-id="${escapeHtml(settlement.settlement_id)}"
                    title="${escapeHtml(t('settlement_delete_title'))}"
                    aria-label="${escapeHtml(t('settlement_delete_title'))}">✕</button>
          ` : ''}
        </div>
      </td>
    </tr>
  `;
}

/**
 * What names a settlement in the list: its team.
 *
 * A settlement created before teams existed has no team and only a month, so it
 * falls back to showing that — it is still the only thing that names it, and the
 * coordinator has to be able to find it in order to set a team on it (which
 * Confirm now requires).
 *
 * @param {Object} settlement
 * @return {string} HTML
 */
function settlementLabel(settlement) {
  if (settlement.team) return escapeHtml(settlement.team);

  const month = escapeHtml(settlement.month);
  const year = escapeHtml(settlement.fiscal_year);

  return month
    ? `<span class="text-muted">${month} <span class="num">${year}</span></span>`
    : `<span class="text-muted">${escapeHtml(t('settlement_no_team'))}</span>`;
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
