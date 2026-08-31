/**
 * grid.js — the Excel-like entry grid (CLAUDE.md 6.5, 6.6, rule 5.3).
 *
 * This is the one screen that opts out of the app's render-everything-again
 * rule, and it has to. A grid that rebuilt its own HTML on every keystroke would
 * lose the caret mid-word, so:
 *
 *   - A cell edit updates the in-memory row model and touches ONLY the cells
 *     that changed appearance — the row's flag colour, the footer total, the
 *     banner. The <input> the coordinator is typing in is never replaced.
 *   - A full re-render happens on STRUCTURAL change only: adding a row, deleting
 *     one, switching tab. Focus and caret are captured before and restored
 *     after, so even that is invisible.
 *
 * The model is local-first (6.5). Every change is mirrored to
 * `sc_draft_<settlement_id>_<kind>` so a refresh or a crash never loses typing.
 * Sheets are written on Save and Confirm, never on a keystroke — an Apps Script
 * round trip is one to two seconds, and a grid that did that per character would
 * be unusable.
 *
 * WHAT THIS FILE DOES NOT DO YET: Site -> Job Code autofill and paste-from-Excel
 * are 6.6.1 and 6.6.3, and live in gridAutofill.js and gridPaste.js. The hooks
 * they need are already here — `hooks.onCellCommit` fires after every committed
 * edit, and the controller exposes addRows()/rerender() — so wiring them is
 * additive.
 */

import { t } from '../i18n/i18n.js';
import { escapeHtml, qs, qsa } from '../utils/dom.js';
import { validateRows, toNumber, text as asText, period as asPeriod } from '../utils/validate.js';
import { formatMoney } from '../utils/money.js';
import { resolveSite, rowEntryDate } from './gridAutofill.js';
import { saveDraft, getDraft } from '../state.js';

/**
 * The columns of each grid, in the order CLAUDE.md 2.2 lists them.
 *
 * `type` decides the control:
 *   text   — a plain input
 *   number — an integer input (day)
 *   money  — a decimal input, right-aligned, totalled in the footer
 *   km     — a decimal input, NOT totalled (a KM reading is a position, not a
 *            quantity; summing odometer readings is meaningless)
 *   list   — a <select> when the option list is known, a datalist-backed input
 *            when it is not (see renderListCell)
 *   period — the old/new select, whose two options are fixed and always known
 */
const COLUMNS = {
  expense: [
    { key: 'month',            type: 'text',   labelKey: 'col_month',    width: 70 },
    { key: 'day',              type: 'number', labelKey: 'col_day',      width: 56 },
    { key: 'project',          type: 'list',   labelKey: 'col_project',  width: 120, list: 'projects' },
    { key: 'site_id',          type: 'text',   labelKey: 'col_site_id',  width: 140, num: true },
    { key: 'job_code',         type: 'text',   labelKey: 'col_job_code', width: 130, num: true },
    { key: 'period',           type: 'period', labelKey: 'col_period',   width: 92 },
    { key: 'category',         type: 'list',   labelKey: 'col_category', width: 130, list: 'categories' },
    { key: 'item_description', type: 'text',   labelKey: 'col_item',     width: 200 },
    { key: 'amount',           type: 'money',  labelKey: 'col_amount',   width: 110 },
    { key: 'comment',          type: 'text',   labelKey: 'col_comment',  width: 160 },
    { key: 'team',             type: 'list',   labelKey: 'col_team',     width: 130, list: 'teams' }
  ],
  fuel: [
    { key: 'month',        type: 'text',   labelKey: 'col_month',    width: 70 },
    { key: 'day',          type: 'number', labelKey: 'col_day',      width: 56 },
    { key: 'project',      type: 'list',   labelKey: 'col_project',  width: 120, list: 'projects' },
    { key: 'site_id',      type: 'text',   labelKey: 'col_site_id',  width: 140, num: true },
    { key: 'job_code',     type: 'text',   labelKey: 'col_job_code', width: 130, num: true },
    { key: 'period',       type: 'period', labelKey: 'col_period',   width: 92 },
    { key: 'start_km',     type: 'km',     labelKey: 'col_start_km', width: 96 },
    { key: 'end_km',       type: 'km',     labelKey: 'col_end_km',   width: 96 },
    { key: 'fuel_amount',  type: 'money',  labelKey: 'col_fuel',     width: 105 },
    { key: 'area',         type: 'list',   labelKey: 'col_area',     width: 120, list: 'areas' },
    { key: 'driver',       type: 'list',   labelKey: 'col_driver',   width: 120, list: 'drivers' },
    { key: 'city',         type: 'text',   labelKey: 'col_city',     width: 110 },
    { key: 'karta_amount', type: 'money',  labelKey: 'col_karta',    width: 105 },
    { key: 'team',         type: 'list',   labelKey: 'col_team',     width: 130, list: 'teams' }
  ]
};

