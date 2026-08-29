/**
 * export.js — the export builder (CLAUDE.md 3.7, 7, rules 15–18).
 *
 * A manager picks a team, a month and a report type; the screen fetches the
 * approved rows for BOTH periods, previews each as the finance file it will
 * become, and offers Download and Confirm.
 *
 * The shape of this screen follows the shape of the guarantee behind it:
 *
 *   - **Old and new are two files, side by side.** They run the lifecycle
 *     independently (rule 10) and carry their own Tracking# (6.2), so they are
 *     queried, previewed, downloaded and committed separately. Neither waits on
 *     the other, and nothing on this screen lets them be confused.
 *   - **The file always comes before the claim.** Downloading is free and
 *     repeatable — nothing server-side happens. Confirming is `export_commit`,
 *     which stamps the rows `exported` (rule 13): irreversible, and they never
 *     appear in a query again. So Confirm DOWNLOADS the file itself when the
 *     manager has not already taken it, and only claims the rows once that has
 *     succeeded. The two buttons are still separate acts — a manager may want
 *     the file and not the claim — but there is no order of clicks that ends in
 *     exported rows and no file.
 *   - **The preview is the file.** Both are rendered from one document model
 *     (exportTemplate.js), including the per-site explosion (6.4). What the
 *     manager reads on screen is what lands in finance's inbox.
 *   - **Changing the filter throws the preview away.** `export_commit` takes a
 *     predicate, not a row list — it re-selects server-side (rule 16). A preview
 *     left on screen after its filter changed would let a manager commit
 *     something he never looked at.
 *
 * Changing the REPORT TYPE does not refetch: it is a pure re-rendering of rows
 * already in hand, and an Apps Script round trip across every coordinator's
 * spreadsheet is seconds of waiting for a transform the client can do itself.
 */

import { api } from '../api.js';
import { t, errorMessage, getLang, isRtl } from '../i18n/i18n.js';
import { escapeHtml, qs } from '../utils/dom.js';
import { formatDateTime } from '../utils/dates.js';
import { formatMoney } from '../utils/money.js';
import { openModal } from '../components/modal.js';
import { toastSuccess, toastError } from '../components/toast.js';
import { renderLoading, renderLoadError, renderEmpty, renderPeriodBadge } from '../components/table.js';
import { downloadWorkbook, isXlsxAvailable, SheetError } from '../utils/xlsx.js';
import { buildExportDocument, documentToSheets } from './exportTemplate.js';

/** The two tracks, in the order the screen shows them. */
const PERIODS = ['old', 'new'];

/** Rows shown per sheet in the preview. The FILE always gets every row. */
const PREVIEW_ROWS = 40;

/** How many past batches the log shows (Export.gs caps at 200). */
const LOG_LIMIT = 50;

/* ------------------------------------------------------------------ *
 * Screen state
 * ------------------------------------------------------------------ */

/** The selection. `team` and `month` are required by `export_query`. */
let filter = { team: '', month: '', report_type: 'normal', exclude_exported: true };

/**
 * Per period: the raw `export_query` response, the document built from it, the
 * error if the query failed, and whether the file has been downloaded since it
 * was last generated.
 */
let periods = emptyPeriods();

/** True once Generate has run, so the screen knows to show panels at all. */
let generated = false;

/** True while the two queries are in flight. */
let generating = false;

/** Reference data for the two required selects. */
let teams = [];
let months = [];

/** The ExportLog, newest first (7.3). */
let log = [];
let logError = '';

/* ================================================================== *
 * Render
 * ================================================================== */

/**
 * The Export screen.
 * @return {string} HTML
 */
export function renderExport() {
  return `
    <div class="page" id="export-page">
      <div class="page-title-row">
        <div>
          <h1>${escapeHtml(t('nav_export'))}</h1>
          <div class="page-subtitle">${escapeHtml(t('export_subtitle'))}</div>
        </div>
      </div>

      <div class="card card-padded">
        <div class="toolbar" id="export-filters">${renderFilters()}</div>
      </div>

      <div id="export-results">${renderStartState()}</div>

      <div class="card mt-4">
        <div class="card-header">
          <span class="card-title">${escapeHtml(t('export_log_title'))}</span>
          <span class="spacer"></span>
          <span class="text-tiny text-muted">${escapeHtml(t('export_log_subtitle'))}</span>
        </div>
        <div id="export-log">${renderLoading()}</div>
      </div>
    </div>
  `;
}

