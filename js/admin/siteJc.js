/**
 * siteJc.js — the Site → Job Code tab (CLAUDE.md 3.4, 5.2).
 *
 * This is the lookup that folds the old workbook's "JC Finder" into entry: when
 * a coordinator types a Site ID, this table is what fills in the Job Code and
 * the period (6.6.3).
 *
 * `period` is the reason this screen matters more than it looks. It is what
 * routes an entry to the OLD or the NEW Tracking# (rule 14 / 6.2), so a wrong
 * period here silently sends money to the wrong track. Two consequences run
 * through the whole file:
 *
 *   - The period is editable INLINE, as an amber/blue select in the cell, rather
 *     than buried in an edit dialog. Correcting one is a one-click job.
 *   - The Excel import will not accept a row without a period. The server is
 *     all-or-nothing on a bulk import — deliberately, so a bad cell on row 400
 *     cannot leave the lookup half-imported — so this screen mirrors that and
 *     refuses to send a file until every row is good, listing what to fix.
 *
 * Site IDs match case-insensitively everywhere (`k3799` and `K3799` are one
 * site), and are STORED exactly as typed. The server owns that rule; the search
 * box here follows it so the screen agrees with the data.
 */

import { api } from '../api.js';
import { t, errorMessage } from '../i18n/i18n.js';
import { escapeHtml, qs } from '../utils/dom.js';
import { formatDateTime } from '../utils/dates.js';
import { isXlsxAvailable, readWorkbookFile, readSheetRows, pickField } from '../utils/xlsx.js';
import { openModal } from '../components/modal.js';
import { toastSuccess, toastError } from '../components/toast.js';
import { renderLoading, renderLoadError, renderEmpty } from '../components/table.js';

/**
 * How many rows to put in the DOM at once. A real site list runs to thousands;
 * painting all of them costs more than it tells anyone. The search box is the
 * way to reach the rest, and the footer says so.
 */
const MAX_VISIBLE = 300;

/** Ceiling on one import, matching MAX_BULK_SITE_JC_ROWS in Admin.gs. */
const MAX_IMPORT_ROWS = 5000;

/** How many bad rows to list in the import preview before summarising. */
const MAX_PROBLEMS_SHOWN = 12;

/**
 * Column spellings accepted from an uploaded file, best first. Real site lists
 * are made by many hands, and demanding one spelling would send managers back
 * to Excel to rename headers before every upload.
 */
const COLUMN_ALIASES = {
  site_id: ['site_id', 'site', 'siteid', 'site_no', 'site_number', 'site_code', 'sites'],
  job_code: ['job_code', 'jobcode', 'jc', 'job', 'code', 'job_no'],
  period: ['period', 'old_new', 'oldnew', 'new_old', 'track', 'type']
};

/** Every row from the last load. */
let sites = [];

/** The live filter. */
let search = '';
let periodFilter = '';

/**
 * The Site → Job Code screen.
 * @return {string} HTML
 */
export function renderSiteJc() {
  return `
    <div class="page" id="sitejc-page">
      <div class="page-title-row">
        <div>
          <h1>${escapeHtml(t('nav_sitejc'))}</h1>
          <div class="page-subtitle">${escapeHtml(t('sitejc_subtitle'))}</div>
        </div>
        <span class="spacer"></span>
        <button class="btn btn-secondary" type="button" data-action="upload">
          ${escapeHtml(t('sitejc_upload'))}
        </button>
        <button class="btn btn-primary" type="button" data-action="add">
          ${escapeHtml(t('sitejc_add'))}
        </button>
      </div>

      <div class="toolbar">
        <input class="input toolbar-search" id="sitejc-search" type="search"
               placeholder="${escapeHtml(t('sitejc_search_placeholder'))}"
               aria-label="${escapeHtml(t('search'))}">

        <select class="select toolbar-select" id="sitejc-period"
                aria-label="${escapeHtml(t('col_period'))}">
          <option value="">${escapeHtml(t('period_all'))}</option>
          <option value="old">${escapeHtml(t('period_old'))}</option>
          <option value="new">${escapeHtml(t('period_new'))}</option>
        </select>
      </div>

      <div class="card">
        <div id="sitejc-body">${renderLoading()}</div>
      </div>

      <!-- Triggered by the Upload button; never shown. -->
      <input type="file" id="sitejc-file" class="hidden"
             accept=".xlsx,.xls,.csv" aria-hidden="true" tabindex="-1">
    </div>
  `;
}

