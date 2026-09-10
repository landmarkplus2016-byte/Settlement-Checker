/**
 * perSiteTemplate.js — the per-site file's shape (CLAUDE.md 7.4, 6.4, rule 18).
 *
 * The per-site file is NOT the finance file divided into the same layout. It is
 * a flat register: one table, one row per site per cost, and nothing else — no
 * title, no header block, no Old/New marker, no totals row, no approval footer.
 * The finance file (exportTemplate.js) is the document that gets signed; this is
 * the working list that gets filtered and pivoted, and everything the finance
 * file puts *around* its table is furniture in a pivot.
 *
 * That is why it lives in its own file rather than as a report type of the
 * template: the two files no longer share a layout, only their ink and their
 * naming (both imported from exportTemplate.js, so the palette still has one
 * home — rule 23).
 *
 *     Name │ Tracking# │ Date │ Site ID │ Cost/Site │ Item Description │
 *     Comment │ Category │ Sub Category │ Coordinator │ Job Code
 *
 * Three things about that table are worth stating plainly, because none of them
 * is guessable from the column names:
 *
 *   - **`Category` is the KIND of cost, not the coordinator's category.** It is
 *     one of exactly three words — `Expenses`, `Fuel`, `Karta`. The system's own
 *     category cell (Transportation, Accommodation, …) moves down to
 *     `Sub Category`, where it is filled on expense rows and empty on the other
 *     two, which have no such cell.
 *   - **A fuel line becomes TWO rows per site**, one carrying its fuel share and
 *     one carrying its karta share, because the table has a single `Cost/Site`
 *     column and a fuel line holds two separate amounts (2.2). A karta of zero
 *     or blank produces no Karta row — a row claiming 0.00 would be counted as a
 *     karta claim that was never made.
 *   - **`Item Description` and `Comment` are blank on fuel and karta rows.** The
 *     fuel layout has no such cells, and filling them with the driver or the
 *     area would put a name in a column finance reads as a description of a
 *     purchase.
 *
 * `Name` is the team the batch went out for; `Coordinator` is the person who
 * filed the line. On a one-team file the first column repeats, which is what
 * makes the sheet safe to paste under another team's.
 *
 * Money is already divided by the time it reaches here: every row comes out of
 * explodeRows() (6.4), so `Cost/Site` is this site's share and the rows re-sum
 * to what the coordinator typed. KM never appears in this file at all, which is
 * one way of keeping rule 18.
 */

import { entryDateOf, formatDate, formatShortDate } from '../utils/dates.js';
import { explodeRows } from '../utils/explode.js';
import { toNumber } from '../utils/validate.js';
import { MONEY_FORMAT, box, buildFileName, palette, solid } from './exportTemplate.js';

/**
 * The one tab. Named for what the file is, not for a kind — it holds expense,
 * fuel and karta rows together.
 */
export const PER_SITE_SHEET_TITLE = 'Per Site';

/**
 * The three values of the `Category` column, and the only three.
 *
 * File text, deliberately untranslated for the same reason the finance file's
 * labels are (see the header of exportTemplate.js): finance filters on these
 * words, and they must not change with the language the manager had selected.
 */
const COST_CATEGORIES = {
  expense: 'Expenses',
  fuel: 'Fuel',
  karta: 'Karta'
};

/**
 * The table, in the order the finance sheet carries it.
 *
 * `type` works exactly as it does in the finance template: `money` gets the
 * two-decimal format, `id` is written as text and read left-to-right, `text` is
 * everything else. There is no `num` column here — the only number in the file
 * is the cost.
 */
