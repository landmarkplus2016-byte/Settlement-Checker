/**
 * explode.js — the per-site split (CLAUDE.md 6.4, rule 18).
 *
 * A coordinator files one line for work that covered several sites, with the
 * sites joined by `/` in one cell:
 *
 *     site_id  '377/442/K1286'   job_code  'CABH783/CABH789/CABH762'   amount 200
 *
 * The **per-site** export turns that into one row per site so finance can charge
 * each site its share. The Normal export leaves the combined line alone; this
 * file is used by the per-site report only.
 *
 * Two rules, and the second one is the one that gets broken by accident:
 *
 *   - **Money divides.** `amount` (expenses), `fuel_amount` and `karta_amount`
 *     (fuel) are split across the sites, and the rows must re-sum to the
 *     original EXACTLY. 200 across 3 is 66.67 + 66.67 + 66.66, not three times
 *     66.67 — the remainder cent goes on the last site.
 *   - **KM never divides.** `start_km` and `end_km` are odometer READINGS, not
 *     quantities. Half of "started at 41,200 km" is not a number that means
 *     anything. They are copied onto every exploded row unchanged.
 *
 * This is a pure transform of rows the server already returned (3.7), which is
 * why it lives on the client: the same numbers go into the preview the manager
 * reads and into the .xlsx he downloads, from one code path.
 *
 * `testExplode()` at the bottom is the check for all of it. It runs in the
 * browser console — the app has no test runner and is not getting one (no npm,
 * no build step) — and is also exposed as `window.scTestExplode`.
 */

import { toNumber } from './validate.js';

/** The separator a coordinator types between sites in one cell (6.4). */
export const SITE_SEPARATOR = '/';

/**
 * The money fields that divide, per kind (rule 18).
 *
 * `start_km` / `end_km` are deliberately absent and must stay absent. They are
 * copied by the clone like every other field, which is exactly the behaviour
 * required — the way this rule gets broken is by someone adding them here.
 */
export const SPLIT_MONEY_FIELDS = {
  expense: ['amount'],
  fuel: ['fuel_amount', 'karta_amount']
};

/* ------------------------------------------------------------------ *
 * Dividing money
 * ------------------------------------------------------------------ */

/**
 * Divide an amount across n sites so the parts re-sum to the original exactly.
 *
 * Each part is `round(total / n, 2)`; the LAST part is whatever is left, so the
 * rounding remainder lands in one place instead of drifting across the file
 * (6.4). 200 across 3 → [66.67, 66.67, 66.66].
 *
 * Computed in integer cents. In floating point `66.67 * 3` is 200.00000000000003
 * and a file whose column does not add up to its own total is a file finance
 * sends back.
 *
 * A blank total stays blank: `null` in, an array of `null` out. A fuel row with
 * no karta amount must not acquire five 0.00 karta rows — "not a field of this
 * row" and "zero money" are different things, and the export prints them
 * differently.
 *
 * @param {*} total the amount to divide; anything toNumber() understands.
 * @param {number} n how many sites, >= 1.
 * @return {Array<number|null>} exactly `n` parts.
 */
export function divideAmount(total, n) {
  const count = Math.max(1, Math.floor(n) || 1);
  const value = toNumber(total);

  if (value === null) return new Array(count).fill(null);
  if (count === 1) return [round2(value)];

  const totalCents = Math.round(value * 100);

  // round(total / n, 2), expressed in cents.
  const eachCents = Math.round(totalCents / count);

  const parts = [];
  for (let i = 0; i < count - 1; i++) parts.push(eachCents / 100);

  // The last site absorbs the remainder, so the parts re-sum to `total`.
  parts.push((totalCents - eachCents * (count - 1)) / 100);

  return parts;
}

/**
 * Two decimal places, without the floating-point tail.
 * @param {number} value
 * @return {number}
 */