/** Carried down from the row above onto a new row (CLAUDE.md 6.6.2). */
const CARRY_DOWN_FIELDS = ['team', 'project', 'month', 'day', 'period'];

/**
 * How long a burst of typing is allowed to run before the localStorage mirror
 * is written.
 *
 * 6.5 says "mirrored on every change". Serialising a few hundred rows on every
 * single keystroke would put the lag back in exactly the place the local-first
 * design exists to remove, so the write is coalesced across a quarter second and
 * flushed immediately on blur, on any structural change, and on page unload.
 * The worst case is a quarter second of typing lost to a crash, and typing never
 * stutters.
 */
const MIRROR_DEBOUNCE_MS = 250;

/** Client-side row identity, for focus restore across a re-render. */
let uidCounter = 0;

/* ================================================================== *
 * The row model
 * ================================================================== */

/**
 * A blank row, optionally carrying values down from the row above (6.6.2).
 *
 * @param {string} kind
 * @param {Object} [previous] the row above.
 * @return {Object}
 */
export function makeRow(kind, previous) {
  const row = {
    _uid: 'r' + (++uidCounter),
    entry_id: '',
    status: 'draft',
    return_note: '',
    exported: false,
    tracking_no: null
  };

  COLUMNS[kind].forEach(function (column) { row[column.key] = ''; });

  if (previous) {
    CARRY_DOWN_FIELDS.forEach(function (key) {
      if (previous[key] !== undefined && previous[key] !== null) row[key] = previous[key];
    });
  }

  return row;
}

/**
 * Turn a server entry into a grid row.
 * @param {string} kind
 * @param {Object} entry from `list_entries`.
 * @return {Object}
 */
export function entryToRow(kind, entry) {
  const row = {
    _uid: 'r' + (++uidCounter),
    entry_id: entry.entry_id || '',
    status: String(entry.status || 'draft').toLowerCase(),
    return_note: entry.return_note || '',
    exported: !!entry.exported,
    tracking_no: entry.tracking_no === undefined ? null : entry.tracking_no
  };

  COLUMNS[kind].forEach(function (column) {
    const value = entry[column.key];
    row[column.key] = (value === null || value === undefined) ? '' : value;
  });

  return row;
}

/**
 * The fields a row contributes to a save. Everything the server owns — status,
 * approval, export, audit — is left out (rule 8).
 *
 * @param {string} kind
 * @param {Object} row
 * @return {Object}
 */
export function rowToPayload(kind, row) {
  const out = {};
  if (row.entry_id) out.entry_id = row.entry_id;

  COLUMNS[kind].forEach(function (column) {
    out[column.key] = row[column.key];
  });

  return out;
}

/** @param {string} kind @return {Array<Object>} the column definitions. */
export function gridColumns(kind) {
  return COLUMNS[kind] || COLUMNS.expense;
}

/** A row nobody has typed anything into — not worth saving. */
function isRowEmpty(kind, row) {
  return COLUMNS[kind].every(function (column) {
    return asText(row[column.key]) === '';
  });
}

/** An exported row is locked against every kind of edit (rule 13). */
function isRowLocked(row) {
  return String(row.status || '').toLowerCase() === 'exported';
}

/* ================================================================== *
 * Rendering
 * ================================================================== */

/**
 * The whole grid: a scrolling table plus its totals footer.
 *
 * @param {Object} model { kind, rows, reference, siteJcMap }
 * @return {string} HTML
 */
export function renderGrid(model) {
  const kind = model.kind;
  const columns = gridColumns(kind);
  const report = validateRows(kind, model.rows, { siteJcMap: model.siteJcMap });

  return `
    <div class="grid-scroll">
      <table class="grid" data-kind="${escapeHtml(kind)}">
        <thead>
          <tr>
            <th class="grid-gutter"><span class="sr-only">${escapeHtml(t('grid_row_number'))}</span></th>
            <th class="grid-status-col">${escapeHtml(t('status'))}</th>
            ${columns.map(function (column) {
              return `<th style="min-inline-size:${column.width}px">${escapeHtml(t(column.labelKey))}</th>`;
            }).join('')}
            <th class="grid-actions-col"><span class="sr-only">${escapeHtml(t('actions'))}</span></th>
          </tr>
        </thead>

        <tbody id="grid-body">
          ${model.rows.length
            ? model.rows.map(function (row, index) {
                return renderRow(kind, columns, row, index, report.rows[index]);
              }).join('')
            : renderEmptyRow(columns)}
        </tbody>

        ${renderFooter(kind, columns, model.rows)}
      </table>
    </div>
  `;
}