const COLUMNS = [
  { key: 'name', label: 'Name', type: 'text', width: 22 },
  { key: 'tracking_no', label: 'Tracking#', type: 'id', width: 11 },
  { key: 'date', label: 'Date', type: 'id', width: 12 },
  { key: 'site_id', label: 'Site ID', type: 'id', width: 14 },
  { key: 'cost', label: 'Cost/Site', type: 'money', width: 13 },
  { key: 'item_description', label: 'Item Description', type: 'text', width: 34 },
  { key: 'comment', label: 'Comment', type: 'text', width: 24 },
  { key: 'category', label: 'Category', type: 'text', width: 13 },
  { key: 'sub_category', label: 'Sub Category', type: 'text', width: 18 },
  { key: 'coordinator', label: 'Coordinator', type: 'text', width: 22 },
  { key: 'job_code', label: 'Job Code', type: 'id', width: 14 }
];

/** Nothing in a cell, written rather than left undefined so it can be styled. */
const BLANK = '';

/* ================================================================== *
 * Building the document
 * ================================================================== */

/**
 * The per-site file for one committed batch, or several combined (7.1), as a
 * model.
 *
 * Several batches make ONE table, not a tab each. The file is a register that
 * gets filtered and pivoted, and every row already names its team, Tracking#,
 * coordinator and date, so rows from different batches cannot be mistaken for
 * one another. They are laid out batch by batch in the order given — the export
 * screen sends them oldest first — each batch's expenses and then its fuel,
 * which is exactly the single-batch file repeated.
 *
 * @param {Object} options
 * @param {Object} options.query the `export_batch_rows` response.
 * @param {Array<Object>} [options.batches] that response's log rows, one per
 *        batch — the team, month, period, fiscal year and Tracking# each went
 *        out under.
 * @param {Object} [options.batch] a single log row, the one-batch form.
 * @return {Object} the document model.
 */
export function buildPerSiteDocument(options) {
  const opts = options || {};
  const query = opts.query || {};
  const batches = (opts.batches && opts.batches.length) ? opts.batches : [opts.batch || {}];
  const single = batches.length === 1;
  const first = batches[0];

  let rows = [];

  batches.forEach(function (batch) {
    const team = String(batch.team || '');

    rows = rows.concat(
      expenseRows(entriesOfBatch(query.expenses, batch, single), batch, team),
      fuelRows(entriesOfBatch(query.fuel, batch, single), batch, team)
    );
  });

  return {
    report_type: 'persite',

    // Only a one-batch file has a single team, period and number to name.
    team: single ? String(first.team || '') : '',
    month: single ? String(first.month || '') : '',
    period: single ? String(first.period || '').toLowerCase() : '',
    tracking_no: single ? String(first.tracking_no || '') : '',
    batch_id: single ? String(first.batch_id || '') : '',
    batch_ids: batches.map(function (batch) { return String(batch.batch_id || ''); }),

    columns: COLUMNS.slice(),
    rows: rows,
    row_count: rows.length,
    has_rows: rows.length > 0,

    file_name: single
      ? buildFileName({
          team: first.team,

          // The log row carries the batch's settlement only when the export was
          // narrowed to one (3.7); an unnarrowed batch simply leaves it out of
          // the name, exactly as the Normal file does.
          settlementId: settlementIdOf(first),

          period: first.period,
          trackingNo: first.tracking_no,
          isPerSite: true
        })
      : combinedFileName(batches.length)
  };
}

/**
 * One batch's entries out of a response that may hold several.
 *
 * @param {Array<Object>} entries from `export_batch_rows`.
 * @param {Object} batch the log row.
 * @param {boolean} single true when the response holds this batch alone — then
 *        every entry is its own, exactly as before batches could be combined.
 * @return {Array<Object>}
 */
function entriesOfBatch(entries, batch, single) {
  if (single) return entries || [];

  const wanted = String(batch.batch_id || '').trim().toLowerCase();

  return (entries || []).filter(function (entry) {
    return String(entry.export_batch_id || '').trim().toLowerCase() === wanted;
  });
}

/**
 * `Per Site — 4 batches — 2026-09-10.xlsx`. A combined file spans teams and
 * numbers, so it is named for what it holds and the day it was built.
 *
 * @param {number} count
 * @return {string}
 */
function combinedFileName(count) {
  return ['Per Site', count + ' batches', formatDate(new Date())].join(' — ') + '.xlsx';
}

