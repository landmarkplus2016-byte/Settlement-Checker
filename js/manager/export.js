/**
 * export.js — the export builder (CLAUDE.md 3.7, 7, rules 15–18).
 *
 * A manager picks a team and a settlement; the screen fetches the
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
 *   - **One team can have several open settlements.** A team holds as many as a
 *     coordinator opens (rule 9), each with its own pair of Tracking#s, so the
 *     settlement selector exists to send them as separate files rather than one
 *     file with two numbers in its footer. It appears only once a query has
 *     found more than one batch, because most teams have one open at a time.
 *
 * ── Where the per-site file comes from ─────────────────────────────────────
 *
 * It is NOT a choice made up front. Generate always builds the Normal file, and
 * the per-site file (6.4) is built afterwards from a batch in the log below —
 * one button per exported batch.
 *
 * That is the order the work actually happens in: the per-site breakdown is the
 * last step of a settlement, taken once the finance file itself has been revised
 * and committed. Offering it as a report type beside Normal put the choice
 * before the review, and made the two files look like alternatives when they are
 * consecutive.
 *
 * It also makes the per-site file exactly the normal file, divided. It is built
 * from `export_batch_rows` — the rows carrying that `export_batch_id` — rather
 * than from a fresh predicate, so it cannot pick up a row the finance file did
 * not have or miss one it did. Nothing is claimed: those rows are already
 * `exported` and locked (rule 13), and this only reads them.
 *
 * Its LAYOUT, though, is nothing like the finance file's: a single flat table
 * with no header block and no footer, three cost kinds in one Category column.
 * That is perSiteTemplate.js's, not exportTemplate.js's (7.4).
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
import { buildPerSiteDocument, perSiteDocumentToSheets } from './perSiteTemplate.js';

/** The two tracks, in the order the screen shows them. */
const PERIODS = ['old', 'new'];

/** Rows shown per sheet in the preview. The FILE always gets every row. */
const PREVIEW_ROWS = 40;

/** How many past batches the log shows (Export.gs caps at 200). */
const LOG_LIMIT = 50;

/* ------------------------------------------------------------------ *
 * Screen state
 * ------------------------------------------------------------------ */

/**
 * The selection. `team` is required by `export_query`; `settlement`
 * is the optional narrowing to ONE batch, empty for the team's whole period.
 *
 * There is no report type here: this screen builds the Normal file, and the
 * per-site one is built from the log (see the file header).
 */
let filter = { team: '', settlement: '', exclude_exported: true };

/** The report this screen generates and commits. The per-site file is 6.4's. */
const NORMAL_REPORT = 'normal';

/**
 * The batches this team and period hold, merged across both periods, as
 * `{ key, label }`.
 *
 * A team can hold several settlements (rule 9) and each carries its own pair of
 * Tracking#s, so one team may have two batches under two numbers. Without
 * this the only possible export is both of them in one file, with both numbers
 * in the footer.
 *
 * It is filled from the query rather than asked for up front, because "which
 * settlements have approved rows for team Ashraf" is a question only
 * the sweep can answer — and the server answers it whether or not the filter is
 * already narrowed, so the selector keeps working after it has been used once.
 */
let settlementOptions = [];

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

/** The ExportLog, newest first (7.3). */
let log = [];
let logError = '';

/**
 * The batches whose per-site file is being built, so their rows can say so and
 * no second build starts on top of it.
 */
let persiteBusy = [];

/**
 * The batch ids ticked in the log, for one combined per-site file (7.1). Pruned
 * whenever the log reloads, so a tick cannot outlive the row it was on.
 */