/**
 * One grid row.
 *
 * @param {string} kind
 * @param {Array<Object>} columns
 * @param {Object} row
 * @param {number} index
 * @param {Object} check from validateRows().
 * @return {string} HTML
 */
function renderRow(kind, columns, row, index, check) {
  const locked = isRowLocked(row);
  const issues = check || { flags: [], warnings: [] };

  return `
    <tr class="grid-row ${rowStateClass(issues, locked)}"
        data-uid="${escapeHtml(row._uid)}" data-index="${index}">

      <td class="grid-gutter num">${index + 1}</td>

      <td class="grid-status-col">${renderStatusCell(row)}</td>

      ${columns.map(function (column) {
        return renderCell(kind, column, row, issues, locked);
      }).join('')}

      <td class="grid-actions-col">
        ${locked
          ? `<span class="grid-lock" title="${escapeHtml(t('grid_row_locked'))}" aria-label="${escapeHtml(t('grid_row_locked'))}">🔒</span>`
          : `<button class="icon-btn icon-btn-danger" type="button" data-grid-action="delete"
                     title="${escapeHtml(t('grid_delete_row'))}"
                     aria-label="${escapeHtml(t('grid_delete_row'))}">✕</button>`}
      </td>
    </tr>
  `;
}

/**
 * The class that colours a row: red for a flag, amber for a warning, grey when
 * locked. A flag outranks a warning — the worse news wins.
 *
 * @param {Object} issues
 * @param {boolean} locked
 * @return {string}
 */
function rowStateClass(issues, locked) {
  const classes = [];
  if (locked) classes.push('is-locked');
  if (issues.flags.length) classes.push('is-flagged');
  else if (issues.warnings.length) classes.push('is-warned');
  return classes.join(' ');
}

/**
 * The read-only status cell. A returned row carries the manager's note as a
 * tooltip — it is the whole reason the row came back.
 *
 * @param {Object} row
 * @return {string} HTML
 */
function renderStatusCell(row) {
  const status = String(row.status || 'draft').toLowerCase();
  const note = asText(row.return_note);

  return `
    <span class="badge badge-${escapeHtml(status)}"
          ${note ? `title="${escapeHtml(note)}"` : ''}>
      ${escapeHtml(t('entry_status_' + status))}
    </span>
    ${note ? `<span class="grid-note-dot" title="${escapeHtml(note)}" aria-label="${escapeHtml(note)}">●</span>` : ''}
  `;
}

/**
 * One editable cell.
 *
 * @param {string} kind
 * @param {Object} column
 * @param {Object} row
 * @param {Object} issues
 * @param {boolean} locked
 * @return {string} HTML
 */
function renderCell(kind, column, row, issues, locked) {
  const flagged = issues.flags.some(function (issue) { return issue.field === column.key; });
  const warned = issues.warnings.some(function (issue) { return issue.field === column.key; });

  const cellClass = [
    'grid-cell',
    flagged ? 'is-flagged' : '',
    (!flagged && warned) ? 'is-warned' : ''
  ].filter(Boolean).join(' ');

  const control = (column.type === 'period')
    ? renderPeriodCell(column, row, locked)
    : (column.type === 'list')
      ? renderListCell(kind, column, row, locked)
      : (column.key === 'job_code')
        ? renderJobCodeCell(column, row, locked)
        : renderInputCell(column, row, locked);

  return `<td class="${cellClass}" data-field="${escapeHtml(column.key)}">${control}</td>`;
}

/**
 * The Job Code cell, which is a plain input plus a way out of an ambiguity.
 *
 * A site now carries one job code per task raised against it (2.1), so `K3602`
 * has both `ABD02` and `ABD12`. Autofill picks the one whose task date fits the
 * day being settled (6.6.3), which is right nearly always — but "nearly" is not
 * good enough for a field that decides what finance is billed against, so the
 * alternatives are one click away:
 *
 *   - a `<datalist>` of every job code the lookup holds for the site, each
 *     labelled with its task date, so the browser's own dropdown offers them;
 *   - a small count beside the cell, because an alternative nobody knows exists
 *     is not a choice.
 *
 * It stays an INPUT rather than becoming a select: a multi-site cell holds
 * `CABH783/CABH789`, and an unknown site holds whatever the coordinator types.
 * Neither is expressible as a list of options.
 *
 * @return {string} HTML
 */