/**
 * The settlement id out of a log row's `settlement_id`, which is stored as the
 * `<user_id>::<settlement_id>` batch key when the export was narrowed to one
 * (2.1) and blank otherwise.
 *
 * @param {Object} batch the ExportLog row.
 * @return {string} '' for an unnarrowed batch.
 */
function settlementIdOf(batch) {
  const raw = String((batch && batch.settlement_id) || '').trim();
  if (!raw) return '';

  const parts = raw.split('::');
  return (parts.length === 2) ? parts[1].trim() : raw;
}

/**
 * The expense half: one row per site, carrying that site's share of the amount.
 *
 * @param {Array<Object>} entries from `export_batch_rows`.
 * @param {Object} batch the log row.
 * @param {string} team
 * @return {Array<Object>}
 */
function expenseRows(entries, batch, team) {
  return explodeRows(entries || [], 'expense').map(function (row) {
    return costLine(row, batch, team, {
      cost: row.amount,
      category: COST_CATEGORIES.expense,

      // The coordinator's own category (2.2) — the finance sheet's second level.
      sub_category: row.category,

      item_description: row.item_description,
      comment: row.comment
    });
  });
}

/**
 * The fuel half: one Fuel row per site, and one Karta row beside it when there
 * is karta to claim.
 *
 * The two are emitted together rather than in two passes so a site's fuel and
 * its karta sit on consecutive lines, which is how the file is read.
 *
 * `Item Description` and `Comment` stay blank: the fuel layout has no such
 * cells (see the file header).
 *
 * @param {Array<Object>} entries from `export_batch_rows`.
 * @param {Object} batch the log row.
 * @param {string} team
 * @return {Array<Object>}
 */
function fuelRows(entries, batch, team) {
  const out = [];

  explodeRows(entries || [], 'fuel').forEach(function (row) {
    out.push(costLine(row, batch, team, {
      cost: row.fuel_amount,
      category: COST_CATEGORIES.fuel,
      sub_category: BLANK,
      item_description: BLANK,
      comment: BLANK
    }));

    // Blank and zero both mean "no karta was claimed on this line". A 0.00 row
    // would be counted as a claim in every total the file is used for.
    const karta = toNumber(row.karta_amount);
    if (karta === null || karta === 0) return;

    out.push(costLine(row, batch, team, {
      cost: karta,
      category: COST_CATEGORIES.karta,
      sub_category: BLANK,
      item_description: BLANK,
      comment: BLANK
    }));
  });

  return out;
}

/**
 * One table row, as cells in column order.
 *
 * @param {Object} row an exploded entry (6.4).
 * @param {Object} batch the log row, for the fields the entry does not carry.
 * @param {string} team
 * @param {Object} own the four fields that differ between a cost's kinds.
 * @return {{cells: Array<{key: string, type: string, value: *}>}}
 */
function costLine(row, batch, team, own) {
  const settlement = row.settlement || {};

  const values = {
    // The team the file went out for. An entry's own team cell agrees with it —
    // the export selected on it (rule 15) — so the batch is the simpler source.
    name: team || row.team || BLANK,

    // Resolved per row from its settlement (6.2); the batch's number is the
    // fallback for a row whose settlement could not be read.
    tracking_no: row.tracking_no || batch.tracking_no || BLANK,

    /*
     * The row's own date. `entryDateOf` reads whichever shape the row is in — the
     * `date` cell, or a legacy row's month + day against a year — which is what
     * lets the fifteen batches that went out before the date column existed still
     * regenerate exactly as they were (decision 26). The batch's own fiscal year
     * is the fallback when the settlement itself could not be read.
     */
    date: formatShortDate(
      entryDateOf(row, { fiscal_year: settlement.fiscal_year || batch.fiscal_year })
    ),

    site_id: row.site_id,
    job_code: row.job_code,
    cost: own.cost,
    category: own.category,
    sub_category: own.sub_category,
    item_description: own.item_description,
    comment: own.comment,

    // The English name, in every language, so two managers exporting the same
    // batch produce the same file (see the header of exportTemplate.js).
    coordinator: (row.coordinator && row.coordinator.display_name) || BLANK
  };

  return {
    cells: COLUMNS.map(function (column) {
      return { key: column.key, type: column.type, value: cellValue(values[column.key], column) };
    })
  };
}

