/**
 * settlement.js — one coordinator-month, and the grid that fills it
 * (CLAUDE.md 5.1, 6.5).
 *
 * The header is the settlement itself: its month and account, and the TWO
 * tracking numbers. Those two are the reason this screen is shaped the way it
 * is. Old and new are parallel tracks (rule 10) that confirm, get approved and
 * export independently, so everything here comes in pairs — two tracking inputs,
 * two roll-up badges, two Confirm buttons — and nothing anywhere implies that
 * finishing one has anything to do with the other.
 *
 * Below that sits one grid at a time, Expenses or Fuel, hosted in `#grid-host`
 * and owned by grid.js. Both kinds are loaded up front so switching tab is
 * instant and the totals are the whole settlement's, not one tab's.
 *
 * Local-first (6.5): the grid mirrors to `sc_draft_<settlement_id>_<kind>` as
 * the coordinator types. On load this screen seeds from the server and then
 * overlays a newer draft on top — see mergeDraft(), which is where the care is.
 */

import { api } from '../api.js';
import { t, errorMessage } from '../i18n/i18n.js';
import { escapeHtml, qs, qsa, setBusy } from '../utils/dom.js';
import { getDraft } from '../state.js';
import { toNumber } from '../utils/validate.js';
import { toastSuccess, toastError, toastInfo } from '../components/toast.js';
import { renderLoading, renderLoadError } from '../components/table.js';
import {
  renderGrid, bindGridEvents, entryToRow, makeRow, gridColumns, rowToPayload,
  decorateGridModel, formatMoney, isRowLocked, isRowEmpty as isRowBlank
} from './grid.js';
import { loadSiteJcMap, makeAutofillHook } from './gridAutofill.js';
import { attachPaste, openPasteDialog } from './gridPaste.js';
import { runSave, runConfirm, trackReadiness, dropDraft } from './confirm.js';

/** The two grids, in tab order. */
const KINDS = ['expense', 'fuel'];

/** Everything this screen is holding. Reset by bindSettlementPageEvents(). */
let state = null;

/**
 * The grid controller that is currently alive, tracked OUTSIDE `state`.
 *
 * `state` is replaced wholesale on every mount, so a controller left over from
 * the previous one would be unreachable but still listening — leaking a
 * `beforeunload` listener per navigation and, worse, still able to mirror its
 * own stale rows over a newer draft. This reference is what lets a new mount
 * retire the old grid before building its own.
 */
let liveGrid = null;

/**
 * The settlement screen's shell.
 *
 * Rendered synchronously with a loading body, because the router paints a string
 * (5.3); bindSettlementPageEvents() fetches and fills it in.
 *
 * @param {string} settlementId from the route.
 * @return {string} HTML
 */
export function renderSettlementPage(settlementId) {
  return `
    <div class="page page-wide" id="settlement-page" data-settlement-id="${escapeHtml(settlementId)}">
      <div id="settlement-body">${renderLoading()}</div>
    </div>
  `;
}

/**
 * Load the settlement and wire the screen.
 * @param {string} settlementId
 */
export function bindSettlementPageEvents(settlementId) {
  const page = qs('#settlement-page');
  if (!page) return;

  // Retire any grid left over from a previous mount before building a new one.
  if (liveGrid) {
    liveGrid.destroy();
    liveGrid = null;
  }

  state = {
    settlementId: settlementId,
    settlement: null,
    kind: KINDS[0],
    grids: {},              // kind -> { rows }
    controller: null,
    reference: null,        // { projects, categories, areas, drivers, teams }
    referenceAvailable: false,
    siteJcMap: null,
    detachPaste: null,
    reports: {}
  };

  load();
}

/* ================================================================== *
 * Loading
 * ================================================================== */

/**
 * Fetch everything the screen needs, then paint it.
 *
 * @param {Object} [options]
 * @param {boolean} [options.keepReference] skip re-reading the teams, lists and
 *        site lookup. Set when reloading after a confirm: the settlement and the
 *        entries have moved, the shared configuration has not.
 */