/**
 * Wire the screen.
 *
 * One delegated click listener and one delegated change listener, attached once.
 * Every repaint replaces the toolbar, the results block or the log — never the
 * page — so nothing is re-bound and nothing leaks.
 */
export function bindExportEvents() {
  const page$ = qs('#export-page');
  if (!page$) return;

  filter = { team: '', month: '', report_type: 'normal', exclude_exported: true };
  periods = emptyPeriods();
  generated = false;
  generating = false;
  teams = [];
  months = [];
  log = [];
  logError = '';

  page$.addEventListener('click', function (event) {
    const trigger = event.target.closest('[data-action]');
    if (!trigger || trigger.disabled) return;

    const action = trigger.dataset.action;
    const period = trigger.dataset.period || '';

    if (action === 'generate') return generate();

    /*
     * renderLoadError() always emits `data-action="retry"`, and this screen has
     * two things that can fail: a period's query and the log. Which one the
     * button belongs to is decided by where it is, not by a second attribute the
     * shared component does not know how to write.
     */
    if (action === 'retry') {
      return trigger.closest('#export-log') ? loadLog() : generate();
    }

    if (action === 'download') return download(period);
    if (action === 'confirm-export') return confirmExport(period);
  });

  page$.addEventListener('change', function (event) {
    const control = event.target.closest('[data-filter]');
    if (!control) return;

    const key = control.dataset.filter;

    if (key === 'exclude_exported') {
      filter.exclude_exported = !!control.checked;
      invalidate();
      return;
    }

    filter[key] = String(control.value || '');

    /*
     * The report type is a rendering choice over rows already fetched — the
     * server's selection does not depend on it (3.7). Rebuild locally rather
     * than making the manager wait for another sweep of every coordinator sheet.
     */
    if (key === 'report_type') {
      rebuildDocuments();
      paintResults();
      return;
    }

    invalidate();
  });

  loadReference();
  loadLog();
}

/** @return {Object} the per-period state, cleared. */
function emptyPeriods() {
  return {
    old: { query: null, doc: null, error: '', downloaded: false, busy: false },
    new: { query: null, doc: null, error: '', downloaded: false, busy: false }
  };
}

/**
 * Throw away a generated preview because the selection changed.
 *
 * See the file header: the commit re-selects server-side, so a preview whose
 * filter has moved on is a preview of something the manager can no longer
 * commit — and would be committing blind if he tried.
 */
function invalidate() {
  periods = emptyPeriods();
  generated = false;

  // The button, not the whole toolbar: repainting the bar would replace the
  // <select> the manager just used and take the focus off it mid-run.
  paintGenerateButton();
  paintResults();
}

/* ================================================================== *
 * Data
 * ================================================================== */

/**
 * The two required selects.
 *
 * Failures are swallowed, as on the approvals screen: this is the furniture
 * around the real work, and a manager who knows the team name can still be given
 * the list once it arrives. Unlike approvals, though, there is no "all" option —
 * an export is one team and one month (7.1).
 */
async function loadReference() {
  const [teamData, listData] = await Promise.all([
    api.call('list_teams', { include_inactive: true }).catch(nullOnError),
    api.call('list_lists', { list_name: 'months' }).catch(nullOnError)
  ]);

  // Inactive teams stay in the list: entries already filed under a team keep it
  // (2.1), so a team deactivated mid-month still has a file to export.
  teams = (teamData && teamData.teams) || [];

  months = ((listData && listData.lists && listData.lists.months) || [])
    .map(function (option) { return option.value; });

  repaintFilters();
}

/** @param {*} err @return {null} */
function nullOnError(err) {
  console.warn('Export reference data unavailable: ' + (err && err.message));
  return null;
}

