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

/** The same twelve as `dd-mmm-yy` prints them. */
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A stored `YYYY-MM-DD` as `dd-mmm-yy` — `2026-08-05` → `05-Aug-26`.
 *
 * The per-site finance file asks for the date in this shape (7.4). It is written
 * as TEXT rather than as an Excel date: the day, the month label and the year
 * reach the export from three separate cells (2.2), and a text date cannot be
 * re-formatted into `08/05/26` by whichever locale opens the file.
 *
 * @param {*} value `YYYY-MM-DD`, e.g. from entryDate().
 * @param {string} [fallback=''] shown when there is no usable date.
 * @return {string}
 */
export function formatShortDate(value, fallback = '') {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value === null || value === undefined ? '' : value).trim());
  if (!parts) return fallback;

  const month = MONTH_LABELS[parseInt(parts[2], 10) - 1];
  if (!month) return fallback;

  return parts[3] + '-' + month + '-' + parts[1].slice(2);
}

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
 * The day a LEGACY entry is settling, as `YYYY-MM-DD`.
 *
 * Built from the settlement's fiscal year and the row's own month + day, because
 * an entry written before the date column stored those three separately (2.2)
 * and the Site→JC picker needs one date to compare task dates against (6.6.3).
 *
 * Nothing writes rows in that shape any more. Call `entryDateOf()` instead —
 * this is the fallback inside it, kept exported only for the readers that still
 * hold a fiscal year and a month rather than a row.
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

/**
 * The day an entry is settling — the client twin of Utils.gs `entryDateOf()`.
 *
 * **Every reader of an entry's date goes through this.** An entry carries one
 * `date` cell; every entry written before that carries `month` and `day`, and
 * only the SETTLEMENT knows which year those belong to. A reader that reached
 * for `row.day` on its own would sort 3 September above 27 August, or resolve a
 * job code against the wrong year (§6.6.3).
 *
 * @param {Object} row an entry, as the server shapes it.
 * @param {Object} [settlement] its settlement; only the legacy path needs it.
 * @return {string} `YYYY-MM-DD`, or '' when the row carries no readable day.
 */
export function entryDateOf(row, settlement) {
  if (!row) return '';

  const direct = normalizeIsoDate(row.date);
  if (direct) return direct;

  return entryDate(settlement && settlement.fiscal_year, row.month, row.day);
}

/**
 * A stored date cell as `YYYY-MM-DD`, or '' when it is not one.
 * @param {*} value
 * @return {string}
 */
export function normalizeIsoDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) return isNaN(value.getTime()) ? '' : ymd(value);

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(value).trim());
  return iso ? build(+iso[1], +iso[2], +iso[3]) : '';
}

/* ------------------------------------------------------------------ *
 * Typing a date into the grid
 * ------------------------------------------------------------------ */

/**
 * What the coordinator typed into a date cell, as `YYYY-MM-DD`.
 *
 * **Day-first**, which is how everyone here writes a date and how the paperwork
 * the entries come off is written. Day-first is only safe because the cell
 * REWRITES ITSELF on blur to `11-Aug-26` — that is the mechanism, not a nicety:
 * the coordinator sees immediately whether the app read `11-9` as 11 September,
 * and a misreading cannot sit unnoticed in a cell that still says what he typed.
 *
 *   `11`                                 11 of the reference month and year
 *   `11-9`  `11/9`  `11.9`               11 September, year from the reference
 *   `11-9-26`  `11-9-2026`               11 September 2026
 *   `11-sep`  `11-SEP-26`  `11-sep-2026` the same, by name
 *   `2026-09-11`                         ISO — four digits first means year first
 *   anything else                        '' — the cell stays as typed, red, and
 *                                        blocks confirm
 *
 * Do not make the matching fuzzier than this. `07/12/2025` is December to the
 * person who typed it and July to a US-locale reader; the whole reason this is a
 * fixed short list is that a guess puts money under the wrong day.
 *
 * @param {*} value what is in the cell.
 * @param {string} [referenceIso] the row above's date, for the parts that were
 *        not typed. Today's date when there is no row above (decision 31) — the
 *        settlement no longer has a month to borrow.
 * @return {string} `YYYY-MM-DD`, or '' when it is not a date.
 */
export function parseTypedDate(value, referenceIso = '') {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return '';

  // Four digits at the front means year first, whatever follows.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return realDate(+iso[1], +iso[2], +iso[3]);

  const parts = text.split(/[\s\-/.]+/).filter(Boolean);
  if (!parts.length || parts.length > 3) return '';

  if (!/^\d{1,2}$/.test(parts[0])) return '';
  const day = parseInt(parts[0], 10);

  const reference = referenceParts(referenceIso);
  let month = reference.month;
  let year = reference.year;

  if (parts.length >= 2) {
    month = /^\d{1,2}$/.test(parts[1])
      ? parseInt(parts[1], 10)
      : monthNumber(parts[1]);
  }

  if (parts.length === 3) {
    year = readTypedYear(parts[2]);
  }

  return realDate(year, month, day);
}

/**
 * The month and year an untyped part falls back to: the row above's, or today's
 * when there is no row above.
 *
 * It used to be the settlement's own month and fiscal year, which no longer
 * exist — a settlement belongs to a team now. The row above is a better answer
 * anyway: entries are typed in date order down the grid, so the row above is
 * almost always the same month, and a batch that crosses into September keeps
 * working with no month to contradict it.
 *
 * @param {string} referenceIso
 * @return {{month: number, year: number}}
 */
function referenceParts(referenceIso) {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(referenceIso || '').trim());
  if (parsed) return { month: +parsed[2], year: +parsed[1] };

  const today = new Date();
  return { month: today.getMonth() + 1, year: today.getFullYear() };
}

/**
 * A typed year: `26` is 2026, `2026` is 2026.
 * @param {string} text
 * @return {number} 0 when it is not a year.
 */
function readTypedYear(text) {
  if (/^\d{4}$/.test(text)) return parseInt(text, 10);
  if (/^\d{2}$/.test(text)) return 2000 + parseInt(text, 10);
  return 0;
}

/**
 * `YYYY-MM-DD`, but only for a day that exists.
 *
 * build() accepts any day from 1 to 31, which is right when reading a date out
 * of a file that was written by something that already validated it. A typed
 * `31-2` is a typo, and storing `2026-02-31` would show up as an invalid date
 * somewhere much further downstream.
 *
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day 1-31
 * @return {string} '' when the three do not name a real day.
 */
function realDate(year, month, day) {
  const iso = build(year, month, day);
  if (!iso) return '';

  const check = new Date(Date.UTC(year, month - 1, day));
  const same = check.getUTCFullYear() === year
    && check.getUTCMonth() === month - 1
    && check.getUTCDate() === day;

  return same ? iso : '';
}