async function load(options = {}) {
  const body = qs('#settlement-body');
  if (!body) return;

  body.innerHTML = renderLoading();

  try {
    /*
     * The roll-up comes from get_my_settlements rather than a per-settlement
     * action: 3.5 has no "get one settlement", and the roll-up it returns per
     * track is exactly what the header badges need.
     */
    const mine = await api.call('get_my_settlements', {});
    const settlement = (mine.settlements || []).find(function (row) {
      return row.settlement_id === state.settlementId;
    });

    if (!settlement) {
      body.innerHTML = renderLoadError(t('settlement_not_found_text'));
      return;
    }
    state.settlement = settlement;

    if (!options.keepReference || !state.siteJcMap) await loadReference();

    const [expense, fuel] = await Promise.all([
      api.call('list_entries', { settlement_id: state.settlementId, kind: 'expense' }),
      api.call('list_entries', { settlement_id: state.settlementId, kind: 'fuel' })
    ]);

    state.grids.expense = { rows: seedRows('expense', expense.entries || []) };
    state.grids.fuel = { rows: seedRows('fuel', fuel.entries || []) };

    paint();

  } catch (err) {
    body.innerHTML = renderLoadError(errorMessage(err));
    const retry = qs('[data-action="retry"]');
    if (retry) retry.addEventListener('click', load);
  }
}

/**
 * Fetch the reference data the grid needs: the dropdown option lists (6.6.4) and
 * the Site → Job Code lookup (6.6.3).
 *
 * All three are shared configuration, fetched once per screen, and none of them
 * is fatal. A failure leaves the grid working with free-text cells and no
 * autofill — which is exactly what a coordinator had before this screen existed
 * — rather than refusing to open the month's entries at all.
 */
async function loadReference() {
  // The lookup is cached for the session by gridAutofill, so this is a request
  // on first open and free afterwards.
  state.siteJcMap = await loadSiteJcMap();

  try {
    const [teams, lists] = await Promise.all([
      api.call('list_teams', { include_inactive: false }),
      api.call('list_lists', { include_inactive: false })
    ]);

    const groups = (lists && lists.lists) || {};
    const activeValues = function (name) {
      return (groups[name] || [])
        .filter(function (item) { return item.active !== false; })
        .map(function (item) { return item.value; });
    };

    state.reference = {
      teams: (teams.teams || [])
        .filter(function (team) { return team.active; })
        .map(function (team) { return team.name; }),
      projects: activeValues('projects'),
      categories: activeValues('categories'),
      areas: activeValues('areas'),
      drivers: activeValues('drivers')
    };
    state.referenceAvailable = true;

  } catch (err) {
    // Not shown to the coordinator: the grid degrades to free-text cells, which
    // is usable, and an error banner over a working screen is not.
    console.warn('Reference data unavailable: ' + (err && err.serverMessage));
    state.reference = null;
    state.referenceAvailable = false;
  }
}

/**
 * Seed one grid: server rows first, then a newer local draft laid over the top
 * (6.5).
 *
 * @param {string} kind
 * @param {Array<Object>} entries from `list_entries`.
 * @return {Array<Object>} grid rows.
 */
function seedRows(kind, entries) {
  const rows = entries.map(function (entry) { return entryToRow(kind, entry); });
  const draft = getDraft(state.settlementId, kind);

  if (!draft || !draft.rows || !draft.rows.length) return rows;
  if (!isDraftNewer(draft, entries)) return rows;

  return mergeDraft(kind, rows, draft.rows);
}

/**
 * Is the mirrored draft newer than what the server holds?
 *
 * Compared against the newest `updated_at` across the server's rows. If the
 * server has been written to since the draft was mirrored — a save from another
 * device, a manager's return — the server wins and the stale draft is dropped.
 *
 * @param {Object} draft
 * @param {Array<Object>} entries
 * @return {boolean}
 */
function isDraftNewer(draft, entries) {
  const draftAt = Date.parse(draft.saved_at || '');
  if (!isFinite(draftAt)) return false;

  let newest = 0;
  entries.forEach(function (entry) {
    const at = Date.parse(entry.updated_at || '');
    if (isFinite(at) && at > newest) newest = at;
  });

  return draftAt > newest;
}

/**
 * Lay a draft over the server's rows.
 *
 * Deliberately a MERGE and not a replacement. The draft holds what the
 * coordinator typed; the server holds what happened to those rows while they
 * were away — an approval, a return, an export. Taking the draft wholesale would
 * roll all of that back into whatever the browser last remembered.
 *
 * So, per row:
 *   - a saved row: the coordinator's typed values win, the server's status,
 *     approval and export state win.
 *   - an EXPORTED row: the server wins outright. It is locked (rule 13), and a
 *     draft that predates the export must not resurrect the old numbers.
 *   - a draft row with no entry_id: appended — it is work never saved anywhere.
 *   - a saved row missing from the draft: kept. The draft is not authority on
 *     what exists.
 *
 * @param {string} kind
 * @param {Array<Object>} serverRows
 * @param {Array<Object>} draftRows
 * @return {Array<Object>}
 */
