/**
 * siteJc.js — the Site → Job Code tab (CLAUDE.md 3.4, 5.2).
 *
 * This is the lookup that folds the old workbook's "JC Finder" into entry: when
 * a coordinator types a Site ID, this table is what fills in the Job Code and
 * the period (6.6.3).
 *
 * `period` is the reason this screen matters more than it looks. It is what
 * routes an entry to the OLD or the NEW Tracking# (rule 14 / 6.2), so a wrong
 * period here silently sends money to the wrong track. Three consequences run
 * through the whole file:
 *
 *   - **A row is a task, not a site.** The source tracking file raises a new job
 *     code against a site every time work is ordered there, so `K3602` carries
 *     both `ABD02` and `ABD12` — and both are `old`, so the period cannot tell
 *     them apart. Identity is the PAIR site_id + job_code, and every action here
 *     names both. The `task_date` beside them is what the grid uses to choose.
 *   - **The period is not typed; it is derived from the Task Date.** The upload
 *     ignores the file's own Old/New column and re-derives from the date on the
 *     server, so there is one authority for the old/new split. The inline flip
 *     below stays, for a correction between uploads — the next upload re-derives.
 *   - **An upload REPLACES the lookup.** The file is a dated full export, so a
 *     pair that has left the file leaves the lookup with it. The preview says
 *     exactly how many rows that is before anything is written.
 *
 * The server is all-or-nothing on a bulk import — deliberately, so a bad cell on
 * row 400 cannot leave the lookup half-imported — so this screen mirrors its
 * validation and refuses to send a file until every row is good.
 *
 * Site IDs match case-insensitively everywhere (`k3799` and `K3799` are one
 * site), and are STORED exactly as typed. The server owns that rule; the search
 * box here follows it so the screen agrees with the data.
 */

import { api } from '../api.js';
import { t, errorMessage } from '../i18n/i18n.js';
import { escapeHtml, qs } from '../utils/dom.js';
import { formatDateTime, parseSheetDate } from '../utils/dates.js';
import {
  isXlsxAvailable, readWorkbookFile, readSheetRows, pickField, pickRawField
} from '../utils/xlsx.js';
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
const MAX_IMPORT_ROWS = 10000;

/** How many bad rows to list in the import preview before summarising. */
const MAX_PROBLEMS_SHOWN = 12;

/**
 * Longest a Site ID or Job Code may be, matching validateSiteJcRow() in Admin.gs.
 *
 * Kept in step deliberately. The server is all-or-nothing on an import, so any
 * row this screen passes and the server rejects takes the WHOLE upload down with
 * it — which, now that bad rows are skipped rather than blocking, would be the
 * one way a single stray cell could still cost a manager 9,000 good ones.
 */
const MAX_FIELD_LENGTH = 60;

/**
 * Column spellings accepted from an uploaded file, best first. Real site lists
 * are made by many hands, and demanding one spelling would send managers back
 * to Excel to rename headers before every upload.
 *
 * `site_jc` is the tracking file's own shape — one `Site ID-JC` column holding
 * `K4429-ABD01` — and it is what the upload is built around. The separate
 * `site_id` / `job_code` pair is still read, for a hand-made list.
 *
 * There is deliberately no `period` alias. The file's Old/New column is ignored:
 * the period comes from the Task Date, on the server (see the file header).
 */
const COLUMN_ALIASES = {
  site_jc: ['site_id_jc', 'siteid_jc', 'site_jc', 'site_id_job_code', 'site_and_jc'],
  site_id: ['site_id', 'site', 'siteid', 'site_no', 'site_number', 'site_code', 'sites'],
  job_code: ['job_code', 'jobcode', 'jc', 'job', 'code', 'job_no'],
  task_date: ['task_date', 'taskdate', 'date', 'work_date', 'task']
};

/** Every row from the last load. */
let sites = [];

/**
 * Did that load actually succeed?
 *
 * An empty `sites` means one of two very different things — the lookup is empty,
 * or we could not read it — and with a full-replace import the difference
 * matters: a diff computed against a failed load would report "0 removed" over a
 * lookup holding thousands. The import preview refuses to guess.
 */
let loaded = false;

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
  loaded = false;
  search = '';
  periodFilter = '';

  page.addEventListener('click', function (event) {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;

    const action = trigger.dataset.action;
    const site = findSite(trigger.dataset.siteId, trigger.dataset.jobCode);

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

    const site = findSite(select.dataset.siteId, select.dataset.jobCode);
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
    loaded = true;
    paint();
  } catch (err) {
    sites = [];
    loaded = false;
    body.innerHTML = renderLoadError(errorMessage(err));
  }
}

