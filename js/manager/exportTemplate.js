/**
 * exportTemplate.js — the finance file's shape (CLAUDE.md 7.2, rule 17).
 *
 * This file owns what the workbook LOOKS like: the header block (Name, Account,
 * Total), the big Old/New marker, the two column layouts, the totals row, and
 * the Arabic approval footer with the period's Tracking# and the date.
 *
 * It builds a neutral MODEL, not HTML and not a SheetJS sheet. The model is
 * rendered twice — as the preview the manager reads on screen (export.js +
 * css/template.css) and as the .xlsx he downloads (utils/xlsx.js). One
 * definition, two renderers: a preview that could disagree with the file it is
 * previewing would be worse than no preview at all.
 *
 * ── Why the template's own text is not translated ──────────────────────────
 *
 * Rule 22 puts every visible string through t(). The strings in THIS file are
 * the exception, and the line is: anything printed INTO the finance file is
 * data, not chrome.
 *
 * The tab names, the column headers, the OLD/NEW marker and the Arabic footer
 * (المدير المسؤل / مدير الحسابات / إعتماد) are the workbook's own text. They go
 * to the finance team, who have been reading exactly these labels for years, and
 * they must not change with the language the manager happened to have selected —
 * or two managers exporting the same batch would produce two different files.
 * The footer is Arabic in English mode for the same reason it is Arabic in the
 * original workbook.
 *
 * Everything AROUND the file — the buttons, the warnings, the preview's own
 * captions — is chrome and goes through t() in export.js, as usual.
 */

import { formatDate } from '../utils/dates.js';
import { explodeRows, sumField } from '../utils/explode.js';
import { toNumber } from '../utils/validate.js';

/* ------------------------------------------------------------------ *
 * The workbook's own text (see the file header)
 * ------------------------------------------------------------------ */

/** Tab names. Stable identifiers inside the file, never translated. */
export const SHEET_TITLES = {
  expenses: 'Expenses Tracking',
  fuel: 'Fuel Tracking'
};

/** The header block's labels (7.2). */
const META_LABELS = {
  name: 'Name',
  account: 'Account',
  total: 'Total',
  team: 'Team',
  month: 'Month'
};

/** The approval footer, exactly as the workbook carries it (7.2). */
const FOOTER = {
  tracking: 'Tracking #',
  date: 'Date',
  signatures: ['المدير المسؤل', 'مدير الحسابات', 'إعتماد']
};

/** Placeholder for a cell with nothing in it, so a column never looks lost. */
const BLANK = '';

/**
 * The two column layouts of 7.2, in the workbook's order.
 *
 * `type` drives both renderers:
 *   - `money` — a number shown to two decimals and summed in the totals row.
 *   - `num`   — a number that is never summed (a day, an odometer reading).
 *   - `id`    — a Site ID or Job Code. Stored and written as TEXT, so `3799`
 *               never becomes the number 3799 and stop matching the `K3799`
 *               beside it, but rendered left-to-right in the preview: 8.1 keeps
 *               Site IDs and Job Codes LTR in Arabic, and a multi-site cell like
 *               `377/442` would otherwise reorder to `442/377` on an RTL page.
 *   - `text`  — everything else.
 */
const COLUMNS = {
  expenses: [
    { key: 'month', label: 'Month', type: 'text', width: 10 },
    { key: 'day', label: 'Day', type: 'num', width: 6 },
    { key: 'project', label: 'Project', type: 'text', width: 12 },
    { key: 'site_id', label: 'Site ID', type: 'id', width: 14 },
    { key: 'job_code', label: 'Job Code', type: 'id', width: 14 },
    { key: 'category', label: 'Category', type: 'text', width: 16 },
    { key: 'item_description', label: 'Item Description', type: 'text', width: 34 },
    { key: 'amount', label: 'Amount', type: 'money', width: 12 },
    // The coordinator types this in the grid (2.2) and finance reads it beside
    // the amount, so it belongs in the file. Last, after the figure it explains.
    { key: 'comment', label: 'Comment', type: 'text', width: 24 }
  ],

  fuel: [
    { key: 'month', label: 'Month', type: 'text', width: 10 },
    { key: 'day', label: 'Day', type: 'num', width: 6 },
    { key: 'project', label: 'Project', type: 'text', width: 12 },
    { key: 'site_id', label: 'Site ID', type: 'id', width: 14 },
    { key: 'job_code', label: 'Job Code', type: 'id', width: 14 },
    { key: 'start_km', label: 'Start KM', type: 'num', width: 11 },
    { key: 'end_km', label: 'End KM', type: 'num', width: 11 },
    { key: 'fuel_amount', label: 'Fuel', type: 'money', width: 12 },
    { key: 'area', label: 'Area', type: 'text', width: 12 },
    { key: 'driver', label: 'Driver', type: 'text', width: 14 },
    { key: 'city', label: 'City', type: 'text', width: 12 },
    { key: 'karta_amount', label: 'Karta', type: 'money', width: 12 }
  ]
};