function mergeDraft(kind, serverRows, draftRows) {
  const columns = gridColumns(kind).map(function (column) { return column.key; });

  const byId = {};
  serverRows.forEach(function (row) { if (row.entry_id) byId[row.entry_id] = row; });

  const merged = [];
  const used = {};

  draftRows.forEach(function (draftRow) {
    const id = draftRow.entry_id || '';

    if (!id) {
      const fresh = makeRow(kind, null);
      columns.forEach(function (key) { fresh[key] = draftRow[key] === undefined ? '' : draftRow[key]; });
      merged.push(fresh);
      return;
    }

    const serverRow = byId[id];
    if (!serverRow) return;             // deleted server-side while away

    used[id] = true;

    if (isRowLocked(serverRow)) {
      merged.push(serverRow);           // rule 13 — the export is the truth
      return;
    }

    columns.forEach(function (key) {
      if (draftRow[key] !== undefined) serverRow[key] = draftRow[key];
    });
    merged.push(serverRow);
  });

  // Anything the server has that the draft never mentioned stays, in its place.
  serverRows.forEach(function (row) {
    if (row.entry_id && !used[row.entry_id]) merged.push(row);
  });

  return merged;
}

/* ================================================================== *
 * Rendering
 * ================================================================== */

/** Paint the whole screen from `state`, then mount the grid. */
function paint() {
  const body = qs('#settlement-body');
  if (!body) return;

  body.innerHTML = renderBody();
  bindHeaderEvents();
  mountGrid();
  paintConfirmHints();
}

/** @return {string} HTML */
function renderBody() {
  const settlement = state.settlement;

  return `
    ${renderHeader(settlement)}

    <div class="card mt-4">
      <div class="grid-toolbar">
        <div class="tabs grid-tabs" role="tablist">
          ${KINDS.map(function (kind) {
            const active = kind === state.kind;
            return `
              <button class="tab${active ? ' is-active' : ''}" type="button" role="tab"
                      aria-selected="${active}" data-action="tab" data-kind="${kind}">
                ${escapeHtml(t('kind_' + kind))}
                <span class="tab-count num">${state.grids[kind].rows.length}</span>
              </button>
            `;
          }).join('')}
        </div>

        <span class="spacer"></span>

        <div class="grid-live-total">
          <span class="text-tiny text-muted">${escapeHtml(t('grid_total'))}</span>
          <span class="num text-bold" id="live-total">—</span>
        </div>

        <button class="btn btn-secondary btn-sm" type="button" data-action="paste">
          ${escapeHtml(t('paste_from_excel'))}
        </button>

        <button class="btn btn-secondary btn-sm" type="button" data-action="add-row">
          ${escapeHtml(t('grid_add_row'))}
        </button>
      </div>

      <div id="validation-banner"></div>

      <div id="grid-host"></div>
    </div>

    ${renderActions()}
  `;
}

/**
 * The settlement header.
 *
 * The two tracking numbers are editable here because this is where a coordinator
 * has them to hand. Each is disabled once its own track has exported rows (3.5):
 * renumbering a track finance has already been paid from would silently
 * re-label money that has left the building — and the other track stays open,
 * because they are independent.
 *
 * @param {Object} settlement
 * @return {string} HTML
 */
function renderHeader(settlement) {
  return `
    <div class="page-title-row">
      <div>
        <h1>${escapeHtml(settlement.month)} ${escapeHtml(settlement.fiscal_year)}</h1>
        <div class="page-subtitle">
          <span class="num">${escapeHtml(settlement.settlement_id)}</span>
          · ${escapeHtml(t('col_account'))}: <span class="num">${escapeHtml(settlement.account)}</span>
        </div>
      </div>
      <span class="spacer"></span>
      <a class="btn btn-ghost btn-sm" href="#/dashboard">${escapeHtml(t('back'))}</a>
    </div>

    <div class="track-row">
      ${['old', 'new'].map(function (period) { return renderTrackCard(settlement, period); }).join('')}
    </div>
  `;
}

/**
 * One track: its Tracking# input and its roll-up.
 * @param {Object} settlement
 * @param {string} period 'old' | 'new'
 * @return {string} HTML
 */