/**
 * Query both periods and build both documents.
 *
 * The two calls run together and fail independently: an old track that errors
 * must not hide a new track that is ready to go out. Each panel shows its own
 * result or its own reason.
 */
async function generate() {
  if (generating || !canGenerate()) return;

  generating = true;
  periods = emptyPeriods();
  generated = true;
  paintGenerateButton();
  paintResults();

  const results = await Promise.all(PERIODS.map(function (period) {
    return api.call('export_query', {
      team: filter.team,
      month: filter.month,
      period: period,
      exclude_exported: filter.exclude_exported
    }).then(
      function (data) { return { period: period, data: data }; },
      function (err) { return { period: period, error: errorMessage(err) }; }
    );
  }));

  results.forEach(function (result) {
    const state = periods[result.period];
    state.query = result.data || null;
    state.error = result.error || '';
    state.downloaded = false;
  });

  rebuildDocuments();

  generating = false;
  paintGenerateButton();
  paintResults();
}

/**
 * Rebuild both documents from whatever queries are in hand.
 *
 * Called after a fetch and after a report-type change — the per-site explosion
 * (6.4) happens inside buildExportDocument(), so switching to Per-site is this
 * one call and a repaint.
 */
function rebuildDocuments() {
  PERIODS.forEach(function (period) {
    const state = periods[period];

    state.doc = state.query
      ? buildExportDocument({
          query: state.query,
          period: period,
          team: filter.team,
          month: filter.month,
          reportType: filter.report_type
        })
      : null;
  });
}

/** Load the ExportLog (7.3). */
async function loadLog() {
  const host = qs('#export-log');
  if (host) host.innerHTML = renderLoading();

  try {
    const data = await api.call('list_export_log', { limit: LOG_LIMIT });
    log = (data && data.batches) || [];
    logError = '';
  } catch (err) {
    log = [];
    logError = errorMessage(err);
  }

  paintLog();
}

/* ================================================================== *
 * Actions
 * ================================================================== */

/**
 * Build the .xlsx and hand it to the browser (7.2).
 *
 * Nothing server-side happens here. A manager can download the same file as many
 * times as he likes, before or after committing — it is only paper until
 * `export_commit` claims the rows.
 *
 * It THROWS rather than reporting, because it has two callers with opposite
 * needs: the Download button, which only has to say what went wrong, and the
 * commit, which must not claim rows when the file it is claiming them for could
 * not be produced.
 *
 * @param {string} period 'old' | 'new'
 * @return {string} the file name handed to the browser.
 * @throws {SheetError} xlsx_unavailable | export_no_sheets | export_write_failed
 */
function buildAndDownload(period) {
  const state = periods[period];
  if (!state || !state.doc || !state.doc.has_rows) throw new SheetError('export_no_sheets');
  if (!isXlsxAvailable()) throw new SheetError('xlsx_unavailable');

  const name = downloadWorkbook(
    documentToSheets(state.doc),
    state.doc.file_name,
    // The whole workbook opens right-to-left in Arabic; the numbers inside it
    // stay Western and LTR either way (8.1).
    { rtl: isRtl() }
  );

  // Read by the confirm dialog, which uses it to decide whether the file still
  // has to be produced — nothing on the panel changes, so nothing is repainted.
  state.downloaded = true;

  return name;
}

/**
 * The Download button.
 * @param {string} period 'old' | 'new'
 */
function download(period) {
  const state = periods[period];
  if (!state || !state.doc || !state.doc.has_rows) return;

  try {
    toastSuccess(t('export_downloaded', { file: buildAndDownload(period) }));
  } catch (err) {
    toastError(errorMessage(err));
  }
}

/**
 * Commit one period — the atomic claim (rule 16).
 *
 * Behind a dialog because there is no undo: the rows are stamped `exported` and
 * locked (rule 13), and the only way back is the developer editing the sheet.
 * The dialog says how many rows, which Tracking#, and — when the file has not
 * been taken yet — that confirming will download it before claiming anything.
 *
 * @param {string} period 'old' | 'new'
 */