/**
 * The per-site report's extra column (7.2).
 *
 * It exists so a reader can tell a divided row from a whole one at a glance:
 * '2/3' means this is the second of three sites a single line covered, and its
 * amount is a third of what the coordinator typed. Only the per-site report
 * carries it — the Normal report has no split rows to mark.
 */
const SPLIT_COLUMN = { key: 'split_label', label: 'Split', type: 'id', width: 8 };

/** Which kind each sheet holds, and which entry list it reads. */
const SHEET_KINDS = [
  { key: 'expenses', kind: 'expense', source: 'expenses' },
  { key: 'fuel', kind: 'fuel', source: 'fuel' }
];

/* ================================================================== *
 * Building the document
 * ================================================================== */

/**
 * One period's file, as a model.
 *
 * The per-site explosion happens HERE rather than in the caller, so the preview
 * and the .xlsx cannot drift apart: both render this one document (6.4).
 *
 * @param {Object} options
 * @param {Object} options.query the `export_query` response for this period.
 * @param {string} options.period 'old' | 'new'.
 * @param {string} options.team the team's display name.
 * @param {string} options.month the month label.
 * @param {string} options.reportType 'normal' | 'persite'.
 * @return {Object} the document model — see the fields below.
 */
export function buildExportDocument(options) {
  const opts = options || {};
  const query = opts.query || {};
  const header = query.header || {};

  const period = String(opts.period || '').toLowerCase();
  const isPerSite = opts.reportType === 'persite';

  const trackingNo = joinValues(header.tracking_numbers);
  const account = joinValues(header.accounts);
  const fiscalYear = joinValues(header.fiscal_years);
  const monthLabel = joinValues(header.months) || String(opts.month || '');

  const coordinators = (header.coordinators || []).map(function (person) {
    return person.display_name || person.user_id || '';
  }).filter(Boolean);

  const sheets = SHEET_KINDS.map(function (spec) {
    const source = query[spec.source] || [];
    const rows = isPerSite ? explodeRows(source, spec.kind) : source.map(passThrough);

    return buildSheet({
      key: spec.key,
      kind: spec.kind,
      rows: rows,
      isPerSite: isPerSite,
      period: period,
      team: String(opts.team || ''),
      month: monthLabel,
      account: account,
      coordinators: coordinators,
      trackingNo: trackingNo
    });
  });

  const rowCount = sheets.reduce(function (sum, sheet) { return sum + sheet.rows.length; }, 0);

  return {
    period: period,
    report_type: isPerSite ? 'persite' : 'normal',
    team: String(opts.team || ''),
    month: monthLabel,
    fiscal_year: fiscalYear,
    account: account,
    tracking_no: trackingNo,
    coordinators: coordinators,

    sheets: sheets,
    row_count: rowCount,
    has_rows: rowCount > 0,

    /** What the server would claim if this document were committed (3.7). */
    claimable: toNumber(query.claimable) || 0,
    already_exported: toNumber(query.already_exported) || 0,

    file_name: buildFileName({
      team: opts.team,
      period: period,
      trackingNo: trackingNo,
      month: monthLabel,
      fiscalYear: fiscalYear,
      isPerSite: isPerSite
    })
  };
}

/**
 * A row used as-is by the Normal report, carrying the same split fields the
 * exploded rows have so one renderer handles both (explode.js does the same for
 * a single-site line).
 *
 * @param {Object} row
 * @return {Object}
 */