function renderTrackCard(settlement, period) {
  const track = settlement.tracks[period];
  const value = settlement[period + '_tracking_no'];
  const locked = track.has_exported;

  return `
    <div class="track-card is-${period}">
      <div class="track-head">
        <span class="badge badge-${period}">${escapeHtml(t('period_' + period))}</span>
        <span class="badge badge-${escapeHtml(track.status)}">${escapeHtml(t('track_status_' + track.status))}</span>
        <span class="spacer"></span>
        <span class="text-tiny text-muted">${escapeHtml(t('track_entry_count', { count: track.total }))}</span>
      </div>

      <div class="field">
        <label class="label" for="tracking-${period}">${escapeHtml(t('col_' + period + '_track'))}</label>
        <div class="row-tight">
          <input class="input num" id="tracking-${period}" type="text" inputmode="numeric"
                 data-tracking="${period}"
                 value="${value === null || value === undefined ? '' : escapeHtml(value)}"
                 ${locked ? 'readonly' : ''}
                 placeholder="${escapeHtml(t('tracking_placeholder'))}">
        </div>
        ${locked
          ? `<span class="field-hint">${escapeHtml(t('tracking_locked_hint'))}</span>`
          : ''}
      </div>

      <div class="track-counts text-tiny text-muted">
        ${['draft', 'confirmed', 'approved', 'returned', 'exported'].map(function (status) {
          const count = track.counts[status] || 0;
          if (!count) return '';
          return `<span class="track-count">${escapeHtml(t('entry_status_' + status))}: <b class="num">${count}</b></span>`;
        }).join('')}
      </div>
    </div>
  `;
}

/**
 * Save and the two Confirms.
 *
 * The Confirms stay ENABLED even when a track is not ready. A disabled button
 * tells a coordinator that something is wrong but not what, and the two reasons
 * — a blank Tracking#, rows still flagged — are both things he can go and fix.
 * Pressing it and being told which is more use than not being able to press it.
 *
 * @return {string} HTML
 */
