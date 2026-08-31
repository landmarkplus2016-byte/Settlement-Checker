/**
 * gridPaste.js — paste from Excel (CLAUDE.md 6.6.1).
 *
 * A coordinator who already has a block of rows in a spreadsheet should not have
 * to retype it. Copying it and pressing Ctrl+V anywhere in the grid appends the
 * rows, mapping the columns in the order 2.2 documents them and running the
 * Site → Job Code lookup over each one as it lands.
 *
 * This is explicitly NOT an import pipeline. CLAUDE.md's Non-Goals are clear
 * that there is no field-team import; this is a convenience for the
 * coordinator's OWN data, and everything it produces is an ordinary draft row
 * that has to survive the same validation as one typed by hand.
 *
 * Two entry points, one code path:
 *   - Ctrl+V into the grid, when the clipboard holds more than a single cell.
 *   - The "Paste from Excel" button, which opens a textarea for the same text.
 *     That one exists because pasting into a grid cell is not discoverable, and
 *     because some browsers hand a paste event nothing useful.
 */

import { t } from '../i18n/i18n.js';
import { escapeHtml } from '../utils/dom.js';
import { openModal } from '../components/modal.js';
import { text as asText, period as asPeriod } from '../utils/validate.js';
import { gridColumns, makeRow } from './grid.js';
import { autofillRow, rowEntryDate } from './gridAutofill.js';

/** Refuse a paste larger than this — it is a convenience, not an importer. */
const MAX_PASTE_ROWS = 500;

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/**
 * Split clipboard text into a matrix of cells.
 *
 * Excel puts rows on newlines and cells on tabs. A cell containing a newline is
 * quoted, and that is the one case worth handling properly: an Arabic item
 * description typed across two lines in Excel would otherwise become two broken
 * rows.
 *
 * @param {string} raw clipboard text.
 * @return {Array<Array<string>>}
 */
export function parseTable(raw) {
  const source = String(raw === null || raw === undefined ? '' : raw).replace(/\r\n?/g, '\n');

  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (quoted) {
      if (char !== '"') { cell += char; continue; }

      // A doubled quote inside a quoted cell is a literal quote.
      if (source[i + 1] === '"') { cell += '"'; i++; continue; }
      quoted = false;
      continue;
    }

    if (char === '"' && cell === '') { quoted = true; continue; }

    if (char === '\t') { row.push(cell); cell = ''; continue; }

    if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  // Whatever is left over is the last cell of the last row.
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }

  // Excel almost always leaves a trailing newline; drop rows with nothing in them.
  return rows.filter(function (line) {
    return line.some(function (value) { return String(value).trim() !== ''; });
  });
}

/**
 * Does this look like Excel's header row rather than data?
 *
 * Compared against the translated column labels AND the raw column keys, so a
 * sheet headed either "Site ID" or "site_id" is recognised. Getting this wrong
 * in the cautious direction costs one junk row the coordinator deletes; getting
 * it wrong the other way silently eats a real entry, so the test is deliberately
 * strict: at least half the cells must match a known column name.
 *
 * @param {string} kind
 * @param {Array<string>} cells
 * @return {boolean}
 */
export function looksLikeHeader(kind, cells) {
  const known = {};

  gridColumns(kind).forEach(function (column) {
    known[column.key.toLowerCase()] = true;
    known[String(t(column.labelKey)).trim().toLowerCase()] = true;
  });

  let matches = 0;
  let filled = 0;

  cells.forEach(function (value) {
    const cell = asText(value).toLowerCase();
    if (!cell) return;
    filled++;
    if (known[cell]) matches++;
  });

  return filled > 0 && matches >= Math.ceil(filled / 2);
}

/**
 * Turn a matrix into grid rows.
 *
 * Columns map POSITIONALLY, in the order 2.2 lists them — the same order the
 * grid shows, so a coordinator who copies a block out of the grid can paste it
 * back. Two rules make a short or ragged paste behave:
 *
 *   - A row is built with carry-down first (6.6.2), so a paste that omits the
 *     trailing team/project columns inherits them from the row above rather than
 *     landing blank.
 *   - Only NON-EMPTY pasted cells overwrite that. A blank cell in the middle of
 *     a pasted block keeps the carried-down value, which is nearly always what
 *     was meant.
 *
 * A pasted `period` counts as the coordinator's own choice (rule 14), so
 * autofill will not overrule it — and so does a pasted `job_code`, now that a
 * site can offer several and the lookup's pick is only a default (6.6.3).
 *
 * @param {string} kind
 * @param {Array<Array<string>>} matrix
 * @param {Object} options
 * @param {Object|null} [options.previous] the row above, for carry-down.
 * @param {Object|null} [options.siteJcMap] for per-row autofill.
 * @param {*} [options.fiscalYear] the settlement's year, so each row's month and
 *        day become the date its job code is chosen by.
 * @param {Object} [options.defaults] the settlement's month and anything else a
 *        row falls back to when neither the paste nor the row above supplied it.
 * @return {{rows: Array<Object>, skippedHeader: boolean, unknownSites: Array<string>}}
 */
