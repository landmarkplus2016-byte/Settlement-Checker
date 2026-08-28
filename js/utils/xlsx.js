/**
 * xlsx.js — the only file that touches SheetJS (CLAUDE.md 9.1).
 *
 * SheetJS is loaded from a pinned CDN <script> in index.html and publishes the
 * global `XLSX`. It is not a module, so nothing can import it; this file wraps
 * the global so no screen ever names it directly.
 *
 * STAGE 5 needs the READ half only — the Site→JC "Upload Excel" path, where the
 * client parses an .xlsx and posts JSON to `bulk_import_site_jc` (3.4). The
 * write half (building the finance files) arrives with the export screen.
 *
 * Reading is deliberately forgiving about headers and strict about nothing: this
 * file's job is to turn a spreadsheet into rows. Deciding whether a row is
 * *valid* belongs to the screen that asked for it.
 */

/** How the file was read, for the caller's error message. */
export class SheetError extends Error {
  /** @param {string} reason snake_case; screens map it via t('err_msg_' + reason). */
  constructor(reason) {
    super(reason);
    this.name = 'SheetError';
    this.code = 'validation_failed';
    this.serverMessage = reason;
  }
}

/**
 * Is SheetJS on the page? False when the CDN is blocked or has not finished
 * loading — worth checking before offering an upload button that cannot work.
 * @return {boolean}
 */
export function isXlsxAvailable() {
  return typeof window !== 'undefined' &&
    !!window.XLSX &&
    !!window.XLSX.utils;
}

/**
 * Normalise a header cell to a snake_case key: 'Site ID' -> 'site_id',
 * 'Job-Code' -> 'job_code', 'OLD/NEW' -> 'old_new'.
 *
 * @param {*} header
 * @return {string}
 */
export function normalizeHeaderKey(header) {
  return String(header === null || header === undefined ? '' : header)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Read a picked file into a workbook.
 *
 * @param {File} file from an <input type="file">.
 * @return {Promise<Object>} a SheetJS workbook.
 * @throws {SheetError} xlsx_unavailable | import_file_unreadable | import_parse_failed
 */
export async function readWorkbookFile(file) {
  if (!isXlsxAvailable()) throw new SheetError('xlsx_unavailable');
  if (!file) throw new SheetError('import_file_none');

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    throw new SheetError('import_file_unreadable');
  }

  try {
    // `cellDates` keeps real dates as Dates rather than serials; harmless here
    // and correct for any later reader.
    return window.XLSX.read(buffer, { type: 'array', cellDates: true });
  } catch (err) {
    throw new SheetError('import_parse_failed');
  }
}

/**
 * The rows of one sheet, as objects keyed by normalised header.
 *
 * Values come back as TEXT (`raw: false`). That matters for this app: a Site ID
 * of `3799` must stay the string '3799' and not become the number 3799, or it
 * would be compared, stored and displayed differently from `K3799` beside it.
 *
 * @param {Object} workbook from readWorkbookFile().
 * @param {string} [sheetName] defaults to the first sheet.
 * @return {{sheet_name: string, headers: Array<string>, rows: Array<Object>}}
 *         Each row also carries `_row`, its 1-based row number in the file, so a
 *         problem can be reported at the line the user sees in Excel.
 * @throws {SheetError} import_no_sheets | import_sheet_missing | import_sheet_empty
 */
export function readSheetRows(workbook, sheetName) {
  if (!isXlsxAvailable()) throw new SheetError('xlsx_unavailable');

  const names = (workbook && workbook.SheetNames) || [];
  if (!names.length) throw new SheetError('import_no_sheets');

  const name = sheetName || names[0];
  const sheet = workbook.Sheets ? workbook.Sheets[name] : null;
  if (!sheet) throw new SheetError('import_sheet_missing');

  // header:1 gives raw arrays, so the header row is ours to normalise rather
  // than SheetJS's to guess (and to de-duplicate with _1 suffixes).
  const matrix = window.XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false
  });

  if (!matrix.length) throw new SheetError('import_sheet_empty');

  const headers = (matrix[0] || []).map(normalizeHeaderKey);
  const rows = [];

  for (let r = 1; r < matrix.length; r++) {
    const line = matrix[r] || [];

    let blank = true;
    const obj = {};

    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;

      const value = (line[c] === null || line[c] === undefined) ? '' : String(line[c]).trim();
      if (value !== '') blank = false;

      // First column wins on a duplicated header, so a stray second 'period'
      // column cannot silently override the real one.
      if (!Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = value;
    }

    if (blank) continue;

    obj._row = r + 1;
    rows.push(obj);
  }

  return { sheet_name: name, headers: headers, rows: rows };
}

/**
 * Pick the first present key from a row.
 *
 * Real site lists come from many hands, so the same column is called `Site ID`,
 * `Site`, or `SITE_NO` depending on who made the file. Rather than demand one
 * spelling, the screen passes the aliases it accepts.
 *
 * @param {Object} row from readSheetRows().
 * @param {Array<string>} aliases normalised keys, best first.
 * @return {string} '' when none of them is present or all are blank.
 */
export function pickField(row, aliases) {
  for (let i = 0; i < aliases.length; i++) {
    const value = row[aliases[i]];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}
