/**
 * xlsx.js — the only file that touches SheetJS (CLAUDE.md 9.1).
 *
 * SheetJS is loaded from a pinned CDN <script> in index.html and publishes the
 * global `XLSX`. It is not a module, so nothing can import it; this file wraps
 * the global so no screen ever names it directly.
 *
 * Two halves:
 *   - READING, for the Site→JC "Upload Excel" path, where the client parses an
 *     .xlsx and posts JSON to `bulk_import_site_jc` (3.4).
 *   - WRITING, for the finance files (7.2). The export screen hands over sheets
 *     that js/manager/exportTemplate.js has already laid out; this file turns
 *     them into a workbook and puts it in the user's downloads.
 *
 * Reading is deliberately forgiving about headers and strict about nothing: this
 * file's job is to turn a spreadsheet into rows. Deciding whether a row is
 * *valid* belongs to the screen that asked for it.
 *
 * Writing knows nothing about settlements, teams or tracking numbers. It takes
 * a grid and writes a grid — what goes IN the grid, and what the file is called,
 * belong to the template (rule 21).
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

/* ================================================================== *
 * Writing — the finance files (7.2)
 * ================================================================== */

/**
 * Excel's own limit on a tab name: 31 characters, and none of `[ ] : * ? / \`.
 * A rejected name fails the whole write, so names are sanitised rather than
 * trusted.
 */
const MAX_SHEET_NAME = 31;

/**
 * Build a workbook from laid-out sheets.
 *
 * @param {Array<Object>} sheets each `{name, aoa, merges?, cols?}` —
 *        `aoa` is an array of row arrays, `merges` are SheetJS ranges
 *        (`{s:{r,c}, e:{r,c}}`), `cols` are widths (`{wch}`).
 * @param {Object} [options]
 * @param {boolean} [options.rtl=false] open the sheets right-to-left, for Arabic.
 * @return {Object} a SheetJS workbook.
 * @throws {SheetError} xlsx_unavailable | export_no_sheets
 */
export function buildWorkbook(sheets, options) {
  if (!isXlsxAvailable()) throw new SheetError('xlsx_unavailable');

  const list = sheets || [];
  if (!list.length) throw new SheetError('export_no_sheets');

  const opts = options || {};
  const book = window.XLSX.utils.book_new();
  const used = [];

  list.forEach(function (spec, index) {
    const sheet = window.XLSX.utils.aoa_to_sheet(spec.aoa || [[]]);

    if (spec.merges && spec.merges.length) sheet['!merges'] = spec.merges;
    if (spec.cols && spec.cols.length) sheet['!cols'] = spec.cols;

    const name = uniqueSheetName(spec.name || ('Sheet' + (index + 1)), used);
    used.push(name);

    window.XLSX.utils.book_append_sheet(book, sheet, name);
  });

  /*
   * The workbook's reading direction, not the data's. In Arabic the whole
   * finance file should open with column A on the right, the way the original
   * workbook does — the numbers inside it stay Western and LTR either way (8.1).
   */
  if (opts.rtl) book.Workbook = { Views: [{ RTL: true }] };

  return book;
}

/**
 * Build a workbook and hand it to the browser as a download.
 *
 * `XLSX.writeFile` does the whole job — serialise, make a Blob, click a link,
 * revoke the URL. Doing it by hand would be the same code with more ways to leak
 * an object URL.
 *
 * @param {Array<Object>} sheets as buildWorkbook() takes them.
 * @param {string} fileName including the `.xlsx` extension. The template owns
 *        this name (js/manager/exportTemplate.js) — this file does not invent one.
 * @param {Object} [options] passed to buildWorkbook().
 * @return {string} the file name actually used.
 * @throws {SheetError} xlsx_unavailable | export_no_sheets | export_write_failed
 */
export function downloadWorkbook(sheets, fileName, options) {
  const book = buildWorkbook(sheets, options);
  const name = safeFileName(fileName);

  try {
    window.XLSX.writeFile(book, name, { compression: true });
  } catch (err) {
    throw new SheetError('export_write_failed');
  }

  return name;
}

/**
 * A tab name Excel will accept, and that is not already in this workbook.
 *
 * A duplicate name is not a cosmetic problem: `book_append_sheet` throws on one,
 * which would fail the download after the manager has already committed.
 *
 * @param {string} name
 * @param {Array<string>} used names already taken in this workbook.
 * @return {string}
 */
function uniqueSheetName(name, used) {
  const cleaned = String(name || 'Sheet')
    .replace(/[[\]:*?/\\]/g, ' ')
    .trim()
    .substring(0, MAX_SHEET_NAME) || 'Sheet';

  if (used.indexOf(cleaned) === -1) return cleaned;

  for (let n = 2; n < 100; n++) {
    const suffix = ' (' + n + ')';
    const candidate = cleaned.substring(0, MAX_SHEET_NAME - suffix.length) + suffix;
    if (used.indexOf(candidate) === -1) return candidate;
  }

  return cleaned.substring(0, MAX_SHEET_NAME - 4) + ' (x)';
}

/**
 * Strip anything a filesystem would object to, and guarantee the extension.
 * @param {string} fileName
 * @return {string}
 */
function safeFileName(fileName) {
  const cleaned = String(fileName || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return 'export.xlsx';
  return /\.xlsx$/i.test(cleaned) ? cleaned : cleaned + '.xlsx';
}