function confirmExport(period) {
  const state = periods[period];
  if (!state || !state.doc || !canCommit(state)) return;

  const doc = state.doc;
  const count = doc.claimable;

  openModal({
    title: t('export_confirm_title'),
    confirmLabel: t('export_confirm_button', { count: count }),

    bodyHtml: `
      <p class="text-small text-secondary">
        ${escapeHtml(t('export_confirm_text', {
          count: count,
          team: doc.team,
          month: doc.month,
          period: t('period_' + period)
        }))}
      </p>

      <div class="alert alert-info mt-4">
        ${escapeHtml(t('export_confirm_tracking', {
          tracking: doc.tracking_no || t('tracking_placeholder'),
          type: t('export_report_' + doc.report_type)
        }))}
      </div>

      ${state.downloaded ? '' : `
        <div class="alert alert-info mt-4">
          ${escapeHtml(t('export_confirm_not_downloaded'))}
        </div>
      `}

      <p class="text-tiny text-muted mt-4">${escapeHtml(t('export_confirm_note'))}</p>
    `,

    onConfirm: async function () {
      /*
       * The file FIRST, and only then the claim.
       *
       * Confirming used to claim the rows and leave the manager to remember the
       * Download button separately, which is a trap: the claim is irreversible
       * (rule 13) and it removes the rows from every future query, so a confirm
       * without a download produced an exported batch with no file to send —
       * recoverable only by turning "hide already-exported" off and rebuilding
       * it. Building here throws on failure, which keeps the dialog open and
       * leaves every row untouched.
       *
       * It also runs before the first await on purpose: the browser still counts
       * this as the user gesture that submitted the form, and a download started
       * after an await can be blocked.
       */
      if (!state.downloaded) {
        toastSuccess(t('export_downloaded', { file: buildAndDownload(period) }));
      }

      const data = await api.call('export_commit', {
        team: filter.team,
        month: filter.month,
        period: period,
        report_type: filter.report_type
      });

      const rows = (data && data.row_count) || 0;

      /*
       * Zero claimed is not a failure. It is what the second of two racing
       * commits sees, and what a second click sees — the mechanism working, not
       * a reason to alarm anybody.
       */
      if (rows) {
        toastSuccess(t('export_committed', { count: rows, batch: (data && data.batch_id) || '' }));
      } else {
        toastSuccess(t('export_commit_nothing'));
      }

      // Re-query this period only: the other track is untouched by this claim
      // (rule 10), and re-running its sweep would cost seconds for nothing.
      await requery(period);
      loadLog();
    }
  });
}

/**
 * Re-run one period's query after a commit, so the panel shows what is actually
 * left rather than what was there a moment ago.
 *
 * @param {string} period 'old' | 'new'
 */
async function requery(period) {
  const state = periods[period];
  state.busy = true;
  paintResults();

  try {
    state.query = await api.call('export_query', {
      team: filter.team,
      month: filter.month,
      period: period,
      exclude_exported: filter.exclude_exported
    });
    state.error = '';
  } catch (err) {
    state.query = null;
    state.error = errorMessage(err);
  }

  state.downloaded = false;
  state.busy = false;

  rebuildDocuments();
  paintResults();
}

/* ================================================================== *
 * Painting
 * ================================================================== */

/**
 * The toolbar, rebuilt with whatever reference data has arrived.
 *
 * Only called when the OPTIONS change — the team and month lists landing. Every
 * other update goes through paintGenerateButton(), which leaves the selects
 * alone.
 */
function repaintFilters() {
  const host = qs('#export-filters');
  if (host) host.innerHTML = renderFilters();
}

/** Update Generate's label and enabled state in place. */
function paintGenerateButton() {
  const button = qs('#export-page [data-action="generate"]');
  if (!button) return;

  const enabled = canGenerate() && !generating;

  button.disabled = !enabled;
  button.textContent = generating ? t('export_generating') : t('export_generate');
  button.title = canGenerate() ? '' : t('export_needs_team_month');
}