export function round2(value) {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * Splitting the site cell
 * ------------------------------------------------------------------ */

/**
 * The individual sites in a Site ID cell.
 *
 * Blank segments are dropped, so a trailing separator or a typed `377//442` does
 * not produce a phantom site with a share of the money.
 *
 * @param {*} siteId a cell value, e.g. '377/442'.
 * @return {Array<string>}
 */
export function siteSegments(siteId) {
  return String(siteId === null || siteId === undefined ? '' : siteId)
    .split(SITE_SEPARATOR)
    .map(function (part) { return part.trim(); })
    .filter(function (part) { return part !== ''; });
}

/**
 * The job codes in a Job Code cell, positionally paired with the sites.
 *
 * Blanks are KEPT here, unlike siteSegments(): the pairing is by position (6.4 —
 * "site *i* ↔ job code *i*"), so `CABH783//CABH762` means the middle site's code
 * is not known, and collapsing it would shift every later code onto the wrong
 * site.
 *
 * @param {*} jobCode a cell value.
 * @return {Array<string>}
 */
export function jobCodeSegments(jobCode) {
  const raw = String(jobCode === null || jobCode === undefined ? '' : jobCode).trim();
  if (!raw) return [];

  return raw.split(SITE_SEPARATOR).map(function (part) { return part.trim(); });
}

/* ------------------------------------------------------------------ *
 * The explosion
 * ------------------------------------------------------------------ */

/**
 * One entry row as one row per site.
 *
 * A single-site line passes straight through at its full amount — as one row,
 * marked `is_split: false`, so the caller can render every row the same way
 * without asking whether it was exploded.
 *
 * Every returned row is a fresh object; the input is never mutated. Everything
 * not named below is copied verbatim, which is how `start_km` / `end_km` reach
 * each row unchanged (rule 18).
 *
 * Added to each row:
 *   - `is_split`     — did this line cover more than one site?
 *   - `split_index`  — 1-based position, for the "split" indicator column (7.2).
 *   - `split_count`  — how many sites the original line covered.
 *   - `split_label`  — '2/3' for a split row, '' for a whole one.
 *   - `source_entry_id` — the entry this row came out of, so an exploded row can
 *     still be traced back to the one the coordinator typed.
 *
 * @param {Object} row a shaped entry from `export_query`.
 * @param {string} kind 'expense' | 'fuel'.
 * @return {Array<Object>} one row per site; never empty.
 */
export function explodeRow(row, kind) {
  const sites = siteSegments(row && row.site_id);
  const codes = jobCodeSegments(row && row.job_code);

  // No site at all, or one site: nothing to divide. The row still gets the split
  // fields so the export can treat every row alike.
  if (sites.length <= 1) {
    return [Object.assign({}, row, {
      site_id: sites.length ? sites[0] : String((row && row.site_id) || ''),
      job_code: codes.length ? codes[0] : String((row && row.job_code) || ''),
      is_split: false,
      split_index: 1,
      split_count: 1,
      split_label: '',
      source_entry_id: (row && row.entry_id) || ''
    })];
  }

  const count = sites.length;
  const fields = SPLIT_MONEY_FIELDS[kind] || SPLIT_MONEY_FIELDS.expense;

  // Divide each money field once, not once per site, so every row reads its
  // share out of the same division.
  const shares = {};
  fields.forEach(function (field) {
    shares[field] = divideAmount(row ? row[field] : null, count);
  });

  return sites.map(function (site, index) {
    const out = Object.assign({}, row, {
      site_id: site,

      // Positional pairing. A site with no matching code gets a blank rather
      // than the next site's code.
      job_code: (index < codes.length) ? codes[index] : '',

      is_split: true,
      split_index: index + 1,
      split_count: count,
      split_label: (index + 1) + SITE_SEPARATOR + count,
      source_entry_id: (row && row.entry_id) || ''
    });

    fields.forEach(function (field) {
      out[field] = shares[field][index];
    });

    return out;
  });
}

/**
 * Explode a whole list, keeping the original order.
 *
 * @param {Array<Object>} rows
 * @param {string} kind 'expense' | 'fuel'.
 * @return {Array<Object>}
 */
export function explodeRows(rows, kind) {
  const out = [];

  (rows || []).forEach(function (row) {
    explodeRow(row, kind).forEach(function (exploded) { out.push(exploded); });
  });

  return out;
}

/**
 * The total of one money field across a list — used to prove a preview's footer
 * still matches the un-exploded total.
 *
 * @param {Array<Object>} rows
 * @param {string} field
 * @return {number}
 */
export function sumField(rows, field) {
  let cents = 0;

  (rows || []).forEach(function (row) {
    const value = toNumber(row[field]);
    if (value !== null) cents += Math.round(value * 100);
  });

  return cents / 100;
}

/* ================================================================== *
 * testExplode() — run it in the browser console
 * ================================================================== */

/**
 * Check every rule in 6.4. Returns the result and logs a readable summary.
 *
 * Run it from the console on any screen that has loaded this module (the export
 * screen does):
 *
 *     scTestExplode()
 *
 * @return {{passed: number, failed: number, cases: Array<Object>}}
 */
export function testExplode() {
  const cases = [];

  /**
   * @param {string} name
   * @param {*} actual
   * @param {*} expected compared as JSON, so arrays and numbers both work.
   */
  function check(name, actual, expected) {
    const got = JSON.stringify(actual);
    const want = JSON.stringify(expected);
    cases.push({ name: name, ok: got === want, got: got, want: want });
  }

  /* --- divideAmount: the two cases from BUILD.md --- */

  check('200 across 5 → 40 × 5',
    divideAmount(200, 5),
    [40, 40, 40, 40, 40]);

  check('200 across 3 → 66.67, 66.67, 66.66',
    divideAmount(200, 3),
    [66.67, 66.67, 66.66]);

  /* --- divideAmount: the properties those two are examples of --- */

  check('the parts re-sum to the original exactly',
    divideAmount(200, 3).reduce(function (a, b) { return Math.round((a + b) * 100) / 100; }, 0),
    200);

  check('100 across 3 puts the remainder on the last site',
    divideAmount(100, 3),
    [33.33, 33.33, 33.34]);

  check('0.01 across 3 does not invent money',
    divideAmount(0.01, 3),
    [0, 0, 0.01]);

  check('one site keeps the whole amount', divideAmount(200, 1), [200]);
  check('a blank amount stays blank', divideAmount(null, 3), [null, null, null]);
  check('a blank string stays blank', divideAmount('', 2), [null, null]);
  check('a pasted "1,200.50" is understood', divideAmount('1,200.50', 2), [600.25, 600.25]);

  /* --- the site cell --- */

  check('sites split on /', siteSegments('377/442/K1286'), ['377', '442', 'K1286']);
  check('spaces around a site are trimmed', siteSegments(' 377 / 442 '), ['377', '442']);
  check('an empty segment is dropped', siteSegments('377//442'), ['377', '442']);
  check('a blank cell has no sites', siteSegments(''), []);
  check('job codes keep their blanks for pairing',
    jobCodeSegments('CABH783//CABH762'), ['CABH783', '', 'CABH762']);

  /* --- explodeRow: expenses --- */

  const expense = explodeRow({
    entry_id: 'E-000001',
    site_id: '377/442/K1286',
    job_code: 'CABH783/CABH789/CABH762',
    amount: 200,
    category: 'Transportation',
    team: 'Team Ashraf'
  }, 'expense');

  check('a 3-site expense becomes 3 rows', expense.length, 3);
  check('sites come out in order',
    expense.map(function (r) { return r.site_id; }), ['377', '442', 'K1286']);
  check('job codes pair with their own site',
    expense.map(function (r) { return r.job_code; }), ['CABH783', 'CABH789', 'CABH762']);
  check('the amount is divided with the remainder last',
    expense.map(function (r) { return r.amount; }), [66.67, 66.67, 66.66]);
  check('the exploded rows re-sum to the original', sumField(expense, 'amount'), 200);
  check('fields that are not money are carried across',
    expense[2].category, 'Transportation');
  check('every exploded row remembers its source entry',
    expense[1].source_entry_id, 'E-000001');
  check('a split row is labelled for the indicator column',
    expense.map(function (r) { return r.split_label; }), ['1/3', '2/3', '3/3']);

  /* --- explodeRow: fuel, where KM must survive intact (rule 18) --- */

  const fuel = explodeRow({
    entry_id: 'F-000009',
    site_id: '377/442',
    job_code: 'CABH783/CABH789',
    start_km: 41200,
    end_km: 41395,
    fuel_amount: 500,
    karta_amount: 75,
    driver: 'Ashraf'
  }, 'fuel');

  check('a 2-site fuel line becomes 2 rows', fuel.length, 2);
  check('fuel is divided',
    fuel.map(function (r) { return r.fuel_amount; }), [250, 250]);
  check('karta is divided',
    fuel.map(function (r) { return r.karta_amount; }), [37.5, 37.5]);
  check('START KM is copied, never divided',
    fuel.map(function (r) { return r.start_km; }), [41200, 41200]);
  check('END KM is copied, never divided',
    fuel.map(function (r) { return r.end_km; }), [41395, 41395]);

  const fuelNoKarta = explodeRow({
    site_id: '377/442/K1286', job_code: '', fuel_amount: 300, karta_amount: null
  }, 'fuel');

  check('a missing karta stays missing on every row',
    fuelNoKarta.map(function (r) { return r.karta_amount; }), [null, null, null]);
  check('a missing job code leaves every code blank',
    fuelNoKarta.map(function (r) { return r.job_code; }), ['', '', '']);

  /* --- single-site rows pass through --- */

  const single = explodeRow({
    entry_id: 'E-000002', site_id: 'K3666', job_code: 'CABH559', amount: 125.5
  }, 'expense');

  check('a single-site line stays one row', single.length, 1);
  check('a single-site line keeps its full amount', single[0].amount, 125.5);
  check('a single-site line is not marked split', single[0].is_split, false);
  check('a single-site line has no split label', single[0].split_label, '');

  /* --- the input is never mutated --- */

  const original = { entry_id: 'E-3', site_id: 'A/B', job_code: 'J1/J2', amount: 10 };
  explodeRow(original, 'expense');
  check('the original row is left alone', original.amount, 10);
  check('the original site cell is left alone', original.site_id, 'A/B');

  /* --- report --- */

  const failed = cases.filter(function (c) { return !c.ok; });

  console.log(
    '%cexplode.js — ' + (cases.length - failed.length) + '/' + cases.length + ' passed',
    failed.length ? 'color:#991b1b;font-weight:700' : 'color:#15803d;font-weight:700'
  );

  failed.forEach(function (c) {
    console.error('FAILED: ' + c.name + '\n  expected ' + c.want + '\n  got      ' + c.got);
  });

  return { passed: cases.length - failed.length, failed: failed.length, cases: cases };
}

/*
 * Reachable from the console without an import. The app has no test runner and
 * is not getting one, so this is how 6.4 is checked on a real device — including
 * a phone, where there is no other way to run it.
 */
if (typeof window !== 'undefined') window.scTestExplode = testExplode;