function renderActions() {
  return `
    <div class="settlement-actions mt-4">
      <button class="btn btn-secondary" type="button" id="btn-save" data-action="save">
        ${escapeHtml(t('save_draft'))}
      </button>

      <span class="spacer"></span>

      ${['old', 'new'].map(function (period) {
        return `
          <div class="confirm-action">
            <button class="btn btn-primary" type="button" id="btn-confirm-${period}"
                    data-action="confirm" data-period="${period}">
              ${escapeHtml(t('confirm_' + period))}
            </button>
            <span class="confirm-hint text-tiny" id="confirm-hint-${period}"></span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/**
 * The one-line status under each Confirm button.
 *
 * Recomputed on every grid change, so the coordinator watches the reason
 * disappear as he fixes the last flagged row rather than finding out when he
 * presses the button.
 */
function paintConfirmHints() {
  ['old', 'new'].forEach(function (period) {
    const host = qs('#confirm-hint-' + period);
    if (!host) return;

    const readiness = trackReadiness(pageHandle(), period);
    const label = t('period_' + period);

    let text = '';
    let tone = '';

    if (readiness.reason === 'tracking') {
      text = t('confirm_hint_tracking');
      tone = 'is-blocked';
    } else if (readiness.reason === 'nothing') {
      text = t('confirm_hint_nothing');
      tone = 'is-quiet';
    } else if (readiness.reason === 'flags') {
      text = t('confirm_hint_flags', { rows: readiness.flaggedCount });
      tone = 'is-blocked';
    } else {
      text = t('confirm_hint_ready', { count: readiness.draftCount });
      tone = 'is-ready';
    }

    host.textContent = text;
    host.className = 'confirm-hint text-tiny ' + tone;
  });
}

/* ================================================================== *
 * The grid host
 * ================================================================== */

/** Render the active grid into `#grid-host` and hand it to grid.js. */
function mountGrid() {
  const host = qs('#grid-host');
  if (!host) return;

  // A tab switch retires the outgoing grid — flushing its draft on the way out.
  if (liveGrid) liveGrid.destroy();

  const model = decorateGridModel({
    settlementId: state.settlementId,
    kind: state.kind,
    rows: state.grids[state.kind].rows,
    reference: state.reference,
    siteJcMap: state.siteJcMap,

    // A row stores its month and day but not its year (2.2), and the Site→JC
    // picker needs a whole date to choose a job code by (6.6.3).
    fiscalYear: fiscalYear()
  });

  host.innerHTML = renderGrid(model);

  state.controller = bindGridEvents(model, {
    onChange: function (report) {
      state.reports[state.kind] = report;
      paintBanner(report);
      paintLiveTotal();
      paintTabCounts();

      // The Confirm hints track the flags live, so the reason a track cannot go
      // disappears as the last flagged row is fixed.
      paintConfirmHints();
    },

    // Site ID -> Job Code + period, on commit (6.6.3).
    onCellCommit: makeAutofillHook({
      getMap: function () { return state.siteJcMap; },
      getFiscalYear: fiscalYear,
      onResolved: function (row, result) {
        if (result.unknown.length) {
          toastError(t('autofill_unknown', { sites: result.unknown.join(', ') }));
        }

        // A site with several job codes got one of them by date; say so once,
        // rather than leaving the coordinator to notice the picker himself.
        if (result.options.length > 1) {
          toastInfo(t('autofill_multi_jc', {
            job_code: row.job_code,
            count: result.options.length
          }));
        }
      }
    }),

    onDeleteSaved: deleteSavedRow
  });

  // Paste from Excel (6.6.1). Detached with the grid it belongs to.
  if (state.detachPaste) state.detachPaste();
  state.detachPaste = attachPaste(host, pasteOptions());

  liveGrid = state.controller;
}

/**
 * The handle confirm.js works through.
 *
 * Passed rather than imported so the dependency runs one way: confirm.js knows
 * nothing about this screen's internals, and this screen does not have to export
 * its state to get its buttons wired.
 *
 * @return {Object}
 */
function pageHandle() {
  return {
    settlementId: state.settlementId,
    kinds: KINDS,

    settlement: function () { return state.settlement; },
    activeKind: function () { return state.kind; },
    rowsFor: function (kind) { return state.grids[kind].rows; },
    siteJcMap: function () { return state.siteJcMap; },

    /**
     * The rows of one grid, ready to send.
     *
     * The ACTIVE grid answers through its controller, which knows what is locked
     * and what is an untouched blank line. An inactive grid has no controller —
     * only one is mounted at a time — so its rows are filtered the same way here.
     */
    payloadRowsFor: function (kind) {
      if (kind === state.kind && state.controller) return state.controller.payloadRows();

      return state.grids[kind].rows
        .filter(function (row) {
          if (isRowLocked(row)) return false;
          return row.entry_id ? true : !isRowBlank(kind, row);
        })
        .map(function (row) { return rowToPayload(kind, row); });
    },

    flushDraft: function (kind) {
      if (kind === state.kind && state.controller) state.controller.flushMirror();
    },

    afterSave: onSaved,
    setBusy: setActionBusy,
    reload: function () { return load({ keepReference: true }); }
  };
}

/**
 * Take the server's answer as the new truth for one grid (3.5).
 *
 * This is not cosmetic. `save_entries` allocates an `entry_id` for every row it
 * creates, and a grid still holding id-less rows would create them all over
 * again on the next Save. It also carries back the statuses the server decided —
 * an approved row reverted to `confirmed` (rule 12), a returned row edited back
 * to `draft` — which the coordinator needs to see.
 *
 * The local draft is dropped LAST, after the grid has been rebuilt (6.5).
 * Rebuilding retires the outgoing controller, and retiring one flushes it, so
 * clearing any earlier would just have the old grid write its pre-save rows
 * straight back.
 *
 * @param {string} kind
 * @param {Object} result from `save_entries`.
 */
function onSaved(kind, result) {
  state.grids[kind].rows = (result.entries || []).map(function (entry) {
    return entryToRow(kind, entry);
  });

  if (kind === state.kind) {
    mountGrid();
    paintTabCounts();
    paintConfirmHints();
  }

  dropDraft(state.settlementId, kind);
}

/**
 * Put one action button into or out of its working state.
 * @param {string} which 'save' | 'old' | 'new'
 * @param {boolean} busy
 */
function setActionBusy(which, busy) {
  const isSave = which === 'save';
  const button = qs(isSave ? '#btn-save' : '#btn-confirm-' + which);
  if (!button) return;

  setBusy(
    button,
    busy,
    isSave ? t('save_draft') : t('confirm_' + which),
    isSave ? t('saving') : t('confirm_working')
  );

  // While one write is in flight, none of the others may start.
  qsa('.settlement-actions button').forEach(function (other) {
    if (other !== button) other.disabled = busy;
  });
}

/**
 * What both paste entry points need to do their work.
 * @return {Object}
 */
function pasteOptions() {
  return {
    getKind: function () { return state.kind; },
    getRows: function () { return state.grids[state.kind].rows; },
    getSiteJcMap: function () { return state.siteJcMap; },
    getFiscalYear: fiscalYear,
    onRows: onPastedRows
  };
}

/**
 * The settlement's fiscal year, which a grid row does not carry.
 *
 * A row stores a month label and a day number (2.2); the year lives once, on the
 * settlement. Putting the three together is what gives the Site→JC picker a date
 * to choose a job code by (6.6.3).
 *
 * @return {string} '' before the settlement has loaded.
 */
function fiscalYear() {
  return (state.settlement && state.settlement.fiscal_year) || '';
}

/**
 * Append what a paste produced (6.6.1).
 *
 * The rows go in as ordinary drafts and are validated like any other — a pasted
 * row with no amount goes red exactly as a typed one does.
 *
 * @param {{rows: Array<Object>, skippedHeader: boolean, unknownSites: Array<string>,
 *          truncated: number}} result
 */
function onPastedRows(result) {
  if (!state.controller) return;

  state.controller.addRows(result.rows);

  toastSuccess(t('paste_added', { count: result.rows.length }));

  if (result.skippedHeader) toastSuccess(t('paste_header_skipped'));
  if (result.truncated) toastError(t('paste_truncated', { count: result.truncated }));
  if (result.unknownSites.length) {
    toastError(t('autofill_unknown', { sites: result.unknownSites.join(', ') }));
  }
}

/**
 * A row that exists on the server was deleted from the grid.
 *
 * `delete_entry` is the only hard delete in the app and only accepts a `draft`
 * row (rule 9.3), which is why the grid offers the button on draft rows alone.
 * If the server refuses, the row is put back — the grid must not show a row as
 * gone when it is not.
 *
 * @param {Object} row
 */
async function deleteSavedRow(row) {
  try {
    await api.call('delete_entry', {
      settlement_id: state.settlementId,
      kind: state.kind,
      entry_id: row.entry_id
    });
    toastSuccess(t('grid_row_deleted'));

  } catch (err) {
    toastError(errorMessage(err));

    state.grids[state.kind].rows.push(row);
    if (state.controller) state.controller.rerender();
  }
}

/* ================================================================== *
 * The live pieces — banner, total, counts
 * ================================================================== */

/**
 * The validation banner.
 *
 * Grouped by code with a count, not one line per row: "4 rows have no amount" is
 * a thing a coordinator can act on, and four identical sentences is not. Each
 * line jumps to the first row it is about.
 *
 * @param {Object} report from validateRows().
 */
function paintBanner(report) {
  const host = qs('#validation-banner');
  if (!host) return;

  const codes = Object.keys(report.byCode);

  if (!codes.length) {
    host.innerHTML = state.grids[state.kind].rows.length
      ? `<div class="grid-banner is-clean">${escapeHtml(t('grid_all_clear'))}</div>`
      : '';
    return;
  }

  // Flags first: they are what stops a Confirm.
  codes.sort(function (a, b) {
    const levelA = report.byCode[a].level === 'flag' ? 0 : 1;
    const levelB = report.byCode[b].level === 'flag' ? 0 : 1;
    if (levelA !== levelB) return levelA - levelB;
    return report.byCode[b].count - report.byCode[a].count;
  });

  const flagged = report.flagCount > 0;

  host.innerHTML = `
    <div class="grid-banner ${flagged ? 'is-flagged' : 'is-warned'}">
      <div class="grid-banner-head">
        ${escapeHtml(flagged
          ? t('grid_banner_blocked', { rows: report.flaggedRows.length })
          : t('grid_banner_warnings', { count: report.warningCount }))}
      </div>
      <ul class="grid-banner-list">
        ${codes.map(function (code) {
          const issue = report.byCode[code];
          return `
            <li>
              <button type="button" class="grid-issue is-${escapeHtml(issue.level)}"
                      data-action="goto-row" data-row="${issue.firstRow}">
                <span class="grid-issue-dot" aria-hidden="true"></span>
                ${escapeHtml(t('valid_' + code))}
                <span class="grid-issue-count num">${issue.count}</span>
              </button>
            </li>
          `;
        }).join('')}
      </ul>
    </div>
  `;
}

/** The header's running total for the active grid. */
function paintLiveTotal() {
  const el = qs('#live-total');
  if (!el) return;

  const rows = state.grids[state.kind].rows;
  const field = state.kind === 'fuel' ? 'fuel_amount' : 'amount';

  const total = rows.reduce(function (sum, row) {
    return sum + (toNumber(row[field]) || 0);
  }, 0);

  el.textContent = formatMoney(total);
}

/** Keep the tab chips' row counts honest as rows are added and deleted. */
function paintTabCounts() {
  qsa('[data-action="tab"]').forEach(function (tab) {
    const count = tab.querySelector('.tab-count');
    if (count) count.textContent = String(state.grids[tab.dataset.kind].rows.length);
  });
}

/* ================================================================== *
 * Header events
 * ================================================================== */

/** Wire everything outside the grid itself. */
function bindHeaderEvents() {
  const body = qs('#settlement-body');
  if (!body) return;

  body.addEventListener('click', function (event) {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;

    const action = trigger.dataset.action;

    if (action === 'tab') return switchKind(trigger.dataset.kind);
    if (action === 'add-row' && state.controller) return state.controller.addRow();
    if (action === 'paste') return openPasteDialog(pasteOptions());
    if (action === 'goto-row') return gotoRow(Number(trigger.dataset.row));

    // The only two things on this screen that write to the sheet (3.5).
    if (action === 'save') return runSave(pageHandle());
    if (action === 'confirm') return runConfirm(pageHandle(), trigger.dataset.period);
  });

  // A tracking number is committed on change, not per keystroke — it is a header
  // field, not a grid cell.
  qsa('[data-tracking]', body).forEach(function (input) {
    input.addEventListener('change', function () { saveTracking(input); });
  });
}

/**
 * Switch between the Expenses and Fuel grids.
 *
 * The outgoing grid's draft is flushed first: 6.5's promise is that typing is
 * never lost, and a tab switch is exactly the moment a coordinator would expect
 * it to hold.
 *
 * @param {string} kind
 */
function switchKind(kind) {
  if (!kind || kind === state.kind || KINDS.indexOf(kind) === -1) return;

  if (state.controller) state.controller.flushMirror();

  state.kind = kind;
  paint();
}

/**
 * Scroll to and focus the first row an issue is about.
 * @param {number} index
 */
function gotoRow(index) {
  const host = qs('#grid-host');
  if (!host || !isFinite(index)) return;

  const row = qsa('#grid-body tr.grid-row', host)[index];
  if (!row) return;

  row.scrollIntoView({ block: 'center', behavior: 'smooth' });

  const firstCell = row.querySelector('.grid-cell.is-flagged [data-field], .grid-cell.is-warned [data-field]');
  if (firstCell) firstCell.focus();
}

/**
 * Store one track's Tracking#.
 *
 * `update_settlement` refuses to renumber a track that already has exported rows
 * (3.5); the input is read-only in that case, but the server is the gate and a
 * refusal here puts the old value back rather than leaving a number on screen
 * that was never stored.
 *
 * @param {HTMLInputElement} input
 */
async function saveTracking(input) {
  const period = input.dataset.tracking;
  const raw = String(input.value || '').trim();

  const previous = state.settlement[period + '_tracking_no'];
  const previousText = (previous === null || previous === undefined) ? '' : String(previous);
  if (raw === previousText) return;

  if (raw && (toNumber(raw) === null || toNumber(raw) <= 0 || toNumber(raw) % 1 !== 0)) {
    toastError(t('tracking_invalid'));
    input.value = previousText;
    return;
  }

  input.disabled = true;

  try {
    const payload = { settlement_id: state.settlementId };
    payload[period + '_tracking_no'] = raw === '' ? '' : toNumber(raw);

    const result = await api.call('update_settlement', payload);

    // Keep the roll-up the header renders from, so a later repaint agrees.
    state.settlement[period + '_tracking_no'] = result.settlement[period + '_tracking_no'];
    state.settlement.tracks[period].tracking_no = result.settlement[period + '_tracking_no'];
    state.settlement.tracks[period].tracking_no_set =
      result.settlement[period + '_tracking_no'] !== null;

    toastSuccess(t('tracking_saved'));

  } catch (err) {
    toastError(errorMessage(err));
    input.value = previousText;

  } finally {
    input.disabled = false;
  }
}
