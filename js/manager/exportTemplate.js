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
    { key: 'amount', label: 'Amount', type: 'money', width: 12 }
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
  const aoa = [];
  const merges = [];

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

  /* --- title --- */
  const titleRow = push([sheet.sheet_name]);
  merge(titleRow, 0, titleRow, width - 1);

  /*
   * The marker occupies the last two columns beside the header block. Both
   * layouts are at least eight columns wide, so there is always room; the
   * Math.max is a floor for any future narrower sheet rather than a real case.
   */
  const markerStart = Math.max(2, width - 2);
  const metaValueEnd = markerStart - 1;

  const firstMetaRow = aoa.length;

  sheet.meta.forEach(function (item) {
    const row = push([item.label, item.value]);
    merge(row, 1, row, metaValueEnd);
  });

  /* --- the big Old/New marker, spanning the first three header rows --- */
  const markerRow = firstMetaRow;
  aoa[markerRow][markerStart] = sheet.marker.label;
  merge(markerRow, markerStart, markerRow + 2, width - 1);

  push([]);   // a blank line between the header block and the table

  /* --- the table --- */
  push(sheet.columns.map(function (column) { return column.label; }));

  sheet.rows.forEach(function (row) {
    push(row.cells.map(function (cell) { return cell.value; }));
  });

  push(sheet.totals_row.map(function (cell) { return cell.value; }));

  /* --- the approval footer (7.2) --- */
  push([]);

  const trackingRow = push([]);
  aoa[trackingRow][0] = sheet.footer.tracking_label;
  aoa[trackingRow][1] = sheet.footer.tracking_no;
  aoa[trackingRow][Math.max(2, width - 2)] = sheet.footer.date_label;
  aoa[trackingRow][width - 1] = sheet.footer.date;

  push([]);

  // Spread the three signatures across the width: start, middle, end.
  const signatureColumns = [0, Math.floor((width - 1) / 2), width - 1];

  const signatureRow = push([]);
  const ruleRow = push([]);

  sheet.footer.signatures.forEach(function (signature, index) {
    const column = signatureColumns[index];
    aoa[signatureRow][column] = signature;
    aoa[ruleRow][column] = '____________';
  });

  return {
    name: sheet.sheet_name,
    aoa: aoa,
    merges: merges,
    cols: sheet.columns.map(function (column) { return { wch: column.width || 12 }; })
  };
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