/**
 * Wire the screen and load it.
 */
export function bindSiteJcEvents() {
  const page = qs('#sitejc-page');
  if (!page) return;

  sites = [];
  search = '';
  periodFilter = '';

  page.addEventListener('click', function (event) {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;

    const action = trigger.dataset.action;
    const site = findSite(trigger.dataset.siteId);

    if (action === 'retry') return load();
    if (action === 'add') return openSiteDialog(null);
    if (action === 'upload') return pickFile();
    if (action === 'edit' && site) return openSiteDialog(site);
    if (action === 'delete' && site) return confirmDelete(site);
  });

  // The inline period flip — the one edit that never opens a dialog.
  page.addEventListener('change', function (event) {
    const select = event.target.closest('.period-select');
    if (!select) return;

    const site = findSite(select.dataset.siteId);
    if (site) flipPeriod(site, select);
  });

  const searchEl = qs('#sitejc-search');
  if (searchEl) {
    searchEl.addEventListener('input', function () {
      search = String(searchEl.value || '').trim().toUpperCase();
      paint();
    });
  }

  const periodEl = qs('#sitejc-period');
  if (periodEl) {
    periodEl.addEventListener('change', function () {
      periodFilter = String(periodEl.value || '');
      paint();
    });
  }

  const fileEl = qs('#sitejc-file');
  if (fileEl) {
    fileEl.addEventListener('change', function () {
      const file = fileEl.files && fileEl.files[0];
      // Reset immediately, so picking the SAME file again still fires `change`.
      fileEl.value = '';
      if (file) handleFile(file);
    });
  }

  load();
}

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

/** Fetch the whole lookup once; filtering is local from here. */
async function load() {
  const body = qs('#sitejc-body');
  if (!body) return;

  body.innerHTML = renderLoading();

  try {
    const data = await api.call('list_site_jc', {});
    sites = (data && data.sites) || [];
    paint();
  } catch (err) {
    sites = [];
    body.innerHTML = renderLoadError(errorMessage(err));
  }
}

/**
 * Look a loaded row up by its stored site_id.
 * @param {string} siteId
 * @return {Object|null}
 */
function findSite(siteId) {
  if (!siteId) return null;
  return sites.find(function (site) { return site.site_id === siteId; }) || null;
}

/**
 * The rows the current filter selects.
 * @return {Array<Object>}
 */