/** The two period panels, or the state that stands in for them. */
function paintResults() {
  const host = qs('#export-results');
  if (!host) return;

  if (generating) {
    host.innerHTML = `<div class="card">${renderLoading()}</div>`;
    return;
  }

  host.innerHTML = generated ? renderPanels() : renderStartState();
}

/** The ExportLog table. */
function paintLog() {
  const host = qs('#export-log');
  if (host) host.innerHTML = renderLog();
}

/* ------------------------------------------------------------------ *
 * The toolbar
 * ------------------------------------------------------------------ */

/**
 * Team, month, report type, exclude-exported, Generate.
 * @return {string} HTML
 */
function renderFilters() {
  return `
    ${renderSelect('team', t('export_pick_team'), teams.map(function (team) {
      return { value: team.name, label: team.name + (team.active ? '' : ' · ' + t('inactive')) };
    }))}

    ${renderSelect('month', t('export_pick_month'), months.map(function (month) {
      return { value: month, label: month };
    }))}

    ${renderSelect('report_type', '', [
      { value: 'normal', label: t('export_report_normal') },
      { value: 'persite', label: t('export_report_persite') }
    ], true)}

    <label class="check-row" title="${escapeHtml(t('export_exclude_exported_hint'))}">
      <input type="checkbox" data-filter="exclude_exported"
             ${filter.exclude_exported ? 'checked' : ''}>
      <span>${escapeHtml(t('export_exclude_exported'))}</span>
    </label>

    <span class="spacer"></span>

    <button class="btn btn-primary" type="button" data-action="generate"
            ${canGenerate() && !generating ? '' : 'disabled'}
            title="${escapeHtml(canGenerate() ? '' : t('export_needs_team_month'))}">
      ${escapeHtml(generating ? t('export_generating') : t('export_generate'))}
    </button>
  `;
}

/**
 * One toolbar select.
 *
 * @param {string} name a key of `filter`.
 * @param {string} placeholder already translated; '' renders no placeholder
 *        option, for a select that always has a value.
 * @param {Array<{value: string, label: string}>} options
 * @param {boolean} [noPlaceholder=false]
 * @return {string} HTML
 */
function renderSelect(name, placeholder, options, noPlaceholder) {
  const current = filter[name] || '';

  return `
    <select class="select toolbar-select" data-filter="${escapeHtml(name)}"
            aria-label="${escapeHtml(placeholder || t('export_report_type'))}">
      ${noPlaceholder ? '' : `<option value="">${escapeHtml(placeholder)}</option>`}
      ${options.map(function (option) {
        const selected = option.value === current ? ' selected' : '';
        return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
      }).join('')}
    </select>
  `;
}

/** @return {boolean} both required fields chosen (3.7). */
function canGenerate() {
  return !!(filter.team && filter.month);
}

/* ------------------------------------------------------------------ *
 * The period panels
 * ------------------------------------------------------------------ */

/**
 * Before anything has been generated.
 * @return {string} HTML
 */
function renderStartState() {
  return `
    <div class="card">
      ${renderEmpty(t('export_start_title'), t('export_start_text'), '⇩')}
    </div>
  `;
}

/**
 * Both periods, old first.
 * @return {string} HTML
 */
function renderPanels() {
  return PERIODS.map(renderPanel).join('');
}

/**
 * One period: its warnings, its preview, and its two buttons.
 *
 * @param {string} period 'old' | 'new'
 * @return {string} HTML
 */