function renderJobCodeCell(column, row, locked) {
  const options = row.__jc_options || [];
  const listId = 'jc-' + row._uid;

  return `
    <div class="grid-jc">
      <input class="grid-input num" type="text"
             data-field="job_code"
             data-uid="${escapeHtml(row._uid)}"
             value="${escapeHtml(row.job_code)}"
             ${options.length > 1 ? `list="${escapeHtml(listId)}"` : ''}
             ${locked ? 'readonly tabindex="-1"' : ''}
             aria-label="${escapeHtml(t(column.labelKey))}">

      <datalist id="${escapeHtml(listId)}" data-jc-list="${escapeHtml(row._uid)}">
        ${renderJcOptions(options)}
      </datalist>

      ${options.length > 1
        ? `<span class="grid-jc-count" data-jc-count="${escapeHtml(row._uid)}"
                 title="${escapeHtml(t('grid_jc_choices', { count: options.length }))}"
                 aria-label="${escapeHtml(t('grid_jc_choices', { count: options.length }))}"
           >${options.length}</span>`
        : `<span class="grid-jc-count is-hidden" data-jc-count="${escapeHtml(row._uid)}"></span>`}
    </div>
  `;
}

/**
 * The options of one job-code picker. The task date is the LABEL, not the
 * value — picking one must put the bare job code in the cell.
 *
 * @param {Array<Object>} options
 * @return {string} HTML
 */
function renderJcOptions(options) {
  return (options || []).map(function (option) {
    return `<option value="${escapeHtml(option.job_code)}" label="${escapeHtml(
      t('grid_jc_option', {
        date: option.task_date || t('grid_jc_no_date'),
        period: t('period_' + (option.period || 'new'))
      })
    )}"></option>`;
  }).join('');
}

/**
 * A text, number, money or KM cell.
 * @return {string} HTML
 */
function renderInputCell(column, row, locked) {
  const numeric = column.type === 'money' || column.type === 'km' || column.type === 'number';

  const classes = [
    'grid-input',
    (numeric || column.num) ? 'num' : '',
    numeric ? 'is-numeric' : ''
  ].filter(Boolean).join(' ');

  return `
    <input class="${classes}" type="text"
           ${numeric ? 'inputmode="decimal"' : ''}
           data-field="${escapeHtml(column.key)}"
           data-uid="${escapeHtml(row._uid)}"
           value="${escapeHtml(row[column.key])}"
           ${locked ? 'readonly tabindex="-1"' : ''}
           aria-label="${escapeHtml(t(column.labelKey))}">
  `;
}

/**
 * The period cell. Its two options are fixed by the schema, so this select
 * always works — and it is coloured amber/blue like every other period marker in
 * the app (8.3), because this is the field that decides which Tracking# the row
 * settles against.
 *
 * @return {string} HTML
 */
function renderPeriodCell(column, row, locked) {
  const value = asPeriod(row.period);

  return `
    <select class="grid-select grid-period ${value ? 'is-' + value : 'is-unset'}"
            data-field="period" data-uid="${escapeHtml(row._uid)}"
            ${locked ? 'disabled' : ''}
            aria-label="${escapeHtml(t('col_period'))}">
      <option value=""${value ? '' : ' selected'}>—</option>
      <option value="old"${value === 'old' ? ' selected' : ''}>${escapeHtml(t('period_old'))}</option>
      <option value="new"${value === 'new' ? ' selected' : ''}>${escapeHtml(t('period_new'))}</option>
    </select>
  `;
}

/**
 * A dropdown cell — project, category, area, driver, team.
 *
 * Renders a real <select> when the option list is known. When it is NOT known it
 * falls back to a plain input rather than an empty select, because an empty
 * select is a cell the coordinator physically cannot fill in.
 *
 * That fallback is load-bearing right now: `list_lists` and `list_teams` are
 * manager-only (3.4), so a coordinator's client cannot read the option lists at
 * all. See the note in settlement.js. The moment the server offers them, these
 * cells become selects with no change here.
 *
 * A value already on the row that is not in the list is kept and shown — an
 * option deactivated after the row was typed must not silently vanish from it.
 *
 * @return {string} HTML
 */
function renderListCell(kind, column, row, locked) {
  const reference = row.__reference || null;
  const options = reference ? reference[column.list] : null;
  const value = asText(row[column.key]);

  if (!options || !options.length) {
    return `
      <input class="grid-input" type="text"
             data-field="${escapeHtml(column.key)}"
             data-uid="${escapeHtml(row._uid)}"
             value="${escapeHtml(value)}"
             ${locked ? 'readonly tabindex="-1"' : ''}
             aria-label="${escapeHtml(t(column.labelKey))}">
    `;
  }

  const known = options.indexOf(value) !== -1;

  return `
    <select class="grid-select" data-field="${escapeHtml(column.key)}"
            data-uid="${escapeHtml(row._uid)}"
            ${locked ? 'disabled' : ''}
            aria-label="${escapeHtml(t(column.labelKey))}">
      <option value=""${value ? '' : ' selected'}>—</option>
      ${options.map(function (option) {
        return `<option value="${escapeHtml(option)}"${option === value ? ' selected' : ''}>${escapeHtml(option)}</option>`;
      }).join('')}
      ${(!known && value)
        ? `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)}</option>`
        : ''}
    </select>
  `;
}