function filtered() {
  return sites.filter(function (site) {
    if (periodFilter && site.period !== periodFilter) return false;
    if (!search) return true;

    // Case-insensitive, exactly as the server matches a Site ID.
    return String(site.site_id).toUpperCase().indexOf(search) !== -1 ||
           String(site.job_code).toUpperCase().indexOf(search) !== -1;
  });
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** Repaint the table body from the loaded rows and the filter. */
function paint() {
  const body = qs('#sitejc-body');
  if (body) body.innerHTML = renderBody();
}

/**
 * @return {string} HTML
 */
function renderBody() {
  if (!sites.length) {
    return renderEmpty(t('sitejc_empty_title'), t('sitejc_empty_text'), '⌗');
  }

  const matches = filtered();
  if (!matches.length) {
    return renderEmpty(t('nothing_found_title'), t('nothing_found_text'), '⌕');
  }

  const shown = matches.slice(0, MAX_VISIBLE);

  return `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>${escapeHtml(t('col_site_id'))}</th>
            <th>${escapeHtml(t('col_job_code'))}</th>
            <th>${escapeHtml(t('col_period'))}</th>
            <th>${escapeHtml(t('col_updated'))}</th>
            <th class="col-actions"><span class="sr-only">${escapeHtml(t('actions'))}</span></th>
          </tr>
        </thead>
        <tbody>
          ${shown.map(renderRow).join('')}
        </tbody>
      </table>
    </div>

    <div class="table-foot">
      ${escapeHtml(
        shown.length < matches.length
          ? t('showing_capped', { shown: shown.length, total: matches.length })
          : t('showing_all', { total: matches.length })
      )}
    </div>
  `;
}

/**
 * One site row. The period cell is a live select, not a badge — see the file
 * header for why this one field is editable in place.
 *
 * @param {Object} site
 * @return {string} HTML
 */
function renderRow(site) {
  const id = escapeHtml(site.site_id);
  const isOld = site.period === 'old';

  return `
    <tr>
      <td class="num text-bold">${id}</td>
      <td class="num">${escapeHtml(site.job_code)}</td>
      <td>
        <select class="period-select ${isOld ? 'is-old' : 'is-new'}"
                data-site-id="${id}"
                aria-label="${escapeHtml(t('col_period'))}">
          <option value="old"${isOld ? ' selected' : ''}>${escapeHtml(t('period_old'))}</option>
          <option value="new"${isOld ? '' : ' selected'}>${escapeHtml(t('period_new'))}</option>
        </select>
      </td>
      <td class="num text-small text-muted">${escapeHtml(formatDateTime(site.updated_at, '—'))}</td>
      <td class="col-actions">
        <div class="cell-actions">
          <button class="btn btn-secondary btn-sm" type="button"
                  data-action="edit" data-site-id="${id}">
            ${escapeHtml(t('edit'))}
          </button>
          <button class="btn btn-ghost btn-sm" type="button"
                  data-action="delete" data-site-id="${id}">
            ${escapeHtml(t('delete'))}
          </button>
        </div>
      </td>
    </tr>
  `;
}

/* ------------------------------------------------------------------ *
 * Single-row actions
 * ------------------------------------------------------------------ */

/**
 * Add a site, or correct one.
 *
 * The Site ID is read-only when editing: `upsert_site_jc` keys on it, so
 * changing it would create a second row rather than rename this one. Renaming a
 * site is delete-then-add, and the buttons for both are right there.
 *
 * @param {Object|null} site null to create.
 */
function openSiteDialog(site) {
  const editing = !!site;

  openModal({
    title: editing ? t('sitejc_edit') : t('sitejc_add'),
    confirmLabel: editing ? t('save') : t('add'),
    bodyHtml: `
      <div class="form-grid">
        <div class="field">
          <label class="label" for="site-id">${escapeHtml(t('col_site_id'))}</label>
          <input class="input num" id="site-id" type="text" maxlength="60"
                 value="${escapeHtml(editing ? site.site_id : '')}"
                 ${editing ? 'readonly' : ''}>
          ${editing ? `<span class="field-hint">${escapeHtml(t('sitejc_id_locked'))}</span>` : ''}
        </div>

        <div class="field">
          <label class="label" for="site-jc">${escapeHtml(t('col_job_code'))}</label>
          <input class="input num" id="site-jc" type="text" maxlength="60"
                 value="${escapeHtml(editing ? site.job_code : '')}">
        </div>

        <div class="field field-full">
          <label class="label" for="site-period">${escapeHtml(t('col_period'))}</label>
          <select class="select" id="site-period">
            <option value="old"${editing && site.period === 'old' ? ' selected' : ''}>
              ${escapeHtml(t('period_old'))}
            </option>
            <option value="new"${!editing || site.period === 'new' ? ' selected' : ''}>
              ${escapeHtml(t('period_new'))}
            </option>
          </select>
          <span class="field-hint">${escapeHtml(t('sitejc_period_hint'))}</span>
        </div>
      </div>
    `,

    onConfirm: async function (ctx) {
      const siteId = ctx.value('#site-id');
      const jobCode = ctx.value('#site-jc');
      const period = ctx.value('#site-period');

      if (!siteId) {
        ctx.setError(t('sitejc_site_required'));
        return false;
      }
      // A slash means a multi-site entry cell, not a site. The lookup holds one
      // site per row (CLAUDE.md 2.1); the grid splits and looks up each segment.
      if (siteId.indexOf('/') !== -1) {
        ctx.setError(t('sitejc_single_site_only'));
        return false;
      }
      if (!jobCode) {
        ctx.setError(t('sitejc_jc_required'));
        return false;
      }

      await api.call('upsert_site_jc', {
        site_id: siteId,
        job_code: jobCode,
        period: period
      });

      toastSuccess(t('sitejc_saved'));
      load();
    }
  });
}

/**
 * Flip one row's period from the inline select.
 *
 * On failure the select is put back to what the server still holds, so the
 * screen never shows a period the database does not have.
 *
 * @param {Object} site
 * @param {HTMLSelectElement} select
 */
async function flipPeriod(site, select) {
  const next = select.value;
  if (next === site.period) return;

  select.disabled = true;

  try {
    await api.call('upsert_site_jc', {
      site_id: site.site_id,
      job_code: site.job_code,
      period: next
    });

    site.period = next;
    select.classList.toggle('is-old', next === 'old');
    select.classList.toggle('is-new', next !== 'old');

    toastSuccess(t('sitejc_period_changed', { site: site.site_id }));

  } catch (err) {
    select.value = site.period;
    toastError(errorMessage(err));
  } finally {
    select.disabled = false;
  }
}

/**
 * Remove a site from the lookup.
 *
 * Safe despite being a real delete: an entry stores the job code and period it
 * resolved at save time, so removing a stale lookup row never rewrites an
 * entry. The dialog says so, because "delete" in this app usually means
 * "deactivate" and the difference is worth stating.
 *
 * @param {Object} site
 */
function confirmDelete(site) {
  openModal({
    title: t('sitejc_delete_title'),
    confirmLabel: t('delete'),
    confirmVariant: 'btn-danger',
    bodyHtml: `
      <p class="text-small text-secondary">
        ${escapeHtml(t('sitejc_delete_text', { site: site.site_id }))}
      </p>
      <p class="text-small text-muted mt-4">${escapeHtml(t('sitejc_delete_note'))}</p>
    `,
    onConfirm: async function () {
      await api.call('delete_site_jc', { site_id: site.site_id });
      toastSuccess(t('sitejc_deleted'));
      load();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Upload Excel
 * ------------------------------------------------------------------ */

/** Open the file picker, unless SheetJS never loaded. */
function pickFile() {
  if (!isXlsxAvailable()) {
    toastError(t('err_msg_xlsx_unavailable'));
    return;
  }

  const fileEl = qs('#sitejc-file');
  if (fileEl) fileEl.click();
}

/**
 * Parse a picked file and show the preview.
 *
 * Parsing happens entirely in the browser (3.4): the server is sent JSON, never
 * a file. Nothing is uploaded anywhere.
 *
 * @param {File} file
 */
async function handleFile(file) {
  let parsed;

  try {
    const workbook = await readWorkbookFile(file);
    parsed = readSheetRows(workbook);
  } catch (err) {
    toastError(errorMessage(err));
    return;
  }

  const report = mapRows(parsed);
  openImportDialog(file, parsed, report);
}

/**
 * Turn parsed sheet rows into `{site_id, job_code, period}` and find everything
 * wrong with them.
 *
 * Validation mirrors validateSiteJcRow() in Admin.gs, on purpose: the server is
 * all-or-nothing, so a preview that passed rows the server would reject would
 * just produce a confusing failure after the upload.
 *
 * @param {{headers: Array<string>, rows: Array<Object>}} parsed
 * @return {{rows: Array<Object>, problems: Array<Object>, duplicates: number,
 *           missingColumns: Array<string>}}
 */
function mapRows(parsed) {
  const headers = parsed.headers || [];

  // Which of the three columns is missing entirely — a far more useful thing to
  // report than the same error on all 2000 rows.
  const missingColumns = Object.keys(COLUMN_ALIASES).filter(function (field) {
    return !COLUMN_ALIASES[field].some(function (alias) { return headers.indexOf(alias) !== -1; });
  });

  const rows = [];
  const problems = [];
  const seen = {};
  let duplicates = 0;

  (parsed.rows || []).forEach(function (raw) {
    const siteId = pickField(raw, COLUMN_ALIASES.site_id);
    const jobCode = pickField(raw, COLUMN_ALIASES.job_code);
    const period = pickField(raw, COLUMN_ALIASES.period).toLowerCase();

    const reasons = [];
    if (!siteId) reasons.push(t('sitejc_site_required'));
    else if (siteId.indexOf('/') !== -1) reasons.push(t('sitejc_single_site_only'));

    if (!jobCode) reasons.push(t('sitejc_jc_required'));

    if (!period) reasons.push(t('sitejc_period_required'));
    else if (period !== 'old' && period !== 'new') {
      reasons.push(t('sitejc_period_invalid', { value: period }));
    }

    if (reasons.length) {
      problems.push({ row: raw._row, site_id: siteId, reasons: reasons });
      return;
    }

    // Case-insensitive within the file too, so an upload holding both `k3799`
    // and `K3799` sends one row. Last one wins, exactly as the server does it.
    const key = siteId.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(seen, key)) {
      duplicates++;
      rows[seen[key]] = { site_id: siteId, job_code: jobCode, period: period };
      return;
    }

    seen[key] = rows.length;
    rows.push({ site_id: siteId, job_code: jobCode, period: period });
  });

  return { rows: rows, problems: problems, duplicates: duplicates, missingColumns: missingColumns };
}

/**
 * The preview. Import is offered only when every row is good.
 *
 * @param {File} file
 * @param {Object} parsed from readSheetRows().
 * @param {Object} report from mapRows().
 */
function openImportDialog(file, parsed, report) {
  const blocked = report.problems.length > 0 ||
                  report.rows.length === 0 ||
                  report.rows.length > MAX_IMPORT_ROWS;

  openModal({
    title: t('sitejc_upload_title'),
    wide: true,
    confirmLabel: blocked ? '' : t('import_confirm'),
    cancelLabel: blocked ? t('close') : t('cancel'),

    bodyHtml: `
      <div class="stack">
        <div class="text-small text-secondary">
          ${escapeHtml(t('import_file_line', { file: file.name, sheet: parsed.sheet_name }))}
        </div>

        <div class="import-stats">
          ${importStat(report.rows.length, t('import_stat_ready'))}
          ${importStat(report.problems.length, t('import_stat_problems'))}
          ${importStat(report.duplicates, t('import_stat_duplicates'))}
        </div>

        ${report.missingColumns.length ? `
          <div class="alert alert-danger">
            ${escapeHtml(t('import_missing_columns', {
              columns: report.missingColumns.map(function (c) { return t('col_' + c); }).join(', ')
            }))}
          </div>
        ` : ''}

        ${renderProblems(report.problems)}

        ${report.rows.length > MAX_IMPORT_ROWS ? `
          <div class="alert alert-danger">
            ${escapeHtml(t('import_too_many', { max: MAX_IMPORT_ROWS }))}
          </div>
        ` : ''}

        ${!blocked ? `
          <div class="alert alert-info">${escapeHtml(t('import_ready_note'))}</div>
        ` : ''}

        ${report.duplicates && !blocked ? `
          <div class="text-small text-muted">${escapeHtml(t('import_duplicates_note'))}</div>
        ` : ''}

        ${!report.rows.length && !report.problems.length ? `
          <div class="alert alert-warning">${escapeHtml(t('import_no_rows'))}</div>
        ` : ''}
      </div>
    `,

    onConfirm: blocked ? null : async function () {
      const result = await api.call('bulk_import_site_jc', { rows: report.rows });

      toastSuccess(t('import_done', {
        created: (result && result.created) || 0,
        updated: (result && result.updated) || 0
      }));

      load();
    }
  });
}

/**
 * One number in the preview's summary.
 * @param {number} value
 * @param {string} label already translated.
 * @return {string} HTML
 */
function importStat(value, label) {
  return `
    <div class="import-stat">
      <div class="import-stat-value num">${escapeHtml(String(value))}</div>
      <div class="import-stat-label">${escapeHtml(label)}</div>
    </div>
  `;
}

/**
 * The list of rows that need fixing, capped so a wholly broken file does not
 * produce a dialog thousands of lines long.
 *
 * @param {Array<Object>} problems
 * @return {string} HTML
 */
function renderProblems(problems) {
  if (!problems.length) return '';

  const shown = problems.slice(0, MAX_PROBLEMS_SHOWN);
  const rest = problems.length - shown.length;

  return `
    <div>
      <div class="section-title">${escapeHtml(t('import_problems_title'))}</div>
      <div class="problem-list">
        ${shown.map(function (problem) {
          return `
            <div class="problem-row">
              <span class="text-bold num">${escapeHtml(t('import_row_label', { row: problem.row }))}</span>
              ${problem.site_id ? `<span class="num text-muted"> · ${escapeHtml(problem.site_id)}</span>` : ''}
              <span class="text-secondary"> — ${escapeHtml(problem.reasons.join(' · '))}</span>
            </div>
          `;
        }).join('')}
      </div>
      ${rest > 0 ? `<div class="text-small text-muted mt-4">${escapeHtml(t('import_problems_more', { count: rest }))}</div>` : ''}
    </div>
  `;
}