function passThrough(row) {
  return Object.assign({}, row, {
    is_split: false,
    split_label: '',
    source_entry_id: row.entry_id || ''
  });
}

/**
 * One sheet of the document.
 *
 * @param {Object} spec
 * @return {Object} the sheet model.
 */
function buildSheet(spec) {
  const columns = COLUMNS[spec.key].slice();
  if (spec.isPerSite) columns.push(SPLIT_COLUMN);

  const moneyKeys = columns
    .filter(function (column) { return column.type === 'money'; })
    .map(function (column) { return column.key; });

  const totals = {};
  moneyKeys.forEach(function (key) { totals[key] = sumField(spec.rows, key); });

  const rows = spec.rows.map(function (row) {
    return {
      entry_id: row.entry_id || '',
      source_entry_id: row.source_entry_id || '',
      coordinator: (row.coordinator && row.coordinator.display_name) || '',
      is_split: !!row.is_split,
      cells: columns.map(function (column) {
        return { key: column.key, type: column.type, value: cellValue(row, column) };
      })
    };
  });

  return {
    key: spec.key,
    kind: spec.kind,

    /** The tab name in the .xlsx, and the preview's heading. */
    sheet_name: SHEET_TITLES[spec.key],

    /** The big Old/New marker (7.2). Amber for old, blue for new (8.3). */
    marker: { period: spec.period, label: spec.period.toUpperCase() },

    /**
     * The header block. `Total` is this sheet's own money — the expense total on
     * the expenses sheet, the fuel total on the fuel sheet (7.2).
     */
    meta: buildMeta(spec, totals, moneyKeys),

    columns: columns,
    rows: rows,

    /** The totals row under the data, aligned to the money columns. */
    totals: totals,
    totals_row: buildTotalsRow(columns, totals, moneyKeys),

    footer: {
      tracking_label: FOOTER.tracking,
      tracking_no: spec.trackingNo,
      date_label: FOOTER.date,
      date: formatDate(new Date()),
      signatures: FOOTER.signatures.slice()
    }
  };
}

/**
 * The header block's label/value pairs.
 *
 * Name, Account and Total are the three 7.2 names; Team and Month are added
 * because an export is per team and month (7.1) and a finance file that does not
 * say which team it is for cannot be filed by the person receiving it.
 *
 * @param {Object} spec
 * @param {Object} totals
 * @param {Array<string>} moneyKeys
 * @return {Array<{label: string, value: *, type: string}>}
 */
function buildMeta(spec, totals, moneyKeys) {
  // The sheet's headline figure: the first money column — Amount on expenses,
  // Fuel on fuel. Karta is in the totals row, not the header.
  const headline = moneyKeys.length ? totals[moneyKeys[0]] : 0;

  return [
    { label: META_LABELS.name, value: spec.coordinators.join(' / '), type: 'text' },
    { label: META_LABELS.account, value: spec.account, type: 'text' },
    { label: META_LABELS.total, value: headline, type: 'money' },
    { label: META_LABELS.team, value: spec.team, type: 'text' },
    { label: META_LABELS.month, value: spec.month, type: 'text' }
  ];
}

/**
 * The totals row, as cells aligned to the columns.
 *
 * The word "Total" sits in the cell immediately before the first money column,
 * which is where a reader's eye already is.
 *
 * @param {Array<Object>} columns
 * @param {Object} totals
 * @param {Array<string>} moneyKeys
 * @return {Array<{key: string, type: string, value: *}>}
 */
function buildTotalsRow(columns, totals, moneyKeys) {
  const firstMoney = columns.findIndex(function (column) {
    return column.key === moneyKeys[0];
  });

  return columns.map(function (column, index) {
    if (column.type === 'money') {
      return { key: column.key, type: 'money', value: totals[column.key] };
    }
    if (index === firstMoney - 1) {
      return { key: column.key, type: 'label', value: META_LABELS.total };
    }
    return { key: column.key, type: 'text', value: BLANK };
  });
}

/**
 * One cell's value, coerced for its column type.
 *
 * Numbers go out as NUMBERS, not as formatted strings: the finance team sorts
 * and sums these files, and a column of text that looks like money is a column
 * Excel cannot add up. Formatting is the renderers' job.
 *
 * @param {Object} row
 * @param {Object} column
 * @return {string|number}
 */
