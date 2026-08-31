/**
 * dates.js — displaying the timestamps the server writes (CLAUDE.md 2.3).
 *
 * Everything stored is an ISO string; everything shown is a fixed
 * `YYYY-MM-DD` / `YYYY-MM-DD HH:mm`, in every language.
 *
 * That is deliberate rather than lazy. Dates are numbers, and CLAUDE.md 8.1 keeps
 * numbers LTR even in Arabic — a locale-formatted Arabic date would bring
 * Eastern-Arabic numerals and a right-to-left field order with it, and sit badly
 * beside the Site IDs and Job Codes in the same table. A caller wraps the result
 * in `.num`, and it reads the same either way.
 */

/**
 * A stored timestamp as a Date.
 * @param {*} value ISO string, Date, or ''.
 * @return {Date|null} null when blank or unparseable.
 */
export function parseStamp(value) {
  if (value === null || value === undefined || value === '') return null;

  const date = (value instanceof Date) ? value : new Date(String(value));
  return isNaN(date.getTime()) ? null : date;
}

/**
 * @param {*} value a stored timestamp.
 * @param {string} [fallback=''] shown when there is no usable date.
 * @return {string} 'YYYY-MM-DD'
 */
export function formatDate(value, fallback = '') {
  const date = parseStamp(value);
  if (!date) return fallback;

  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate())
  ].join('-');
}

/**
 * @param {*} value a stored timestamp.
 * @param {string} [fallback=''] shown when there is no usable date.
 * @return {string} 'YYYY-MM-DD HH:mm' in the viewer's own timezone.
 */
export function formatDateTime(value, fallback = '') {
  const date = parseStamp(value);
  if (!date) return fallback;

  return formatDate(date) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

/**
 * @param {number} n
 * @return {string}
 */
function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/* ------------------------------------------------------------------ *
 * Reading dates out of an uploaded spreadsheet
 * ------------------------------------------------------------------ */

/** Month names as the tracking file writes them (`07-Dec-2025`). */
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                     'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A Task Date cell from the Site→JC tracking file, as a stored `YYYY-MM-DD`.
 *
 * This is the field the whole old/new split now hangs off (rule 14), so it is
 * worth being explicit about what it will and will not read:
 *
 *   - A real **Date** — what a properly-typed Excel date cell gives us, and the
 *     only form with no ambiguity in it. Read in the file's own terms (the
 *     spreadsheet library builds these at local midnight), never shifted to UTC,
 *     because a shift can move `01-Jan-2026` back into 2025 and flip its period.
 *   - `07-Dec-2025` / `7 Dec 2025` — a **named** month, unambiguous.
 *   - `2025-12-07` — ISO.
 *   - An Excel **serial** number (`45998`), for a date column that lost its
 *     formatting on the way out.
 *
 * `07/12/2025` is deliberately NOT read: it means December to the person who
 * made the file and July to a US-locale reader, and guessing wrong moves a row
 * to the other Tracking#. It comes back as '' and the row settles as `new`,
 * which the import preview reports so the file can be fixed at source.
 *
 * @param {*} value a cell from readSheetRows(), raw or text.
 * @return {string} `YYYY-MM-DD`, or '' when there is no date to be sure of.
 */
export function parseSheetDate(value) {
  if (value === null || value === undefined || value === '') return '';

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? '' : ymd(value);
  }

  if (typeof value === 'number' && isFinite(value)) return fromExcelSerial(value);

  const text = String(value).trim();
  if (!text) return '';

  // ISO first — it is what our own server stores and sends back.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return build(+iso[1], +iso[2], +iso[3]);

  // `07-Dec-2025`, `7 Dec 2025`, `07/Dec/2025`, and the `Dec 7, 2025` order.
  const dmy = /^(\d{1,2})[\s\-/.]+([A-Za-z]{3,})[\s\-/.]+(\d{4})$/.exec(text);
  if (dmy) return build(+dmy[3], monthNumber(dmy[2]), +dmy[1]);

  const mdy = /^([A-Za-z]{3,})[\s\-/.]+(\d{1,2})[\s,\-/.]+(\d{4})$/.exec(text);
  if (mdy) return build(+mdy[3], monthNumber(mdy[1]), +mdy[2]);

  // A bare serial that arrived as text.
  if (/^\d+(\.\d+)?$/.test(text)) return fromExcelSerial(parseFloat(text));

  return '';
}

/**
 * @param {number} year
 * @param {number} month 1-12; 0 when the name was not recognised.
 * @param {number} day
 * @return {string}
 */
function build(year, month, day) {
  if (!(month >= 1 && month <= 12)) return '';
  if (!(day >= 1 && day <= 31)) return '';
  if (!(year >= 1900 && year <= 2999)) return '';

  return year + '-' + pad2(month) + '-' + pad2(day);
}

/**
 * @param {string} name
 * @return {number} 1-12, or 0 when it is not a month.
 */
function monthNumber(name) {
  return MONTH_NAMES.indexOf(String(name).slice(0, 3).toLowerCase()) + 1;
}

/**
 * An Excel date serial as `YYYY-MM-DD`.
 *
 * Day 1 is 1900-01-01, and Excel's famous phantom 29-Feb-1900 means serials past
 * 60 are one day ahead of a true count — the `- 25569` epoch offset below is the
 * standard correction, and it is why this is arithmetic rather than a Date sum.
 *
 * @param {number} serial
 * @return {string}
 */
function fromExcelSerial(serial) {
  if (!isFinite(serial) || serial < 1 || serial > 2958465) return '';

  // Built in UTC and read back in UTC, so no timezone can shift the day.
  const date = new Date(Math.round((serial - 25569) * 86400000));
  if (isNaN(date.getTime())) return '';

  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate())
  ].join('-');
}

/** A Date as `YYYY-MM-DD` in its own local terms. @return {string} */
function ymd(date) {
  return [date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join('-');
}

/**
 * The day an entry is settling, as `YYYY-MM-DD`.
 *
 * Built from the settlement's fiscal year and the row's own month + day, because
 * the grid stores those three separately (2.2) and the Site→JC picker needs one
 * date to compare task dates against (6.6.3).
 *
 * @param {*} fiscalYear e.g. '2026'.
 * @param {*} month a three-letter label from `Lists.months`.
 * @param {*} day 1-31.
 * @return {string} '' when any of the three is missing or unreadable.
 */
export function entryDate(fiscalYear, month, day) {
  const year = parseInt(String(fiscalYear || '').trim(), 10);
  const dayNumber = parseInt(String(day === 0 ? '0' : (day || '')).trim(), 10);

  return build(year, monthNumber(String(month || '').trim()), dayNumber);
}