/**
 * Look a loaded row up by its key — the site_id AND job_code pair, since a site
 * on its own no longer identifies a row (2.1).
 *
 * @param {string} siteId
 * @param {string} jobCode
 * @return {Object|null}
 */
function findSite(siteId, jobCode) {
  if (!siteId || !jobCode) return null;

  return sites.find(function (site) {
    return site.site_id === siteId && site.job_code === jobCode;
  }) || null;
}

/**
 * The key two rows are the same row by. Mirrors siteJcKey() in Admin.gs.
 * @param {*} siteId
 * @param {*} jobCode
 * @return {string}
 */
function rowKey(siteId, jobCode) {
  return String(siteId || '').trim().toUpperCase() + ' ' +
         String(jobCode || '').trim().toUpperCase();
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

/**
 * How many job codes the loaded lookup holds for a site.
 *
 * The count is what tells a manager the row he is looking at is one of several,
 * which is the difference between "that job code is wrong" and "that is the
 * other task on the same site".
 *
 * @return {Object} normalized site_id -> count
 */
function jobCodeCounts() {
  const counts = {};

  sites.forEach(function (site) {
    const key = String(site.site_id || '').trim().toUpperCase();
    counts[key] = (counts[key] || 0) + 1;
  });

  return counts;
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
  const counts = jobCodeCounts();

  return `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>${escapeHtml(t('col_site_id'))}</th>
            <th>${escapeHtml(t('col_job_code'))}</th>
            <th>${escapeHtml(t('col_task_date'))}</th>
            <th>${escapeHtml(t('col_period'))}</th>
            <th>${escapeHtml(t('col_updated'))}</th>
            <th class="col-actions"><span class="sr-only">${escapeHtml(t('actions'))}</span></th>
          </tr>
        </thead>
        <tbody>
          ${shown.map(function (site) { return renderRow(site, counts); }).join('')}
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
 * One site + job code row.
 *
 * Two cells carry more than they look. The period is a live select rather than a
 * badge — see the file header for why that one field is editable in place. And a
 * site with more than one job code gets a count beside its id, because otherwise
 * a repeated site reads as a duplicate row somebody should clean up.
 *
 * @param {Object} site
 * @param {Object} counts from jobCodeCounts().
 * @return {string} HTML
 */
function renderRow(site, counts) {
  const id = escapeHtml(site.site_id);
  const jc = escapeHtml(site.job_code);
  const isOld = site.period === 'old';
  const siblings = counts[String(site.site_id || '').trim().toUpperCase()] || 1;

  const keyAttrs = `data-site-id="${id}" data-job-code="${jc}"`;

  return `
    <tr>
      <td class="num text-bold">
        ${id}
        ${siblings > 1 ? `<span class="jc-count" title="${escapeHtml(t('sitejc_multi_hint', { count: siblings }))}">${siblings}</span>` : ''}
      </td>
      <td class="num">${jc}</td>
      <td class="num text-small">${escapeHtml(site.task_date || '—')}</td>
      <td>
        <select class="period-select ${isOld ? 'is-old' : 'is-new'}"
                ${keyAttrs}
                aria-label="${escapeHtml(t('col_period'))}">
          <option value="old"${isOld ? ' selected' : ''}>${escapeHtml(t('period_old'))}</option>
          <option value="new"${isOld ? '' : ' selected'}>${escapeHtml(t('period_new'))}</option>
        </select>
      </td>
      <td class="num text-small text-muted">${escapeHtml(formatDateTime(site.updated_at, '—'))}</td>
      <td class="col-actions">
        <div class="cell-actions">
          <button class="btn btn-secondary btn-sm" type="button" data-action="edit" ${keyAttrs}>
            ${escapeHtml(t('edit'))}
          </button>
          <button class="btn btn-ghost btn-sm" type="button" data-action="delete" ${keyAttrs}>
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
 * Add a site + job code, or correct one.
 *
 * Both key fields are read-only when editing: `upsert_site_jc` keys on the pair,
 * so changing either would create a second row rather than rename this one.
 * Renaming is delete-then-add, and the buttons for both are right there.
 *
 * The period select starts from whatever the Task Date implies and is left
 * editable, because this dialog is where a task the file got wrong is corrected.
 *
 * @param {Object|null} site null to create.
 */
function openSiteDialog(site) {
  const editing = !!site;
  const isOld = editing && site.period === 'old';

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
        </div>

        <div class="field">
          <label class="label" for="site-jc">${escapeHtml(t('col_job_code'))}</label>
          <input class="input num" id="site-jc" type="text" maxlength="60"
                 value="${escapeHtml(editing ? site.job_code : '')}"
                 ${editing ? 'readonly' : ''}>
        </div>

        ${editing ? `<div class="field field-full">
          <span class="field-hint">${escapeHtml(t('sitejc_id_locked'))}</span>
        </div>` : ''}

        <div class="field">
          <label class="label" for="site-task-date">${escapeHtml(t('col_task_date'))}</label>
          <input class="input num" id="site-task-date" type="date"
                 value="${escapeHtml(editing ? (site.task_date || '') : '')}">
          <span class="field-hint">${escapeHtml(t('sitejc_task_date_hint'))}</span>
        </div>

        <div class="field">
          <label class="label" for="site-period">${escapeHtml(t('col_period'))}</label>
          <select class="select" id="site-period">
            <option value="old"${isOld ? ' selected' : ''}>
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
      const taskDate = ctx.value('#site-task-date');
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
        task_date: taskDate,
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
    // No task_date in the payload: the server keeps the stored one. This flip
    // corrects the period until the next upload re-derives it from that date.
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
        ${escapeHtml(t('sitejc_delete_text', { site: site.site_id, job_code: site.job_code }))}
      </p>
      <p class="text-small text-muted mt-4">${escapeHtml(t('sitejc_delete_note'))}</p>
    `,
    onConfirm: async function () {
      // Both halves of the key: without the job code the server would take every
      // task on the site, not the one row on screen.
      await api.call('delete_site_jc', {
        site_id: site.site_id,
        job_code: site.job_code
      });
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
 * Split the tracking file's combined `Site ID-JC` cell.
 *
 * The split is on the LAST hyphen, not the first: a site id may contain one
 * (`U1120`, `194`, `H0488-2` in a hand-typed list) while the job code — the
 * project owner confirmed — never does. `K4429-ABD01` therefore gives `K4429`
 * and `ABD01`, and a cell with no hyphen at all is all site and no job code,
 * which the caller reports as a missing job code rather than guessing.
 *
 * @param {string} value
 * @return {{site_id: string, job_code: string}}
 */
function splitSiteJc(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  const cut = text.lastIndexOf('-');

  if (cut <= 0 || cut === text.length - 1) return { site_id: text, job_code: '' };

  return {
    site_id: text.slice(0, cut).trim(),
    job_code: text.slice(cut + 1).trim()
  };
}

/**
 * Turn parsed sheet rows into `{site_id, job_code, task_date}` and find
 * everything wrong with them.
 *
 * Validation mirrors validateSiteJcRow() in Admin.gs, on purpose: the server is
 * all-or-nothing, so a preview that passed rows the server would reject would
 * just produce a confusing failure after the upload.
 *
 * The period is NOT computed here and not sent. The server derives it from the
 * task date against `fiscal_new_from_year`, which keeps one authority for the
 * old/new split rather than two that can disagree (rule 14).
 *
 * @param {{headers: Array<string>, rows: Array<Object>}} parsed
 * @return {{rows: Array<Object>, problems: Array<Object>, duplicates: number,
 *           undated: number, missingColumns: Array<string>, hasTaskDate: boolean}}
 */
function mapRows(parsed) {
  const headers = parsed.headers || [];
  const has = function (field) {
    return COLUMN_ALIASES[field].some(function (alias) { return headers.indexOf(alias) !== -1; });
  };

  /*
   * Which columns are missing entirely — far more useful to report once than as
   * the same error on all 2000 rows. The site and its job code may arrive either
   * as one combined column or as two, so only the shape that is wholly absent
   * counts as missing.
   */
  const missingColumns = [];
  if (!has('site_jc') && !(has('site_id') && has('job_code'))) missingColumns.push('site_jc');

  const hasTaskDate = has('task_date');
  const rows = [];
  const problems = [];
  const seen = {};
  let duplicates = 0;
  let undated = 0;

  (parsed.rows || []).forEach(function (raw) {
    const combined = pickField(raw, COLUMN_ALIASES.site_jc);
    const split = combined ? splitSiteJc(combined) : null;

    const siteId = split ? split.site_id : pickField(raw, COLUMN_ALIASES.site_id);
    const jobCode = split ? split.job_code : pickField(raw, COLUMN_ALIASES.job_code);

    // The raw cell, so a real Excel date is read as a date rather than as
    // whatever text its number format produced.
    const taskDate = parseSheetDate(pickRawField(raw, COLUMN_ALIASES.task_date));

    const reasons = [];
    if (!siteId) reasons.push(t('sitejc_site_required'));
    else if (siteId.indexOf('/') !== -1) reasons.push(t('sitejc_single_site_only'));
    else if (siteId.length > MAX_FIELD_LENGTH) {
      reasons.push(t('sitejc_too_long', { max: MAX_FIELD_LENGTH }));
    }

    if (!jobCode) {
      reasons.push(combined ? t('sitejc_jc_unsplittable', { value: combined }) : t('sitejc_jc_required'));
    } else if (jobCode.indexOf('/') !== -1) {
      reasons.push(t('sitejc_single_jc_only'));
    } else if (jobCode.length > MAX_FIELD_LENGTH) {
      reasons.push(t('sitejc_too_long', { max: MAX_FIELD_LENGTH }));
    }

    if (reasons.length) {
      problems.push({ row: raw._row, site_id: combined || siteId, reasons: reasons });
      return;
    }

    // A task with no readable date is imported and settles as `new` — the
    // owner's rule. Counted so the preview can say how many that is.
    if (!taskDate) undated++;

    // Case-insensitive within the file too, so an upload holding both
    // `k3799-abd01` and `K3799-ABD01` sends one row. Last one wins, exactly as
    // the server does it.
    const key = rowKey(siteId, jobCode);
    const record = { site_id: siteId, job_code: jobCode, task_date: taskDate };

    if (Object.prototype.hasOwnProperty.call(seen, key)) {
      duplicates++;
      rows[seen[key]] = record;
      return;
    }

    seen[key] = rows.length;
    rows.push(record);
  });

  return {
    rows: rows,
    problems: problems,
    duplicates: duplicates,
    undated: undated,
    missingColumns: missingColumns,
    hasTaskDate: hasTaskDate
  };
}

/**
 * What the upload would do to the lookup as it stands.
 *
 * Computed against the rows this screen already loaded, so a manager sees the
 * size of a full replace — above all how many pairs would be REMOVED — before he
 * commits to it. The server recomputes the same thing while it writes; these are
 * the numbers to decide by, not the receipt.
 *
 * Comparing task dates alone is enough to spot a changed row: the period is a
 * function of the date, so a date that has not moved cannot have moved the
 * period either.
 *
 * @param {Array<Object>} incoming from mapRows().
 * @return {{added: number, changed: number, unchanged: number, removed: number}}
 */
function diffAgainstStored(incoming) {
  const stored = {};
  sites.forEach(function (site) {
    stored[rowKey(site.site_id, site.job_code)] = site;
  });

  let added = 0;
  let changed = 0;
  let unchanged = 0;
  const matched = {};

  incoming.forEach(function (row) {
    const key = rowKey(row.site_id, row.job_code);
    const was = stored[key];

    if (!was) { added++; return; }

    matched[key] = true;
    if ((was.task_date || '') === (row.task_date || '')) unchanged++;
    else changed++;
  });

  const removed = Object.keys(stored).filter(function (key) {
    return !matched[key];
  }).length;

  return { added: added, changed: changed, unchanged: unchanged, removed: removed };
}

/**
 * The preview.
 *
 * A handful of unreadable rows does NOT block the import. A real tracking export
 * runs to thousands of rows and reliably carries a few stragglers — a cell with
 * no hyphen in it, a stray note typed into the site column — and holding 9,000
 * good rows hostage to 4 bad ones would send the manager back to Excel to clean
 * a file he did not make. Bad rows are listed, counted, and skipped, and the
 * confirm button says exactly how many of each so the choice is never implicit.
 *
 * What DOES block, because none of it can be salvaged row by row:
 *
 *   - a missing Site ID-JC column — the file is not the file we think it is;
 *   - nothing usable in it at all;
 *   - more rows than one import can carry.
 *
 * @param {File} file
 * @param {Object} parsed from readSheetRows().
 * @param {Object} report from mapRows().
 */
function openImportDialog(file, parsed, report) {
  const blocked = report.missingColumns.length > 0 ||
                  report.rows.length === 0 ||
                  report.rows.length > MAX_IMPORT_ROWS;

  const skipped = report.problems.length;

  // Only meaningful against a lookup we actually read — see `loaded`.
  const diff = loaded ? diffAgainstStored(report.rows) : null;

  openModal({
    title: t('sitejc_upload_title'),
    wide: true,
    confirmLabel: blocked
      ? ''
      : (skipped
          ? t('import_confirm_skipping', { ready: report.rows.length, skipped: skipped })
          : t('import_confirm')),
    cancelLabel: blocked ? t('close') : t('cancel'),

    bodyHtml: `
      <div class="stack">
        <div class="text-small text-secondary">
          ${escapeHtml(t('import_file_line', { file: file.name, sheet: parsed.sheet_name }))}
        </div>

        <div class="import-stats">
          ${importStat(report.rows.length, t('import_stat_ready'))}
          ${importStat(skipped, t('import_stat_skipped'))}
          ${importStat(report.duplicates, t('import_stat_duplicates'))}
        </div>

        ${(!blocked && diff) ? `
          <div>
            <div class="section-title">${escapeHtml(t('import_effect_title'))}</div>
            <div class="import-stats">
              ${importStat(diff.added, t('import_stat_added'))}
              ${importStat(diff.changed, t('import_stat_changed'))}
              ${importStat(diff.unchanged, t('import_stat_unchanged'))}
              ${importStat(diff.removed, t('import_stat_removed'))}
            </div>
          </div>
        ` : ''}

        ${report.missingColumns.length ? `
          <div class="alert alert-danger">
            ${escapeHtml(t('import_missing_columns', {
              columns: report.missingColumns.map(function (c) { return t('col_' + c); }).join(', ')
            }))}
          </div>
        ` : ''}

        ${renderProblems(report.problems, !blocked)}

        ${report.rows.length > MAX_IMPORT_ROWS ? `
          <div class="alert alert-danger">
            ${escapeHtml(t('import_too_many', { max: MAX_IMPORT_ROWS }))}
          </div>
        ` : ''}

        ${(blocked && !report.rows.length && skipped) ? `
          <div class="alert alert-danger">${escapeHtml(t('import_none_usable'))}</div>
        ` : ''}

        ${!blocked ? `
          <div class="alert alert-warning">
            ${escapeHtml(!diff
              ? t('import_replace_unknown')
              : (diff.removed
                  ? t('import_replace_warning', { removed: diff.removed })
                  : t('import_replace_note')))}
          </div>
        ` : ''}

        ${!blocked ? `
          <div class="alert alert-info">${escapeHtml(t('import_period_note'))}</div>
        ` : ''}

        ${(!blocked && !report.hasTaskDate) ? `
          <div class="alert alert-warning">${escapeHtml(t('import_no_task_date_column'))}</div>
        ` : ''}

        ${(!blocked && report.hasTaskDate && report.undated) ? `
          <div class="text-small text-muted">
            ${escapeHtml(t('import_undated_note', { count: report.undated }))}
          </div>
        ` : ''}

        ${report.duplicates && !blocked ? `
          <div class="text-small text-muted">${escapeHtml(t('import_duplicates_note'))}</div>
        ` : ''}

        ${!report.rows.length && !skipped ? `
          <div class="alert alert-warning">${escapeHtml(t('import_no_rows'))}</div>
        ` : ''}
      </div>
    `,

    onConfirm: blocked ? null : async function () {
      const result = await api.call('bulk_import_site_jc', {
        rows: report.rows,
        mode: 'replace'
      });

      toastSuccess(t('import_done', {
        created: (result && result.created) || 0,
        updated: (result && result.updated) || 0,
        removed: (result && result.removed) || 0
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
 * The rows that could not be read, capped so a wholly broken file does not
 * produce a dialog thousands of lines long.
 *
 * The heading changes with what is about to happen to them: when the import can
 * still go ahead they are being SKIPPED, and saying "rows that need fixing" over
 * a list nobody has to fix would misread as a wall the manager has to climb.
 * They are still listed in full — skipped is not the same as hidden, and these
 * are the lines to correct at source before the next export.
 *
 * @param {Array<Object>} problems
 * @param {boolean} skipping true when the import will proceed without them.
 * @return {string} HTML
 */
function renderProblems(problems, skipping) {
  if (!problems.length) return '';

  const shown = problems.slice(0, MAX_PROBLEMS_SHOWN);
  const rest = problems.length - shown.length;

  return `
    <div>
      <div class="section-title">
        ${escapeHtml(skipping ? t('import_skipped_title') : t('import_problems_title'))}
      </div>
      ${skipping ? `
        <div class="text-small text-muted mb-4">
          ${escapeHtml(t('import_skipped_note', { count: problems.length }))}
        </div>
      ` : ''}
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