function cellValue(row, column) {
  const raw = row[column.key];

  if (column.type === 'money' || column.type === 'num') {
    const number = toNumber(raw);
    return (number === null) ? BLANK : number;
  }

  return (raw === null || raw === undefined) ? BLANK : String(raw);
}

/* ================================================================== *
 * The .xlsx layout
 * ================================================================== */

/**
 * A sheet model as the grid SheetJS writes: an array of arrays, plus the merges
 * and column widths that make it read like the workbook (7.2).
 *
 * The layout, top to bottom:
 *
 *     ┌─────────────────────────────────────────────┬──────────┐
 *     │ Expenses Tracking                           │          │  title
 *     ├──────────┬──────────────────────────────────┤   NEW    │  header block
 *     │ Name     │ Mahmoud Shaarawy                 │  marker  │  + the big
 *     │ Account  │ VF                               │          │    marker
 *     │ Total    │ 12,480.00                        ├──────────┤
 *     │ Team     │ Team Ashraf                      │          │
 *     │ Month    │ Aug                              │          │
 *     ├──────────┴──────────────────────────────────┴──────────┤
 *     │ Month │ Day │ Project │ … │ Amount                     │  columns
 *     │ …data rows…                                            │
 *     │                                    Total │ 12,480.00   │  totals
 *     ├────────────────────────────────────────────────────────┤
 *     │ Tracking #  26                              Date  …    │  footer
 *     │ المدير المسؤل      مدير الحسابات        إعتماد          │
 *     └────────────────────────────────────────────────────────┘
 *
 * @param {Object} sheet from buildSheet().
 * @return {{name: string, aoa: Array<Array>, merges: Array<Object>, cols: Array<Object>}}
 */
