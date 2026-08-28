/**
 * money.js — EGP for display (CLAUDE.md 2.3, 8.1).
 *
 * Money is stored as a plain number with no currency symbol (2.3); the symbol
 * and the grouping are a display concern, and this is where they live.
 *
 * Always two decimals, always Western digits, always grouped with commas — in
 * both languages. 8.1 keeps numbers and money LTR even in Arabic, so a total
 * sitting inside an Arabic sentence still reads as a number. The caller wraps
 * the result in `.num`, which pins the direction; formatting it per-locale would
 * bring Eastern-Arabic numerals and undo that.
 */

import { toNumber } from './validate.js';

/**
 * A number as displayed money: '1,234.50'.
 *
 * A blank or unparseable value formats as '0.00' rather than throwing — this is
 * called from render paths where a missing cell is normal, and a table that
 * refuses to paint is worse than a zero.
 *
 * @param {*} value
 * @return {string}
 */
export function formatMoney(value) {
  const number = toNumber(value) || 0;
  return number.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The same, but blank when there is no number at all.
 *
 * The difference matters in a consolidated table: a fuel row has no `amount` and
 * an expense row has no `karta_amount`, and printing '0.00' in those cells would
 * read as "zero money" rather than "not a field of this row".
 *
 * @param {*} value
 * @param {string} [fallback=''] shown when the value is blank or zero.
 * @return {string}
 */
export function formatMoneyOrBlank(value, fallback = '') {
  const number = toNumber(value);
  if (number === null || number === 0) return fallback;
  return formatMoney(number);
}