/** The placeholder line shown when the grid has no rows at all. */
function renderEmptyRow(columns) {
  return `
    <tr class="grid-empty-row">
      <td colspan="${columns.length + 3}">
        <div class="empty-state">
          <div class="empty-icon" aria-hidden="true">▦</div>
          <div class="empty-title">${escapeHtml(t('grid_empty_title'))}</div>
          <div class="empty-text">${escapeHtml(t('grid_empty_text'))}</div>
        </div>
      </td>
    </tr>
  `;
}

/**
 * The totals row.
 *
 * Money columns are summed; KM columns deliberately are not. A start/end reading
 * is a position on an odometer, and adding them together would produce a large
 * number that means nothing — the same reason 6.4 refuses to divide KM on the
 * per-site export.
 *
 * @return {string} HTML
 */
function renderFooter(kind, columns, rows) {
  return `
    <tfoot>
      <tr class="grid-total-row">
        <td class="grid-gutter"></td>
        <td class="grid-status-col text-tiny text-muted">${escapeHtml(t('grid_total'))}</td>
        ${columns.map(function (column) {
          if (column.type !== 'money') return '<td></td>';
          return `<td class="grid-total num" data-total-for="${escapeHtml(column.key)}">${escapeHtml(formatMoney(sumColumn(rows, column.key)))}</td>`;
        }).join('')}
        <td class="grid-actions-col"></td>
      </tr>
    </tfoot>
  `;
}

/** @return {number} */
function sumColumn(rows, key) {
  return (rows || []).reduce(function (total, row) {
    return total + (toNumber(row[key]) || 0);
  }, 0);
}

/*
 * Money formatting moved to utils/money.js, where the file map puts it (9.1) —
 * the manager's approvals and export screens need the same two decimals as the
 * grid's footer totals. Re-exported here so nothing that already imports it from
 * the grid has to change.
 */
export { formatMoney };

/* ================================================================== *
 * Behaviour
 * ================================================================== */

/**
 * Wire one grid and return its controller.
 *
 * @param {Object} model { settlementId, kind, rows, reference, siteJcMap }
 * @param {Object} [hooks]
 * @param {Function} [hooks.onChange] called with the validation report after
 *        every change, structural or not — the page's banner and totals listen
 *        to this.
 * @param {Function} [hooks.onCellCommit] called as (row, field, value) once an
 *        edit settles. This is where gridAutofill.js hangs the Site -> Job Code
 *        lookup (6.6.3).
 * @param {Function} [hooks.onDeleteSaved] called as (row) when a row that exists
 *        on the server is deleted, so the page can call `delete_entry`.
 * @return {Object} the controller.
 */