export function sheetToAoa(sheet) {
  const width = sheet.columns.length;
  const ink = palette();

  const aoa = [];
  const merges = [];
  const styles = [];
  const heights = [];

  /** @param {Array} cells @return {number} the row index just written. */
  function push(cells) {
    const line = new Array(width).fill(BLANK);
    (cells || []).forEach(function (cell, index) {
      if (index < width) line[index] = cell;
    });
    aoa.push(line);
    return aoa.length - 1;
  }

  /** @param {number} r1 @param {number} c1 @param {number} r2 @param {number} c2 */
  function merge(r1, c1, r2, c2) {
    if (r2 < r1 || c2 < c1) return;
    merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });
  }

  /**
   * Style a rectangle. Applied in order and merged per cell, so a later partial
   * style (a number format on one column) refines an earlier one instead of
   * erasing its borders.
   */
  function style(r1, c1, r2, c2, spec) {
    if (r2 < r1 || c2 < c1) return;
    styles.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 }, style: spec });
  }

  /** @param {number} row @param {number} points */
  function height(row, points) { heights[row] = { hpt: points }; }

  /* --- title --- */
  const titleRow = push([sheet.sheet_name]);
  merge(titleRow, 0, titleRow, width - 1);
  height(titleRow, 24);

  /*
   * The marker occupies the last two columns beside the header block. Both
   * layouts are at least eight columns wide, so there is always room; the
   * Math.max is a floor for any future narrower sheet rather than a real case.
   */
  const markerStart = Math.max(2, width - 2);
  const metaValueEnd = markerStart - 1;

  const firstMetaRow = aoa.length;

  sheet.meta.forEach(function (item) {
    const row = push([item.label.toUpperCase(), item.value]);
    merge(row, 1, row, metaValueEnd);
    height(row, 16);

    // The header block's Total is money and is formatted like the column it
    // summarises, not like the text beside it.
    if (item.type === 'money') style(row, 1, row, 1, { numFmt: MONEY_FORMAT });
  });

  const lastMetaRow = aoa.length - 1;

  /* --- the big Old/New marker, spanning the first three header rows --- */
  const markerRow = firstMetaRow;
  aoa[markerRow][markerStart] = sheet.marker.label;
  merge(markerRow, markerStart, markerRow + 2, width - 1);

  /*
   * The header block, painted as one panel: the whole rectangle takes the tint
   * and the outline, then the title, the labels and the values are drawn on top
   * of it. Styling only the cells that hold text would leave the gaps between
   * them white, and the block would read as scattered words rather than the
   * header of a document.
   */
  style(titleRow, 0, lastMetaRow, width - 1, {
    fill: solid(ink.surface3),
    font: { name: ink.font, sz: 10, color: { rgb: ink.textPrimary } },
    alignment: { vertical: 'center' }
  });

  // One rule under the whole block, and no lines inside it. The header is a
  // letterhead, not a table — boxing every label would turn it into one.
  style(lastMetaRow, 0, lastMetaRow, metaValueEnd, {
    border: { bottom: { style: 'thin', color: { rgb: ink.navy } } }
  });

  style(titleRow, 0, titleRow, width - 1, {
    font: { name: ink.font, sz: 14, bold: true, color: { rgb: ink.navy } }
  });

  style(firstMetaRow, 0, lastMetaRow, 0, {
    font: { name: ink.font, sz: 9, bold: true, color: { rgb: ink.textMuted } }
  });

  style(firstMetaRow, 1, lastMetaRow, metaValueEnd, {
    font: { name: ink.font, sz: 11, bold: true, color: { rgb: ink.textPrimary } }
  });

  // Amber for old, blue for new — the same two colours the app uses everywhere
  // (8.3), so the period is read before the word is.
  const marker = sheet.marker.period === 'old'
    ? { bg: ink.oldBg, fg: ink.oldFg }
    : { bg: ink.newBg, fg: ink.newFg };

  style(markerRow, markerStart, markerRow + 2, width - 1, {
    fill: solid(marker.bg),
    font: { name: ink.font, sz: 22, bold: true, color: { rgb: marker.fg } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: box(ink.navy)
  });

  push([]);   // a blank line between the header block and the table

  /* --- the table --- */
  const headerRow = push(sheet.columns.map(function (column) {
    return column.label.toUpperCase();
  }));
  height(headerRow, 20);

  style(headerRow, 0, headerRow, width - 1, {
    fill: solid(ink.navy),
    font: { name: ink.font, sz: 9, bold: true, color: { rgb: ink.inverse } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: box(ink.navy3)
  });

  const firstDataRow = aoa.length;

  sheet.rows.forEach(function (row) {
    const r = push(row.cells.map(function (cell) { return cell.value; }));

    /*
     * Zebra striping, and the per-site tint over it. A divided row is tinted
     * rather than boxed for the same reason as in the preview: on a per-site
     * file most rows are split, so a heavy treatment would make the whole lines
     * look like the anomaly.
     */
    const band = row.is_split
      ? ink.primarySubtle
      : (((r - firstDataRow) % 2) ? ink.surface2 : ink.surface);

    style(r, 0, r, width - 1, {
      fill: solid(band),
      font: { name: ink.font, sz: 10, color: { rgb: ink.textPrimary } },
      alignment: { vertical: 'center' },
      border: box(ink.gridLine)
    });
  });

  const lastDataRow = aoa.length - 1;

  // Money as money, per column, across every data row at once.
  sheet.columns.forEach(function (column, index) {
    if (column.type !== 'money') return;
    style(firstDataRow, index, lastDataRow, index, { numFmt: MONEY_FORMAT });
  });

  /* --- the totals row --- */
  const totalsRow = push(sheet.totals_row.map(function (cell) { return cell.value; }));
  height(totalsRow, 18);

  style(totalsRow, 0, totalsRow, width - 1, {
    fill: solid(ink.surface3),
    font: { name: ink.font, sz: 10, bold: true, color: { rgb: ink.navy } },
    alignment: { vertical: 'center' },
    border: Object.assign(box(ink.gridLine), {
      top: { style: 'medium', color: { rgb: ink.navy } }
    })
  });

  sheet.totals_row.forEach(function (cell, index) {
    if (cell.type === 'money') style(totalsRow, index, totalsRow, index, { numFmt: MONEY_FORMAT });
  });

  /* --- the approval footer (7.2) --- */
  push([]);

  const trackingRow = push([]);
  aoa[trackingRow][0] = sheet.footer.tracking_label.toUpperCase();
  aoa[trackingRow][1] = sheet.footer.tracking_no;
  aoa[trackingRow][markerStart] = sheet.footer.date_label.toUpperCase();
  aoa[trackingRow][width - 1] = sheet.footer.date;
  height(trackingRow, 18);

  style(trackingRow, 0, trackingRow, width - 1, {
    font: { name: ink.font, sz: 10, bold: true, color: { rgb: ink.navy } },
    alignment: { vertical: 'center' }
  });

  // The two labels are captions for the values beside them, not values.
  style(trackingRow, 0, trackingRow, 0, {
    font: { name: ink.font, sz: 9, bold: true, color: { rgb: ink.textMuted } }
  });
  style(trackingRow, markerStart, trackingRow, markerStart, {
    font: { name: ink.font, sz: 9, bold: true, color: { rgb: ink.textMuted } }
  });

  push([]);   // the gap the signatures are actually signed in

  /*
   * The three signature blocks, spread across the width: start, middle, end.
   * The rule is a bottom border on an empty merged block rather than a run of
   * underscores — a real line, at a fixed width, that survives a column being
   * widened.
   */
  const blocks = signatureBlocks(width);

  const ruleRow = push([]);
  height(ruleRow, 22);

  const labelRow = push([]);
  height(labelRow, 18);

  sheet.footer.signatures.forEach(function (signature, index) {
    const block = blocks[index];
    if (!block) return;

    merge(ruleRow, block.start, ruleRow, block.end);
    style(ruleRow, block.start, ruleRow, block.end, {
      border: { bottom: { style: 'thin', color: { rgb: ink.navy } } }
    });

    aoa[labelRow][block.start] = signature;
    merge(labelRow, block.start, labelRow, block.end);
    style(labelRow, block.start, labelRow, block.end, {
      font: { name: ink.font, sz: 10, bold: true, color: { rgb: ink.textSecondary } },
      alignment: { horizontal: 'center', vertical: 'center' }
    });
  });

  return {
    name: sheet.sheet_name,
    aoa: aoa,
    merges: merges,
    styles: styles,
    rows: heights,
    cols: sheet.columns.map(function (column) { return { wch: column.width || 12 }; })
  };
}

/**
 * Where the three signatures sit, as three-column blocks at the start, the
 * middle and the end of the sheet.
 *
 * @param {number} width the sheet's column count.
 * @return {Array<{start: number, end: number}>}
 */
function signatureBlocks(width) {
  const span = Math.max(1, Math.min(3, Math.floor(width / 3)));
  const middle = Math.max(0, Math.floor((width - span) / 2));

  return [
    { start: 0, end: span - 1 },
    { start: middle, end: middle + span - 1 },
    { start: width - span, end: width - 1 }
  ];
}

/* ================================================================== *
 * The .xlsx's ink
 *
 * Excel cannot read css/tokens.css, and rule 23 does not allow the brand
 * colours to be written down a second time here. So they are READ from the
 * tokens at export time — the same trick main.js uses to paint the browser
 * chrome from --color-navy. The fallbacks below are deliberately neutral: if
 * the stylesheet cannot be read, the file goes out in black and white rather
 * than in a second, drifting copy of the palette.
 * ================================================================== */

/** Two decimals with thousands separators, for every money cell. */
const MONEY_FORMAT = '#,##0.00';

/**
 * The palette, read from the design tokens.
 * @return {Object} colours as Excel's RRGGBB, plus the font family.
 */
function palette() {
  return {
    navy: tokenColor('--color-navy', '000000'),
    navy3: tokenColor('--color-navy-3', '000000'),
    inverse: tokenColor('--color-text-inverse', 'FFFFFF'),

    surface: tokenColor('--color-surface', 'FFFFFF'),
    surface2: tokenColor('--color-surface-2', 'FFFFFF'),
    surface3: tokenColor('--color-surface-3', 'FFFFFF'),

    textPrimary: tokenColor('--color-text-primary', '000000'),
    textSecondary: tokenColor('--color-text-secondary', '000000'),
    textMuted: tokenColor('--color-text-muted', '000000'),

    gridLine: tokenColor('--color-grid-line', '000000'),
    primarySubtle: tokenColor('--color-primary-subtle', 'FFFFFF'),

    oldBg: tokenColor('--color-old-bg', 'FFFFFF'),
    oldFg: tokenColor('--color-old-fg', '000000'),
    newBg: tokenColor('--color-new-bg', 'FFFFFF'),
    newFg: tokenColor('--color-new-fg', '000000'),

    font: tokenFont('Calibri')
  };
}

/**
 * One design token as Excel's RRGGBB.
 *
 * Handles `#abc` as well as `#aabbcc`; anything else falls back, because a
 * malformed colour makes the whole workbook unreadable to Excel rather than
 * just looking wrong.
 *
 * @param {string} name the custom property, e.g. '--color-navy'.
 * @param {string} fallback RRGGBB, used when the token cannot be read.
 * @return {string} RRGGBB, upper case, no '#'.
 */
function tokenColor(name, fallback) {
  const raw = readToken(name).replace('#', '');

  if (/^[0-9a-f]{6}$/i.test(raw)) return raw.toUpperCase();

  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return raw.split('').map(function (ch) { return ch + ch; }).join('').toUpperCase();
  }

  return fallback;
}