function renderPanel(period) {
  const state = periods[period];
  const doc = state.doc;

  const head = `
    <div class="card-header">
      ${renderPeriodBadge(period)}
      <span class="card-title">${escapeHtml(t('export_period_file', { period: t('period_' + period) }))}</span>
      <span class="spacer"></span>
      ${doc && doc.tracking_no
        ? `<span class="cell-line">
             <span class="text-tiny text-muted">${escapeHtml(t('col_tracking'))}</span>
             <span class="num text-bold">${escapeHtml(doc.tracking_no)}</span>
           </span>`
        : `<span class="text-tiny text-muted">${escapeHtml(t('tracking_placeholder'))}</span>`}
    </div>
  `;

  if (state.busy) {
    return `<div class="card mt-4">${head}${renderLoading()}</div>`;
  }

  if (state.error) {
    return `<div class="card mt-4">${head}${renderLoadError(state.error)}</div>`;
  }

  if (!doc || !doc.has_rows) {
    return `
      <div class="card mt-4">
        ${head}
        ${renderEmpty(t('export_nothing_title'), t('export_nothing_text'), '—')}
      </div>
    `;
  }

  return `
    <div class="card mt-4">
      ${head}

      <div class="card-body">
        ${renderPanelWarnings(period, state, doc)}
        ${doc.sheets.map(renderTemplate).join('')}
      </div>

      <div class="card-footer">
        <span class="text-tiny text-muted">
          ${escapeHtml(t('export_rows_summary', {
            rows: doc.row_count,
            claimable: doc.claimable
          }))}
        </span>

        <!-- The file name is Latin and stays LTR inside an Arabic line (8.1). -->
        <span class="text-tiny text-muted num">${escapeHtml(doc.file_name)}</span>

        <span class="spacer"></span>

        <button class="btn btn-secondary" type="button"
                data-action="download" data-period="${escapeHtml(period)}">
          ${escapeHtml(t('export_download'))}
        </button>

        <button class="btn btn-primary" type="button"
                data-action="confirm-export" data-period="${escapeHtml(period)}"
                ${canCommit(state) ? '' : 'disabled'}
                title="${escapeHtml(canCommit(state) ? '' : commitBlockedReason(state))}">
          ${escapeHtml(t('export_confirm'))}
        </button>
      </div>
    </div>
  `;
}

/**
 * Everything the manager needs to know before he commits this period.
 *
 * None of these are hidden or softened. Each one changes what the file means or
 * whether the claim will go through at all.
 *
 * @param {string} period
 * @param {Object} state
 * @param {Object} doc
 * @return {string} HTML
 */
function renderPanelWarnings(period, state, doc) {
  const query = state.query || {};
  const header = query.header || {};
  const out = [];

  // A coordinator's sheet could not be read: rows are missing from this preview,
  // and `export_commit` will refuse rather than claim a partial batch.
  const unreadable = (query.errors || []).concat(query.skipped || []);
  if (unreadable.length) {
    out.push(renderAlert('danger', t('export_sweep_incomplete', {
      names: unreadable.map(function (problem) { return problem.user_id; }).join(t('list_separator'))
    })));
  }

  // A settlement with no Tracking# for this period. The commit refuses it: the
  // footer would go out blank, and the number cannot be corrected afterwards.
  const missing = header.missing_tracking || [];
  if (missing.length) {
    out.push(renderAlert('danger', t('export_no_tracking', {
      settlements: missing.map(function (item) { return item.settlement_id; }).join(t('list_separator'))
    })));
  }

  // Two coordinators on the same team with different numbers for one period.
  if ((header.tracking_numbers || []).length > 1) {
    out.push(renderAlert('warning', t('export_tracking_conflict', {
      numbers: (header.tracking_numbers || []).join(t('list_separator'))
    })));
  }

  // Rows that already went out, showing only because exclude-exported is off.
  if (doc.already_exported) {
    out.push(renderAlert('info', t('export_already_exported', { count: doc.already_exported })));
  }

  // Everything here has been exported already; there is nothing left to claim.
  if (!doc.claimable && doc.row_count) {
    out.push(renderAlert('info', t('export_claimable_zero')));
  }

  if (!out.length) return '';
  return `<div class="tpl-warnings">${out.join('')}</div>`;
}

/**
 * @param {string} variant 'info' | 'warning' | 'danger'
 * @param {string} message already translated.
 * @return {string} HTML
 */
function renderAlert(variant, message) {
  return `<div class="alert alert-${variant}">${escapeHtml(message)}</div>`;
}

/**
 * Can this period be committed?
 *
 * Mirrors what `export_commit` will do, so the button does not offer a call that
 * is going to be refused (Export.gs: unreadable sheet, missing Tracking#,
 * nothing claimable).
 *
 * @param {Object} state
 * @return {boolean}
 */
