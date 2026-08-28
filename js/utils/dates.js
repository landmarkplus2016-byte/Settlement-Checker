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