/**
 * The first family in the `--font` stack, which is the one Excel can use.
 * @param {string} fallback
 * @return {string}
 */
function tokenFont(fallback) {
  const first = readToken('--font').split(',')[0].replace(/['"]/g, '').trim();
  return first || fallback;
}

/**
 * @param {string} name
 * @return {string} '' outside a browser, or when the property is not set.
 */
function readToken(name) {
  if (typeof window === 'undefined' || !window.getComputedStyle) return '';
  return String(
    window.getComputedStyle(document.documentElement).getPropertyValue(name) || ''
  ).trim();
}

/**
 * A solid fill.
 * @param {string} rgb RRGGBB
 * @return {Object}
 */
function solid(rgb) {
  return { patternType: 'solid', fgColor: { rgb: rgb }, bgColor: { rgb: rgb } };
}

/**
 * A thin box on all four sides.
 * @param {string} rgb RRGGBB
 * @return {Object}
 */
function box(rgb) {
  const side = { style: 'thin', color: { rgb: rgb } };
  return { top: side, bottom: side, left: side, right: side };
}

/**
 * The whole document as the sheets SheetJS needs, in tab order.
 * @param {Object} doc from buildExportDocument().
 * @return {Array<Object>}
 */
export function documentToSheets(doc) {
  return (doc.sheets || []).map(sheetToAoa);
}

/* ================================================================== *
 * The file name
 * ================================================================== */

/**
 * The download's name, e.g. `TeamAshraf_NEW_T26_Aug2026.xlsx`.
 *
 * It names the team, the period, the Tracking# and the month, because a finance
 * inbox holds four files per team per month (7.1) and they have to be told apart
 * without opening them. The per-site report gets its own suffix so it cannot
 * overwrite the Normal one in the browser's downloads folder.
 *
 * It lives here rather than in utils/xlsx.js: that file is a SheetJS wrapper and
 * knows nothing about teams or tracking numbers, and naming the file is part of
 * what the template IS.
 *
 * @param {Object} parts
 * @return {string} a safe file name including the extension.
 */
export function buildFileName(parts) {
  const segments = [
    safeSegment(parts.team) || 'Export',
    String(parts.period || '').toUpperCase(),
    parts.trackingNo ? 'T' + safeSegment(parts.trackingNo) : '',
    safeSegment(String(parts.month || '') + String(parts.fiscalYear || '')),
    parts.isPerSite ? 'PerSite' : ''
  ];

  return segments.filter(Boolean).join('_') + '.xlsx';
}

/**
 * One file-name segment: letters and digits only.
 *
 * A batch that spans two settlements comes back with its numbers joined by `/`
 * (Export.gs), which is a path separator — this is what stops that reaching the
 * filesystem.
 *
 * @param {*} value
 * @return {string}
 */
function safeSegment(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[^A-Za-z0-9]+/g, '');
}

/**
 * Join the distinct values the server returned for a header field.
 *
 * Normally one value. More than one means the batch spans settlements that
 * disagree — two coordinators on the same team with different Tracking#s for the
 * same period — and the file has to show both rather than silently print the
 * first. The export screen warns about it separately.
 *
 * @param {Array} values
 * @return {string}
 */
export function joinValues(values) {
  return (values || []).filter(function (value) {
    return value !== null && value !== undefined && value !== '';
  }).join(' / ');
}