export function bindGridEvents(model, hooks = {}) {
  const host = qs('#grid-host');
  if (!host) return null;

  let mirrorTimer = null;
  let dead = false;

  /* --- the localStorage mirror (6.5) --- */

  /**
   * The `saved_at` of the draft record this controller considers its own.
   *
   * Seeded from whatever is already stored, because the rows this grid was built
   * from came out of exactly that record (settlement.js's seedRows), and updated
   * on every write. It is what lets the guard below tell "my own last write"
   * from "somebody else has moved on".
   */
  let mirrorOwnedAt = '';
  const seeded = getDraft(model.settlementId, model.kind);
  if (seeded && seeded.saved_at) mirrorOwnedAt = seeded.saved_at;

  /**
   * Has the stored draft moved past this controller?
   *
   * This is the guard that stops a retired grid undoing a live one, and it has
   * to be a comparison rather than a DOM check. Tearing the grid out of the page
   * fires a `focusout` on whichever input held the caret, and that handler runs
   * while the host STILL reports itself connected — so "am I still on screen?"
   * cannot tell a real blur from a teardown. "Is the stored draft newer than the
   * one I wrote?" can, and is true exactly when writing would destroy someone
   * else's newer work.
   *
   * @return {boolean}
   */
  const storedMovedOn = function () {
    const current = getDraft(model.settlementId, model.kind);
    if (!current || !current.saved_at) return false;      // nothing to protect
    if (!mirrorOwnedAt) return true;                      // written while we held none

    return Date.parse(current.saved_at) > Date.parse(mirrorOwnedAt);
  };

  /** May this controller still write? */
  const canWrite = function () {
    return !dead && !storedMovedOn();
  };

  const writeMirror = function () {
    const stamp = saveDraft(model.settlementId, model.kind, model.rows.map(stripRow));
    if (stamp) mirrorOwnedAt = stamp;
  };

  const flushMirror = function () {
    if (mirrorTimer) {
      window.clearTimeout(mirrorTimer);
      mirrorTimer = null;
    }
    if (!canWrite()) return;
    writeMirror();
  };

  const scheduleMirror = function () {
    if (mirrorTimer) window.clearTimeout(mirrorTimer);
    mirrorTimer = window.setTimeout(function () {
      mirrorTimer = null;
      if (canWrite()) writeMirror();
    }, MIRROR_DEBOUNCE_MS);
  };

  /* A crash is one thing; closing the tab is another. Never lose the last burst. */
  const onUnload = function () {
    if (mirrorTimer) {
      window.clearTimeout(mirrorTimer);
      mirrorTimer = null;
    }
    if (canWrite()) writeMirror();
  };
  window.addEventListener('beforeunload', onUnload);

  /* --- validation, totals and the banner, without a re-render --- */

  const revalidate = function () {
    const report = validateRows(model.kind, model.rows, { siteJcMap: model.siteJcMap });
    paintIssues(report);
    paintTotals();
    if (typeof hooks.onChange === 'function') hooks.onChange(report, model);
    return report;
  };

  /**
   * Repaint only what a validation pass can change: the row's state class and
   * the per-cell markers. Every <input> is left exactly as it is, caret and all.
   */
  const paintIssues = function (report) {
    qsa('#grid-body tr.grid-row', host).forEach(function (tr, index) {
      const issues = report.rows[index] || { flags: [], warnings: [] };
      const locked = tr.classList.contains('is-locked');

      tr.classList.toggle('is-flagged', issues.flags.length > 0);
      tr.classList.toggle('is-warned', issues.flags.length === 0 && issues.warnings.length > 0);
      if (locked) tr.classList.add('is-locked');

      qsa('td.grid-cell', tr).forEach(function (td) {
        const field = td.dataset.field;
        const isFlagged = issues.flags.some(function (i) { return i.field === field; });
        const isWarned = !isFlagged && issues.warnings.some(function (i) { return i.field === field; });

        td.classList.toggle('is-flagged', isFlagged);
        td.classList.toggle('is-warned', isWarned);
      });
    });
  };

  const paintTotals = function () {
    qsa('[data-total-for]', host).forEach(function (cell) {
      cell.textContent = formatMoney(sumColumn(model.rows, cell.dataset.totalFor));
    });
  };

  /* --- a full re-render, with the caret put back --- */

  const rerender = function (focusHint) {
    const restore = focusHint || captureFocus(host);

    host.innerHTML = renderGrid(decorate(model));
    revalidate();

    restoreFocus(host, restore);
  };

  /* --- editing --- */

  const rowFor = function (uid) {
    return model.rows.find(function (row) { return row._uid === uid; }) || null;
  };

  /*
   * `input` fires on every keystroke. It writes the model and schedules the
   * mirror, and repaints validation — but it must never touch the element that
   * fired it, or typing would fight the caret.
   */
  host.addEventListener('input', function (event) {
    const control = event.target.closest('[data-field][data-uid]');
    if (!control) return;

    const row = rowFor(control.dataset.uid);
    if (!row || isRowLocked(row)) return;

    row[control.dataset.field] = control.value;

    scheduleMirror();
    revalidate();
  });

  /*
   * `change` is the commit point: a select chosen, or an input left. Autofill
   * hangs off this rather than off `input`, so a half-typed Site ID does not
   * trigger a lookup on every character.
   */
  host.addEventListener('change', function (event) {
    const control = event.target.closest('[data-field][data-uid]');
    if (!control) return;

    const row = rowFor(control.dataset.uid);
    if (!row || isRowLocked(row)) return;

    const field = control.dataset.field;
    row[field] = control.value;

    if (field === 'period') {
      // The period cell carries its own colour (8.3); keep it honest in place.
      control.classList.remove('is-old', 'is-new', 'is-unset');
      control.classList.add(control.value ? 'is-' + control.value : 'is-unset');
    }

    if (typeof hooks.onCellCommit === 'function') {
      hooks.onCellCommit(row, field, control.value, controller);
    }

    flushMirror();
    revalidate();
  });

  host.addEventListener('focusout', function () { flushMirror(); });

  /* --- keyboard (6.6.5) --- */

  host.addEventListener('keydown', function (event) {
    const control = event.target.closest('[data-field][data-uid]');
    if (!control) return;

    /*
     * Enter moves to the same column in the next row, adding one at the end
     * (6.6.5). This is what makes the grid feel like a column of a spreadsheet
     * rather than a form: type an amount, Enter, type the next amount.
     */
    if (event.key === 'Enter') {
      event.preventDefault();
      moveDown(control);
      return;
    }

    // Not required, but the obvious partner to Enter once Enter goes down.
    if (event.key === 'ArrowDown' && control.tagName === 'INPUT') {
      event.preventDefault();
      moveDown(control, true);
    } else if (event.key === 'ArrowUp' && control.tagName === 'INPUT') {
      event.preventDefault();
      moveUp(control);
    }
  });

  const moveDown = function (control, withoutAdding) {
    const field = control.dataset.field;
    const index = model.rows.findIndex(function (row) { return row._uid === control.dataset.uid; });
    if (index === -1) return;

    if (index === model.rows.length - 1) {
      if (withoutAdding) return;
      addRow();                                   // rerenders and focuses for us
      focusCell(host, model.rows[model.rows.length - 1]._uid, field);
      return;
    }

    focusCell(host, model.rows[index + 1]._uid, field);
  };

  const moveUp = function (control) {
    const index = model.rows.findIndex(function (row) { return row._uid === control.dataset.uid; });
    if (index > 0) focusCell(host, model.rows[index - 1]._uid, control.dataset.field);
  };

  /* --- structural changes --- */

  const addRow = function () {
    const previous = model.rows.length ? model.rows[model.rows.length - 1] : null;
    const row = makeRow(model.kind, previous);       // carry-down (6.6.2)

    model.rows.push(row);
    flushMirror();
    rerender();

    return row;
  };

  const addRows = function (rows) {
    rows.forEach(function (row) { model.rows.push(row); });
    flushMirror();
    rerender();
  };

  const deleteRow = function (uid) {
    const index = model.rows.findIndex(function (row) { return row._uid === uid; });
    if (index === -1) return;

    const row = model.rows[index];
    if (isRowLocked(row)) return;                    // rule 13

    // Which column the coordinator was in, so a run of deletions keeps its place.
    const before = captureFocus(host);
    const column = (before && before.field) ? before.field : gridColumns(model.kind)[0].key;

    model.rows.splice(index, 1);
    flushMirror();

    // Focus the row that slid up into the gap.
    const next = model.rows[Math.min(index, model.rows.length - 1)];
    rerender(next ? { uid: next._uid, field: column, start: null, end: null } : null);

    if (row.entry_id && typeof hooks.onDeleteSaved === 'function') hooks.onDeleteSaved(row);
  };

  host.addEventListener('click', function (event) {
    const button = event.target.closest('[data-grid-action]');
    if (!button) return;

    const tr = button.closest('tr.grid-row');
    if (button.dataset.gridAction === 'delete' && tr) deleteRow(tr.dataset.uid);
  });

  /* --- the controller --- */

  /**
   * Push model values back into one row's cells, in place.
   *
   * This is the write half of the no-re-render rule (5.3). Autofill changes
   * `job_code` and `period` behind the coordinator's back the moment he leaves a
   * Site ID cell, and rebuilding the table to show it would take the caret with
   * it. Only the named fields are touched, and never the control that currently
   * has focus — that one belongs to whoever is typing in it.
   *
   * @param {Object} row
   * @param {Array<string>} fields
   */
  const syncRow = function (row, fields) {
    (fields || []).forEach(function (field) {
      const control = host.querySelector(
        '[data-uid="' + cssEscape(row._uid) + '"][data-field="' + cssEscape(field) + '"]'
      );
      if (!control || control === document.activeElement) return;

      control.value = (row[field] === null || row[field] === undefined) ? '' : row[field];

      if (field === 'period') {
        control.classList.remove('is-old', 'is-new', 'is-unset');
        control.classList.add(control.value ? 'is-' + control.value : 'is-unset');
      }
    });

    // Always, not only when job_code moved: resolving a Site ID can change WHICH
    // codes are on offer without changing the one that was chosen.
    paintJcOptions(row);

    revalidate();
  };

  /**
   * Repaint one row's job-code picker from `row.__jc_options`, in place.
   *
   * The datalist and its count are the only parts of a cell that autofill can
   * change without changing a value, so they are repainted here rather than by a
   * re-render — the caret is usually sitting in the Site ID cell next door (5.3).
   *
   * @param {Object} row
   */
  const paintJcOptions = function (row) {
    const options = row.__jc_options || [];
    const uid = cssEscape(row._uid);

    const list = host.querySelector('[data-jc-list="' + uid + '"]');
    if (list) list.innerHTML = renderJcOptions(options);

    const input = host.querySelector('[data-uid="' + uid + '"][data-field="job_code"]');
    if (input) {
      if (options.length > 1) input.setAttribute('list', 'jc-' + row._uid);
      else input.removeAttribute('list');
    }

    const count = host.querySelector('[data-jc-count="' + uid + '"]');
    if (count) {
      const many = options.length > 1;
      const label = many ? t('grid_jc_choices', { count: options.length }) : '';

      count.textContent = many ? String(options.length) : '';
      count.classList.toggle('is-hidden', !many);
      if (many) {
        count.setAttribute('title', label);
        count.setAttribute('aria-label', label);
      } else {
        count.removeAttribute('title');
        count.removeAttribute('aria-label');
      }
    }
  };

  const controller = {
    model: model,
    rerender: rerender,
    revalidate: revalidate,
    syncRow: syncRow,
    addRow: addRow,
    addRows: addRows,
    deleteRow: deleteRow,
    flushMirror: flushMirror,

    /**
     * The rows worth sending to the server (6.5).
     *
     * Two exclusions. An `exported` row is locked and the server would refuse it
     * anyway (rule 13). A row that is BLANK AND HAS NEVER BEEN SAVED is the
     * empty line at the bottom of every grid — sending it would create a
     * flagged entry nobody typed.
     *
     * A blank row that HAS an entry_id is still sent: the coordinator has
     * cleared a saved row, and quietly dropping that from the payload would let
     * the old values live on in the sheet while the screen showed them gone.
     *
     * @return {Array<Object>}
     */
    payloadRows: function () {
      return model.rows
        .filter(function (row) {
          if (isRowLocked(row)) return false;
          return row.entry_id ? true : !isRowEmpty(model.kind, row);
        })
        .map(function (row) { return rowToPayload(model.kind, row); });
    },

    /**
     * Retire this controller.
     *
     * Flushes FIRST — while the grid may still be connected, so a tab switch
     * keeps the last edits — then marks itself dead so nothing arriving later
     * (a teardown focusout, a debounce that has already been scheduled) can
     * write on its behalf. Idempotent, and it takes its window listener with it
     * so a session of navigation does not accumulate them.
     */
    destroy: function () {
      if (dead) return;
      flushMirror();
      dead = true;
      window.removeEventListener('beforeunload', onUnload);
    }
  };

  revalidate();
  return controller;
}