/**
 * One cell's value, coerced for its column type.
 *
 * Money goes out as a NUMBER so finance can sum the column; a missing amount
 * stays blank rather than becoming 0.00 (6.4 — the two are different facts).
 *
 * @param {*} raw
 * @param {Object} column
 * @return {string|number}
 */
function cellValue(raw, column) {
  if (column.type === 'money') {
    const number = toNumber(raw);
    return (number === null) ? BLANK : number;
  }

  return (raw === null || raw === undefined) ? BLANK : String(raw);
}

/* ================================================================== *
 * The .xlsx layout
 * ================================================================== */

/**
 * The document as the one sheet SheetJS writes.
 *
 * A header row and the data, and that is the whole file:
 *
 *     ┌──────┬───────────┬──────┬─────────┬───────────┬─────┐
 *     │ Name │ Tracking# │ Date │ Site ID │ Cost/Site │ …   │  header row
 *     │ …data rows…                                        │
 *     └──────┴───────────┴──────┴─────────┴───────────┴─────┘
 *
 * @param {Object} doc from buildPerSiteDocument().
 * @return {{name: string, aoa: Array<Array>, styles: Array<Object>, rows: Array<Object>, cols: Array<Object>}}
 */
export function perSiteToAoa(doc) {
  const columns = doc.columns || [];
  const width = columns.length;
  const ink = palette();

  const aoa = [];
  const styles = [];
  const heights = [];

  /** @param {Array} cells @return {number} the row index just written. */
  function push(cells) {
    const filled = new Array(width).fill(BLANK);
    (cells || []).forEach(function (cell, index) {
      if (index < width) filled[index] = cell;
    });
    aoa.push(filled);
    return aoa.length - 1;
  }

  /** @param {number} r1 @param {number} c1 @param {number} r2 @param {number} c2 @param {Object} spec */
  function style(r1, c1, r2, c2, spec) {
    if (r2 < r1 || c2 < c1) return;
    styles.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 }, style: spec });
  }

  /* --- the header row --- */
  const headerRow = push(columns.map(function (column) { return column.label; }));
  heights[headerRow] = { hpt: 20 };

  style(headerRow, 0, headerRow, width - 1, {
    fill: solid(ink.navy),
    font: { name: ink.font, sz: 9, bold: true, color: { rgb: ink.inverse } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: box(ink.navy3)
  });

  /* --- the data --- */
  const firstDataRow = aoa.length;

  doc.rows.forEach(function (row) {
    const r = push(row.cells.map(function (cell) { return cell.value; }));

    // Zebra striping only. There is no split tint here: on this file EVERY row
    // is a divided one, so marking them would mark the whole sheet.
    style(r, 0, r, width - 1, {
      fill: solid(((r - firstDataRow) % 2) ? ink.surface2 : ink.surface),
      font: { name: ink.font, sz: 10, color: { rgb: ink.textPrimary } },
      alignment: { vertical: 'center' },
      border: box(ink.gridLine)
    });
  });

  const lastDataRow = aoa.length - 1;

  columns.forEach(function (column, index) {
    if (column.type !== 'money') return;
    style(firstDataRow, index, lastDataRow, index, { numFmt: MONEY_FORMAT });
  });

  return {
    name: PER_SITE_SHEET_TITLE,
    aoa: aoa,
    merges: [],
    styles: styles,
    rows: heights,
    cols: columns.map(function (column) { return { wch: column.width || 12 }; })
  };
}

/**
 * The document as the sheet list downloadWorkbook() takes.
 * @param {Object} doc from buildPerSiteDocument().
 * @return {Array<Object>}
 */
export function perSiteDocumentToSheets(doc) {
  return [perSiteToAoa(doc)];
}