function canCommit(state) {
  return !commitBlockedReason(state);
}

/**
 * Why Confirm is disabled, as a tooltip.
 * @param {Object} state
 * @return {string} '' when it is enabled.
 */
function commitBlockedReason(state) {
  const doc = state.doc;
  if (!doc || !doc.has_rows) return t('export_nothing_title');
  if (!doc.claimable) return t('export_claimable_zero');

  const header = (state.query && state.query.header) || {};
  if ((header.missing_tracking || []).length) return t('export_blocked_tracking');

  const query = state.query || {};
  if ((query.errors || []).concat(query.skipped || []).length) return t('export_blocked_sweep');

  return '';
}

/* ------------------------------------------------------------------ *
 * The template preview (7.2)
 * ------------------------------------------------------------------ */

/**
 * One sheet, styled to look like the workbook page it becomes (css/template.css).
 *
 * The labels inside the frame — the tab name, the column headers, the OLD/NEW
 * marker, the Arabic footer — are the FILE's own text and are deliberately not
 * translated. See the header of exportTemplate.js.
 *
 * @param {Object} sheet from the document model.
 * @return {string} HTML
 */
function renderTemplate(sheet) {
  const shown = sheet.rows.slice(0, PREVIEW_ROWS);
  const hidden = sheet.rows.length - shown.length;

  return `
    <section class="tpl tpl-${escapeHtml(sheet.marker.period)}">
      <header class="tpl-head">
        <div class="tpl-head-main">
          <div class="tpl-title">${escapeHtml(sheet.sheet_name)}</div>
          <dl class="tpl-meta">
            ${sheet.meta.map(function (item) {
              return `
                <div class="tpl-meta-row">
                  <dt class="tpl-meta-label">${escapeHtml(item.label)}</dt>
                  <dd class="tpl-meta-value${item.type === 'money' ? ' num' : ''}">
                    ${escapeHtml(item.type === 'money' ? formatMoney(item.value) : (item.value || '—'))}
                  </dd>
                </div>
              `;
            }).join('')}
          </dl>
        </div>

        <div class="tpl-marker">${escapeHtml(sheet.marker.label)}</div>
      </header>

      <div class="tpl-table-wrap">
        <table class="tpl-table">
          <thead>
            <tr>
              ${sheet.columns.map(function (column) {
                return `<th class="${cellClass(column.type)}">${escapeHtml(column.label)}</th>`;
              }).join('')}
            </tr>
          </thead>

          <tbody>
            ${shown.map(function (row) {
              return `
                <tr${row.is_split ? ' class="is-split"' : ''}>
                  ${row.cells.map(function (cell) {
                    return `<td class="${cellClass(cell.type)}">${escapeHtml(cellText(cell))}</td>`;
                  }).join('')}
                </tr>
              `;
            }).join('')}
          </tbody>

          <tfoot>
            <tr>
              ${sheet.totals_row.map(function (cell) {
                return `<td class="${cellClass(cell.type)}">${escapeHtml(cellText(cell))}</td>`;
              }).join('')}
            </tr>
          </tfoot>
        </table>
      </div>

      ${hidden > 0 ? `
        <div class="tpl-more">${escapeHtml(t('export_preview_capped', {
          shown: shown.length, total: sheet.rows.length
        }))}</div>
      ` : ''}

      <footer class="tpl-foot">
        <div class="tpl-foot-line">
          <span class="tpl-foot-label">${escapeHtml(sheet.footer.tracking_label)}</span>
          <span class="tpl-foot-value num">${escapeHtml(sheet.footer.tracking_no || '—')}</span>
          <span class="spacer"></span>
          <span class="tpl-foot-label">${escapeHtml(sheet.footer.date_label)}</span>
          <span class="tpl-foot-value num">${escapeHtml(sheet.footer.date)}</span>
        </div>

        <div class="tpl-signatures">
          ${sheet.footer.signatures.map(function (signature) {
            return `
              <div class="tpl-sign">
                <div class="tpl-sign-rule"></div>
                <div class="tpl-sign-label">${escapeHtml(signature)}</div>
              </div>
            `;
          }).join('')}
        </div>
      </footer>
    </section>
  `;
}