let selectedBatches = new Set();

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

  filter = { team: '', settlement: '', exclude_exported: true };
  periods = emptyPeriods();
  settlementOptions = [];
  generated = false;
  generating = false;
  teams = [];
  log = [];
  logError = '';
  persiteBusy = [];
  selectedBatches = new Set();

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
    if (action === 'persite') return requestPerSite([trigger.dataset.batch || '']);
    if (action === 'persite-selected') return requestPerSite(Array.from(selectedBatches));
    if (action === 'select-pending') return setSelection(log.filter(isPending).map(batchIdOf));
    if (action === 'clear-selection') return setSelection([]);
  });

  page$.addEventListener('change', function (event) {
    // The log's tick boxes (7.1). Not filters: they change nothing but the
    // selection, and must not throw a generated preview away.
    const pick = event.target.closest('[data-log-select]');
    if (pick) return toggleBatch(pick.dataset.batch || '', pick.checked);

    const all = event.target.closest('[data-log-select-all]');
    if (all) return setSelection(all.checked ? log.map(batchIdOf) : []);

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
     * A different team is a different question entirely, so the
     * batches offered for the old one are gone — including one the manager had
     * narrowed to, which would otherwise silently keep filtering a team it does
     * not belong to.
     */
    if (key === 'team') {
      filter.settlement = '';
      settlementOptions = [];
      paintSettlementFilter();
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
 * The one required select.
 *
 * Failures are swallowed, as on the approvals screen: this is the furniture
 * around the real work, and a manager who knows the team name can still be given
 * the list once it arrives. Unlike approvals, though, there is no "all" option —
 * an export is one team (7.1).
 *
 * The month select is gone with the month. What narrows a team's rows now is the
 * SETTLEMENT, and that list cannot be loaded here: which settlements have
 * approved rows for this team is a question only the sweep can answer, so it is
 * filled from the query (settlementOptions).
 */
async function loadReference() {
  const teamData = await api.call('list_teams', { include_inactive: true }).catch(nullOnError);

  // Inactive teams stay in the list: entries already filed under a team keep it
  // (2.1), so a team deactivated part-way through still has a file to export.
  teams = (teamData && teamData.teams) || [];

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
    return api.call('export_query', queryPayload(period)).then(
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
  collectSettlementOptions();

  generating = false;
  paintGenerateButton();
  paintSettlementFilter();
  paintResults();
}

/**
 * The predicate, as `export_query` and `export_commit` both take it.
 *
 * One function for both so the preview and the claim can never disagree about
 * what is being selected — the commit re-runs this same selection server-side
 * (rule 16), and a settlement in one call and not the other would claim rows the
 * manager never saw.
 *
 * @param {string} period 'old' | 'new'
 * @return {Object}
 */
function queryPayload(period) {
  return {
    team: filter.team,
    period: period,
    settlement: filter.settlement,
    exclude_exported: filter.exclude_exported
  };
}

/**
 * Merge both periods' batch lists into the selector's options.
 *
 * A union, not one period's list: a settlement may hold only old rows or only
 * new ones, and offering it under one track and not the other would make the
 * selector's contents depend on which panel the manager happens to be looking
 * at. The server tallies these before applying the narrowing, so re-generating
 * a narrowed query still returns every sibling batch.
 */
function collectSettlementOptions() {
  const seen = {};
  const out = [];

  PERIODS.forEach(function (period) {
    const found = (periods[period].query && periods[period].query.settlements) || [];

    found.forEach(function (batch) {
      const key = String(batch.key || '');

      // An entry whose settlement row is missing is tallied under an empty id.
      // It cannot be narrowed to — there is nothing to name — so it stays in
      // the unnarrowed file and out of the selector.
      if (!key || !batch.settlement_id || seen[key]) return;

      seen[key] = true;
      out.push({
        value: key,
        label: [batchCoordinator(batch), batch.settlement_id].filter(Boolean).join(' · ')
      });
    });
  });

  settlementOptions = out;
}

/**
 * The coordinator a batch belongs to, in the active language (8.1).
 * @param {Object} batch
 * @return {string}
 */
function batchCoordinator(batch) {
  const person = batch.coordinator || {};
  if (getLang() === 'ar' && person.display_name_ar) return person.display_name_ar;
  return person.display_name || person.user_id || '';
}

/**
 * Rebuild both documents from whatever queries are in hand.
 *
 * Always the Normal file: the per-site one is built from an exported batch in
 * the log, by a different builder entirely (see the file header).
 */
function rebuildDocuments() {
  PERIODS.forEach(function (period) {
    const state = periods[period];

    state.doc = state.query
      ? buildExportDocument({
          query: state.query,
          period: period,
          team: filter.team
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

  const shown = new Set(log.map(batchIdOf));
  selectedBatches = new Set(Array.from(selectedBatches).filter(function (id) { return shown.has(id); }));

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
          period: t('period_' + period)
        }))}
      </p>

      <div class="alert alert-info mt-4">
        ${escapeHtml(t('export_confirm_tracking', {
          tracking: doc.tracking_no || t('tracking_placeholder'),
          type: t('export_report_' + doc.report_type)
        }))}
      </div>

      ${filter.settlement ? `
        <div class="alert alert-info mt-4">
          ${escapeHtml(t('export_settlement_scoped', {
            settlement: settlementLabel(filter.settlement)
          }))}
        </div>
      ` : ''}

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
        period: period,
        settlement: filter.settlement,
        report_type: NORMAL_REPORT
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
 * Ask for the per-site file of one or more batches — first asking whether to go
 * on when any of them has had its per-site file downloaded before.
 *
 * The question is why downloads are recorded at all. A second download is not
 * wrong — finance loses files — so it is never refused; but a manager ticking
 * ten batches should learn that three of them already went BEFORE the file does.
 *
 * @param {Array<string>} batchIds ExportLog batch ids.
 */
function requestPerSite(batchIds) {
  const ids = oldestFirst(batchIds.filter(Boolean));
  if (!ids.length || persiteBusy.length) return;

  const before = ids.map(findBatch).filter(function (batch) {
    return batch && !isPending(batch);
  });

  if (!before.length) return buildPerSite(ids);

  openModal({
    title: t('export_persite_again_title'),
    confirmLabel: t('export_persite_again_confirm'),

    bodyHtml: `
      <p class="text-small text-secondary">
        ${escapeHtml(ids.length === 1
          ? t('export_persite_again_one')
          : t('export_persite_again_text', { count: before.length, total: ids.length }))}
      </p>

      <ul class="persite-again-list mt-4">
        ${before.map(function (batch) {
          return `
            <li>
              <span class="num text-bold">${escapeHtml(batch.batch_id)}</span>
              <span class="text-tiny text-muted">${escapeHtml(downloadedLine(batch))}</span>
            </li>
          `;
        }).join('')}
      </ul>
    `,

    // Not awaited: the build reports its own errors and busy state on the log,
    // so the dialog has nothing left to wait for.
    onConfirm: function () { buildPerSite(ids); }
  });
}

/**
 * Build and download the per-site file for already-exported batches (6.4) — one
 * file, one table, however many batches (7.1).
 *
 * The last step of a settlement, and deliberately a separate act from the export
 * itself: it happens once the finance file has been issued, on a batch that
 * already exists. Nothing is claimed — those rows are `exported` and locked
 * (rule 13); `export_batch_rows` only reads them.
 *
 * The rows come from the BATCH, not from a fresh team-period predicate, so
 * the per-site file divides exactly the lines the finance file carried. Rebuilt
 * from a predicate it could differ from it — a row approved since, or a second
 * batch on the same team — and a per-site breakdown that does not add up
 * to the file it explains is worse than none.
 *
 * @param {Array<string>} batchIds ExportLog batch ids, oldest first.
 */
async function buildPerSite(batchIds) {
  if (!batchIds.length || persiteBusy.length) return;

  persiteBusy = batchIds.slice();
  paintLog();

  try {
    const data = await api.call('export_batch_rows', { batch_ids: batchIds });

    const doc = buildPerSiteDocument({ query: data, batches: (data && data.batches) || [] });

    if (!doc.has_rows) {
      toastError(t('export_persite_empty'));
      return;
    }

    if (!isXlsxAvailable()) throw new SheetError('xlsx_unavailable');

    toastSuccess(t('export_downloaded', {
      file: downloadWorkbook(perSiteDocumentToSheets(doc), doc.file_name, { rtl: isRtl() })
    }));

    await recordPerSiteDownload(batchIds);

    // Done with: the ticks have served their purpose, and leaving them on would
    // invite downloading the same set twice.
    batchIds.forEach(function (id) { selectedBatches.delete(id); });
  } catch (err) {
    toastError(errorMessage(err));
  } finally {
    persiteBusy = [];
    paintLog();
  }
}

/**
 * Record on the server that these batches' per-site file was downloaded, and
 * update the log rows in place from its answer rather than reloading the log.
 *
 * A failure here does not un-download the file, so it is reported and
 * swallowed: the manager has the file, and is only told that the log will not
 * show it.
 *
 * @param {Array<string>} batchIds
 */
async function recordPerSiteDownload(batchIds) {
  try {
    const data = await api.call('record_persite_download', { batch_ids: batchIds });

    ((data && data.batches) || []).forEach(function (recorded) {
      const batch = findBatch(recorded.batch_id);
      if (batch) Object.assign(batch, recorded);
    });
  } catch (err) {
    console.warn('Per-site download not recorded: ' + (err && err.message));
    toastError(t('export_persite_record_failed'));
  }
}

/* ------------------------------------------------------------------ *
 * The log's selection (7.1)
 * ------------------------------------------------------------------ */

/** @param {Object} batch @return {string} */
function batchIdOf(batch) {
  return batch.batch_id;
}

/** @param {string} id @return {Object|null} the log row. */
function findBatch(id) {
  return log.filter(function (batch) { return batch.batch_id === id; })[0] || null;
}

/** @param {Object} batch @return {boolean} its per-site file was never downloaded. */
function isPending(batch) {
  return !(Number(batch.persite_download_count) > 0);
}

/**
 * The log lists newest first; the combined file reads oldest first, which is the
 * order the batches went out in.
 *
 * @param {Array<string>} ids
 * @return {Array<string>}
 */
function oldestFirst(ids) {
  const position = function (id) {
    return log.findIndex(function (batch) { return batch.batch_id === id; });
  };

  return ids.slice().sort(function (a, b) { return position(b) - position(a); });
}

/** @param {string} id @param {boolean} on */
function toggleBatch(id, on) {
  if (!id) return;
  if (on) selectedBatches.add(id);
  else selectedBatches.delete(id);
  paintLogSelection();
}

/** @param {Array<string>} ids the whole new selection. */
function setSelection(ids) {
  selectedBatches = new Set(ids.filter(Boolean));
  paintLogSelection();
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
    state.query = await api.call('export_query', queryPayload(period));
    state.error = '';
  } catch (err) {
    state.query = null;
    state.error = errorMessage(err);
  }

  state.downloaded = false;
  state.busy = false;

  rebuildDocuments();

  // A batch that has just been claimed in full drops out of the list, so the
  // selector has to follow the commit rather than outlast it.
  collectSettlementOptions();

  paintSettlementFilter();
  paintResults();
}

/* ================================================================== *
 * Painting
 * ================================================================== */

/**
 * The toolbar, rebuilt with whatever reference data has arrived.
 *
 * Only called when the OPTIONS change — the team list landing. Every
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
  button.title = canGenerate() ? '' : t('export_needs_team');
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
  if (!host) return;

  host.innerHTML = renderLog();

  // `indeterminate` exists only as a property, never as markup.
  paintLogSelection();
}

/**
 * Bring the tick boxes, the selected rows and the selection bar in line with
 * `selectedBatches`, in place — a whole repaint would take the focus off the
 * box the manager just ticked.
 */
function paintLogSelection() {
  const host = qs('#export-log');
  if (!host) return;

  const bar = host.querySelector('#export-log-bar');
  if (bar) bar.innerHTML = renderLogBar();

  host.querySelectorAll('[data-log-select]').forEach(function (box) {
    const on = selectedBatches.has(box.dataset.batch || '');
    box.checked = on;

    const tr = box.closest('tr');
    if (tr) tr.classList.toggle('is-selected', on);
  });

  const all = host.querySelector('[data-log-select-all]');
  if (all) {
    all.checked = log.length > 0 && selectedBatches.size === log.length;
    all.indeterminate = selectedBatches.size > 0 && selectedBatches.size < log.length;
  }
}

/* ------------------------------------------------------------------ *
 * The toolbar
 * ------------------------------------------------------------------ */

/**
 * Team, settlement, exclude-exported, Generate.
 *
 * Team → settlement → period, in that order (decision 20). The month select has
 * gone: a settlement no longer has one, and the settlement selector is what
 * narrows a team's rows now — it was already here as a secondary control and is
 * simply the primary one.
 *
 * @return {string} HTML
 */
function renderFilters() {
  return `
    ${renderSelect('team', t('export_pick_team'), teams.map(function (team) {
      return { value: team.name, label: team.name + (team.active ? '' : ' · ' + t('inactive')) };
    }))}

    <span id="export-settlement-filter">${renderSettlementFilter()}</span>

    <label class="check-row" title="${escapeHtml(t('export_exclude_exported_hint'))}">
      <input type="checkbox" data-filter="exclude_exported"
             ${filter.exclude_exported ? 'checked' : ''}>
      <span>${escapeHtml(t('export_exclude_exported'))}</span>
    </label>

    <span class="spacer"></span>

    <button class="btn btn-primary" type="button" data-action="generate"
            ${canGenerate() && !generating ? '' : 'disabled'}
            title="${escapeHtml(canGenerate() ? '' : t('export_needs_team'))}">
      ${escapeHtml(generating ? t('export_generating') : t('export_generate'))}
    </button>
  `;
}

/**
 * The settlement narrowing, when there is a choice to make.
 *
 * Hidden until a query has found more than one batch for this team: a
 * coordinator with a single open settlement is the ordinary case,
 * and a select with one option in it is furniture that asks a question with no
 * second answer.
 *
 * A batch the manager has narrowed to keeps its option even after it stops
 * coming back from the query — which is what happens the moment he commits all
 * of it — so the select never renders with a value it cannot show.
 *
 * @return {string} HTML
 */
function renderSettlementFilter() {
  const options = settlementOptions.slice();

  if (filter.settlement && !options.some(function (option) { return option.value === filter.settlement; })) {
    options.unshift({ value: filter.settlement, label: filter.settlement });
  }

  // One batch and no narrowing is nothing to ask about; one batch WITH a
  // narrowing still needs its way back to the team's whole period.
  if (options.length < 2 && !filter.settlement) return '';

  return renderSelect('settlement', t('export_all_settlements'), options);
}

/** Repaint just the settlement select, leaving the rest of the toolbar alone. */
function paintSettlementFilter() {
  const host = qs('#export-settlement-filter');
  if (host) host.innerHTML = renderSettlementFilter();
}

/**
 * One toolbar select.
 *
 * @param {string} name a key of `filter`.
 * @param {string} placeholder already translated; also the select's label, since
 *        the toolbar carries no visible labels.
 * @param {Array<{value: string, label: string}>} options
 * @return {string} HTML
 */
function renderSelect(name, placeholder, options) {
  const current = filter[name] || '';

  return `
    <select class="select toolbar-select" data-filter="${escapeHtml(name)}"
            aria-label="${escapeHtml(placeholder)}">
      <option value="">${escapeHtml(placeholder)}</option>
      ${options.map(function (option) {
        const selected = option.value === current ? ' selected' : '';
        return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
      }).join('')}
    </select>
  `;
}

/** @return {boolean} both required fields chosen (3.7). */
function canGenerate() {
  return !!filter.team;
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

  /*
   * Two settlements' worth of numbers in one file. Two coordinators on the same
   * team, or — since a team holds as many settlements as a coordinator opens
   * (rule 9) — one coordinator's two batches. The settlement selector is the way
   * out of the second case, so the message names it.
   *
   * Danger, not warning: `export_commit` refuses this outright (Export.gs), for
   * the same reason it refuses a missing Tracking# above — the footer of both
   * sheets would carry "30, 31", and the rows are locked once claimed.
   */
  if ((header.tracking_numbers || []).length > 1) {
    out.push(renderAlert('danger', t(
      settlementOptions.length > 1 ? 'export_tracking_conflict_split' : 'export_tracking_conflict',
      { numbers: (header.tracking_numbers || []).join(t('list_separator')) }
    )));
  }

  // Narrowed to one batch: the header block names one settlement, not the whole
  // batch, and that is worth saying before the file goes to finance.
  if (filter.settlement) {
    out.push(renderAlert('info', t('export_settlement_scoped', {
      settlement: settlementLabel(filter.settlement)
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
 * A batch key as the manager chose it, falling back to the raw key.
 * @param {string} key `<user_id>::<settlement_id>`
 * @return {string}
 */
function settlementLabel(key) {
  const found = settlementOptions.filter(function (option) { return option.value === key; })[0];
  return found ? found.label : key;
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

  // One file, one number in its footer. The commit refuses this too, so the
  // button must not offer it — a settlement with no fuel at all is unaffected,
  // since this counts the numbers the selected ROWS resolve to, not the kinds.
  if ((header.tracking_numbers || []).length > 1) return t('export_blocked_tracking_conflict');

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
                <tr>
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
    <div class="toolbar log-bar" id="export-log-bar">${renderLogBar()}</div>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="table-check-col">
              <input class="table-check" type="checkbox" data-log-select-all
                     title="${escapeHtml(t('export_log_select_all'))}"
                     aria-label="${escapeHtml(t('export_log_select_all'))}">
            </th>
            <th>${escapeHtml(t('col_batch'))}</th>
            <th>${escapeHtml(t('col_team'))}</th>
            <th>${escapeHtml(t('col_month'))}</th>
            <th>${escapeHtml(t('col_period_tracking'))}</th>
            <th>${escapeHtml(t('col_report_type'))}</th>
            <th class="text-end">${escapeHtml(t('col_rows'))}</th>
            <th>${escapeHtml(t('col_exported_by'))}</th>
            <th class="text-end">${escapeHtml(t('col_persite'))}</th>
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
  const selected = selectedBatches.has(batch.batch_id);

  return `
    <tr class="${selected ? 'is-selected' : ''}">
      <td class="table-check-col">
        <input class="table-check" type="checkbox" data-log-select
               data-batch="${escapeHtml(batch.batch_id)}" ${selected ? 'checked' : ''}
               aria-label="${escapeHtml(t('export_log_select_row', { batch: batch.batch_id }))}">
      </td>

      <td class="num text-bold">${escapeHtml(batch.batch_id)}</td>

      <td>
        <div>${escapeHtml(batch.team || '—')}</div>
        ${batch.settlement_id
          ? `<div class="text-tiny text-muted num">${escapeHtml(batchSettlement(batch))}</div>`
          : ''}
      </td>
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

      <!--
        The last step of the settlement (6.4). Offered on every batch, including
        one already downloaded: the file is rebuilt from the batch's own rows and
        nothing is claimed, so building it twice costs a download — and a
        question first (requestPerSite).
      -->
      <td class="text-end">
        <button class="btn btn-secondary btn-sm" type="button"
                data-action="persite" data-batch="${escapeHtml(batch.batch_id)}"
                ${persiteBusy.length ? 'disabled' : ''}
                title="${escapeHtml(t('export_persite_hint'))}">
          ${escapeHtml(persiteBusy.indexOf(batch.batch_id) !== -1
            ? t('export_persite_building')
            : t('export_persite_build'))}
        </button>
        <div class="persite-status">${renderDownloadStatus(batch)}</div>
      </td>
    </tr>
  `;
}

/**
 * Whether this batch's per-site file has been downloaded, and when, by whom.
 * @param {Object} batch a row from `list_export_log`.
 * @return {string} HTML
 */
function renderDownloadStatus(batch) {
  if (isPending(batch)) {
    return `<span class="badge badge-warning">${escapeHtml(t('export_persite_pending'))}</span>`;
  }

  return `<span class="text-tiny text-muted">${escapeHtml(downloadedLine(batch))}</span>`;
}

/**
 * `Downloaded 2026-09-10 11:06 · Saad El-Dweik ×2`.
 * @param {Object} batch
 * @return {string}
 */
function downloadedLine(batch) {
  const count = Number(batch.persite_download_count) || 0;

  const who = (getLang() === 'ar' && batch.persite_downloaded_by_name_ar)
    ? batch.persite_downloaded_by_name_ar
    : (batch.persite_downloaded_by_name || batch.persite_downloaded_by || '—');

  const line = t('export_persite_downloaded_on', {
    when: formatDateTime(batch.persite_downloaded_at, '—'),
    who: who
  });

  return count > 1 ? line + ' ' + t('export_persite_times', { count: count }) : line;
}

/**
 * The strip above the log: pick the batches that still need their per-site
 * file, and build one file for everything ticked (7.1).
 * @return {string} HTML
 */
function renderLogBar() {
  const count = selectedBatches.size;
  const pending = log.filter(isPending).length;
  const busy = persiteBusy.length > 0;

  return `
    <button class="btn btn-ghost btn-sm" type="button" data-action="select-pending"
            ${pending && !busy ? '' : 'disabled'}>
      ${escapeHtml(t('export_persite_select_pending', { count: pending }))}
    </button>

    ${count ? `
      <button class="btn btn-ghost btn-sm" type="button" data-action="clear-selection">
        ${escapeHtml(t('export_persite_clear_selection'))}
      </button>
    ` : ''}

    <span class="spacer"></span>

    ${count ? '' : `<span class="text-tiny text-muted">${escapeHtml(t('export_persite_none_selected'))}</span>`}

    <button class="btn btn-primary btn-sm" type="button" data-action="persite-selected"
            ${count && !busy ? '' : 'disabled'}>
      ${escapeHtml(busy && persiteBusy.length > 1
        ? t('export_persite_building')
        : t('export_persite_selected', { count: count }))}
    </button>
  `;
}

/**
 * The settlement a logged batch was narrowed to, without the coordinator half of
 * the key — the row already names the team, and the id is what a manager
 * recognises.
 *
 * Empty for an unnarrowed batch, which is most of them, and empty for a log
 * written before the column existed.
 *
 * @param {Object} batch a row from `list_export_log`.
 * @return {string}
 */
function batchSettlement(batch) {
  const parts = String(batch.settlement_id || '').split('::');
  return parts[parts.length - 1] || '';
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