/* ------------------------------------------------------------------ *
 * Focus, and putting it back
 * ------------------------------------------------------------------ */

/**
 * Remember where the caret is, so a structural re-render is invisible.
 * @param {HTMLElement} host
 * @return {Object|null}
 */
function captureFocus(host) {
  const active = document.activeElement;
  if (!active || !host.contains(active) || !active.dataset || !active.dataset.uid) return null;

  return {
    uid: active.dataset.uid,
    field: active.dataset.field,
    // selectionStart throws on an <input> that does not support it; a select has
    // no caret to save at all.
    start: (active.tagName === 'INPUT') ? active.selectionStart : null,
    end: (active.tagName === 'INPUT') ? active.selectionEnd : null
  };
}

/**
 * Put the caret back exactly where it was.
 * @param {HTMLElement} host
 * @param {Object|null} restore from captureFocus().
 */
function restoreFocus(host, restore) {
  if (!restore) return;

  const control = focusCell(host, restore.uid, restore.field);
  if (!control || control.tagName !== 'INPUT') return;
  if (restore.start === null || restore.start === undefined) return;

  try {
    control.setSelectionRange(restore.start, restore.end);
  } catch (err) {
    /* Some input types refuse a selection range; focus alone is enough. */
  }
}

/**
 * Focus one cell.
 * @return {HTMLElement|null}
 */