/**
 * @param {string} type a column or cell type.
 * @return {string} the class list for that cell.
 */
function cellClass(type) {
  if (type === 'money') return 'num tpl-money';
  if (type === 'num') return 'num';

  /*
   * Site IDs, Job Codes and the split indicator: `.num` for the direction, then
   * `.tpl-id` to put the alignment back to the start of the line. They read
   * left-to-right like a number (8.1) — `377/442` must never come out `442/377`
   * on an Arabic page — but they are identifiers, not figures, and right-aligning
   * a column of them would look wrong beside the text columns.
   */
  if (type === 'id') return 'num tpl-id';

  if (type === 'label') return 'tpl-total-label';
  return '';
}

/**
 * One cell as text.
 *
 * Money is formatted for reading; a blank money cell stays blank rather than
 * becoming 0.00, because "no karta on this row" and "zero karta" are different
 * facts (the same reason money.js has formatMoneyOrBlank).
 *
 * @param {Object} cell
 * @return {string}
 */
function cellText(cell) {
  if (cell.value === '' || cell.value === null || cell.value === undefined) return '';
  if (cell.type === 'money') return formatMoney(cell.value);
  return String(cell.value);
}

/* ------------------------------------------------------------------ *
 * The ExportLog (7.3)
 * ------------------------------------------------------------------ */

/**
 * What has already gone out.
 *
 * The point of showing it is 7.3's: a manager can see whether this month's file
 * has already been issued, and re-issue deliberately if finance lost it, rather
 * than finding out by exporting an empty batch.
 *
 * @return {string} HTML
 */
function renderLog() {
  if (logError) return renderLoadError(logError);

  if (!log.length) {
    return renderEmpty(t('export_log_empty_title'), t('export_log_empty_text'), '▤');
  }

  return `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>${escapeHtml(t('col_batch'))}</th>
            <th>${escapeHtml(t('col_team'))}</th>
            <th>${escapeHtml(t('col_month'))}</th>
            <th>${escapeHtml(t('col_period_tracking'))}</th>
            <th>${escapeHtml(t('col_report_type'))}</th>
            <th class="text-end">${escapeHtml(t('col_rows'))}</th>
            <th>${escapeHtml(t('col_exported_by'))}</th>
          </tr>
        </thead>
        <tbody>
          ${log.map(renderLogRow).join('')}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * @param {Object} batch a row from `list_export_log`.
 * @return {string} HTML
 */
function renderLogRow(batch) {
  return `
    <tr>
      <td class="num text-bold">${escapeHtml(batch.batch_id)}</td>
      <td>${escapeHtml(batch.team || '—')}</td>
      <td>${escapeHtml([batch.month, batch.fiscal_year].filter(Boolean).join(' '))}</td>

      <td>
        <div class="cell-line">
          ${batch.period ? renderPeriodBadge(batch.period) : ''}
          ${batch.tracking_no
            ? `<span class="num text-bold">#${escapeHtml(batch.tracking_no)}</span>`
            : ''}
        </div>
      </td>

      <td>${escapeHtml(t('export_report_' + (batch.report_type === 'persite' ? 'persite' : 'normal')))}</td>
      <td class="num text-end">${escapeHtml(String(batch.row_count === null ? '' : batch.row_count))}</td>

      <td>
        <div>${escapeHtml(batchAuthor(batch))}</div>
        <div class="text-tiny text-muted num">${escapeHtml(formatDateTime(batch.exported_at))}</div>
      </td>
    </tr>
  `;
}

/**
 * Who committed a batch, in the active language (8.1).
 * @param {Object} batch
 * @return {string}
 */
function batchAuthor(batch) {
  if (getLang() === 'ar' && batch.exported_by_name_ar) return batch.exported_by_name_ar;
  return batch.exported_by_name || batch.exported_by || '—';
}