export function rowsFromMatrix(kind, matrix, options = {}) {
  const columns = gridColumns(kind);
  const lines = (matrix || []).slice();

  const skippedHeader = lines.length > 0 && looksLikeHeader(kind, lines[0]);
  if (skippedHeader) lines.shift();

  const rows = [];
  const unknownSites = [];
  const indexOf = function (key) {
    return columns.findIndex(function (column) { return column.key === key; });
  };
  const periodIndex = indexOf('period');
  const jobCodeIndex = indexOf('job_code');
  let previous = options.previous || null;

  lines.forEach(function (line) {
    const row = makeRow(kind, previous, options.defaults);

    columns.forEach(function (column, index) {
      const value = asText(line[index]);
      if (value === '') return;                 // keep the carried-down value

      row[column.key] = (column.key === 'period') ? asPeriod(value) : value;
    });

    // A period that arrived WITH the paste is the coordinator's own answer, so
    // autofill must not overrule it (rule 14). Same for a job code.
    const pastedPeriod = (periodIndex === -1) ? '' : asPeriod(line[periodIndex]);
    if (pastedPeriod) row._period_manual = true;

    if (jobCodeIndex !== -1 && asText(line[jobCodeIndex])) row._jc_manual = true;

    const result = autofillRow(
      row,
      options.siteJcMap || null,
      rowEntryDate(row, options.fiscalYear)
    );
    result.unknown.forEach(function (site) {
      if (unknownSites.indexOf(site) === -1) unknownSites.push(site);
    });

    rows.push(row);
    previous = row;
  });

  return { rows: rows, skippedHeader: skippedHeader, unknownSites: unknownSites };
}

/* ------------------------------------------------------------------ *
 * The two entry points
 * ------------------------------------------------------------------ */

/**
 * Listen for a multi-cell paste anywhere in the grid.
 *
 * A single-value paste is left alone — dropping one Site ID into one cell is an
 * ordinary paste and must keep behaving like one. Only text carrying a tab or a
 * line break is treated as a block.
 *
 * @param {HTMLElement} host the grid host.
 * @param {Object} options
 * @param {Function} options.getKind
 * @param {Function} options.getRows current model rows, for carry-down.
 * @param {Function} options.getSiteJcMap
 * @param {Function} [options.getDefaults] the row defaults (the settlement's
 *        month), for a paste with no month column of its own.
 * @param {Function} options.onRows called with the parse result.
 * @return {Function} a detach function.
 */
export function attachPaste(host, options) {
  const onPaste = function (event) {
    const clipboard = event.clipboardData || window.clipboardData;
    if (!clipboard) return;

    const raw = clipboard.getData('text');
    if (!raw) return;

    // One cell's worth of text: let the browser paste it into the input.
    if (raw.indexOf('\t') === -1 && raw.indexOf('\n') === -1 && raw.indexOf('\r') === -1) return;

    event.preventDefault();
    applyPaste(raw, options);
  };

  host.addEventListener('paste', onPaste);
  return function () { host.removeEventListener('paste', onPaste); };
}

/**
 * The "Paste from Excel" button: a textarea holding the same tab-separated text.
 *
 * @param {Object} options same shape as attachPaste().
 */
export function openPasteDialog(options) {
  const kind = options.getKind();
  const labels = gridColumns(kind).map(function (column) { return t(column.labelKey); });

  openModal({
    title: t('paste_title'),
    confirmLabel: t('paste_append'),
    wide: true,

    bodyHtml: `
      <div class="stack">
        <p class="text-small text-secondary">${escapeHtml(t('paste_intro'))}</p>

        <div class="paste-columns">
          <div class="text-tiny text-muted">${escapeHtml(t('paste_columns_hint'))}</div>
          <div class="text-tiny num">${escapeHtml(labels.join('  ·  '))}</div>
        </div>

        <div class="field">
          <label class="label" for="paste-text">${escapeHtml(t('paste_label'))}</label>
          <textarea class="textarea paste-textarea" id="paste-text"
                    placeholder="${escapeHtml(t('paste_placeholder'))}"></textarea>
        </div>
      </div>
    `,

    onConfirm: function (ctx) {
      const raw = ctx.find('#paste-text').value;
      if (!String(raw || '').trim()) {
        ctx.setError(t('paste_nothing'));
        return false;
      }

      const result = applyPaste(raw, options);
      if (!result.rows.length) {
        ctx.setError(t('paste_nothing'));
        return false;
      }
    }
  });
}

/**
 * Parse, build and hand over. Shared by both entry points.
 *
 * @param {string} raw
 * @param {Object} options
 * @return {{rows: Array<Object>, skippedHeader: boolean, unknownSites: Array<string>,
 *           truncated: number}}
 */
function applyPaste(raw, options) {
  const kind = options.getKind();
  const existing = options.getRows() || [];

  const matrix = parseTable(raw);

  // Cap it rather than refuse it: a coordinator who pastes a whole year has
  // still pasted something useful, and the count is reported back.
  const truncated = Math.max(0, matrix.length - MAX_PASTE_ROWS);
  const capped = truncated ? matrix.slice(0, MAX_PASTE_ROWS) : matrix;

  const result = rowsFromMatrix(kind, capped, {
    previous: existing.length ? existing[existing.length - 1] : null,
    siteJcMap: options.getSiteJcMap(),
    fiscalYear: (typeof options.getFiscalYear === 'function') ? options.getFiscalYear() : '',
    defaults: (typeof options.getDefaults === 'function') ? options.getDefaults() : null
  });

  result.truncated = truncated;

  if (result.rows.length && typeof options.onRows === 'function') options.onRows(result);
  return result;
}