function focusCell(host, uid, field) {
  const control = host.querySelector(
    '[data-uid="' + cssEscape(uid) + '"][data-field="' + cssEscape(field) + '"]'
  );
  if (control) control.focus();
  return control;
}

/** Attribute values here are our own generated uids and column keys, but quote-safe anyway. */
function cssEscape(value) {
  return String(value === undefined || value === null ? '' : value).replace(/["\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ *
 * Model plumbing
 * ------------------------------------------------------------------ */

/**
 * Hang the view-only decoration off each row so the render functions can reach
 * it without a second argument threaded through every one of them.
 *
 * Two things: the dropdown option lists, and each row's job-code candidates. The
 * candidates are seeded here rather than only on edit, so a row loaded from the
 * server shows its picker the moment the grid paints — a coordinator reopening
 * last week's work can see that a site had a second job code without having to
 * retype the Site ID to find out.
 *
 * @param {Object} model
 * @return {Object} the same model.
 */
function decorate(model) {
  model.rows.forEach(function (row) {
    row.__reference = model.reference;

    row.__jc_options = model.siteJcMap
      ? resolveSite(row.site_id, model.siteJcMap, rowEntryDate(row, model.fiscalYear)).options
      : [];
  });

  return model;
}

/**
 * The mirrored form of a row.
 *
 * Anything named with a leading double underscore is view-only decoration —
 * `__reference`, `__jc_options` — rebuilt from the reference data on load, and
 * serialising it into every draft write would be pure weight.
 */
function stripRow(row) {
  const copy = {};
  Object.keys(row).forEach(function (key) {
    if (key.indexOf('__') === 0) return;
    copy[key] = row[key];
  });
  return copy;
}

export { decorate as decorateGridModel, isRowEmpty, isRowLocked };
