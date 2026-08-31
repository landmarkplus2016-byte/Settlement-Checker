/**
 * gridSplit.js — splitting a mixed-period line into one row per period (6.6.7).
 *
 * A coordinator files one line for work that covered several sites, joined by `/`
 * in one cell. Most of the time those sites agree about the period and nothing
 * here is needed. Sometimes they do not:
 *
 *     site_id  '0004/0025'   job_code  'CABH335/MG1180'   amount 1000
 *              ^ old         ^ new
 *
 * That row cannot be settled as it stands. A row carries ONE `period`, which
 * routes it to ONE of the settlement's two Tracking#s (6.2, rule 10) — so
 * whichever way it goes, half the money is filed under the wrong number. There is
 * no third answer: the settlement holds exactly one old number and one new one.
 *
 * The fix is therefore not a cleverer period cell. It is to split the line in two
 * — the old sites on one row, the new sites on another, both in the SAME
 * settlement, because old and new are two tracks inside one settlement and not
 * two settlements (2.2). That is what 6.3's `mixed_period` warning has always
 * said ("so split it"); this file is that sentence made into a button.
 *
 * What it does NOT do is decide the money. It divides evenly by site count, using
 * the SAME integer-cent rounding as the per-site export (6.4, `divideAmount`), so
 * the resulting rows re-sum to the original to the cent and match what finance
 * would have seen on the per-site file anyway. That is a default, not a claim:
 * both rows land as ordinary editable drafts and the coordinator, who knows what
 * the work actually cost at each site, retypes the amounts if the even split is
 * wrong.
 *
 * KM never divides (rule 18). `start_km` and `end_km` are odometer readings, so
 * both halves of a split fuel line carry the same readings, unchanged — exactly
 * as the per-site export copies them.
 *
 * This module is a PURE transform: it reads a row and returns a plan. Nothing is
 * mutated and nothing is rendered here; grid.js owns the model surgery, the same
 * way explode.js plans and the export builder applies.
 */

import {
  divideAmount, round2, siteSegments, jobCodeSegments,
  SITE_SEPARATOR, SPLIT_MONEY_FIELDS
} from '../utils/explode.js';
import { period as asPeriod } from '../utils/validate.js';

/**
 * The order the split's rows come out in: old first, then new.
 *
 * Fixed rather than first-seen, so splitting `0025/0004` (new then old) produces
 * the same two rows in the same order as splitting `0004/0025`. A coordinator
 * comparing his grid to last month's should not find the halves swapped because
 * of the order he happened to type the sites in.
 */
export const PERIOD_ORDER = ['old', 'new'];

/**
 * Can this row be split by period?
 *
 * Cheap enough to call from a render pass — it is what decides whether the period
 * cell shows its split button.
 *
 * @param {Object} row a grid row, with `__site_periods` decoration.
 * @param {string} kind 'expense' | 'fuel'.
 * @return {boolean}
 */
export function canSplitByPeriod(row, kind) {
  return planPeriodSplit(row, kind).ok;
}

/**
 * Work out how a row would split, without touching it.
 *
 * The per-site periods come from `row.__site_periods`, which gridAutofill.js
 * resolves per segment against the lookup and hangs off the row (6.6.3). They are
 * checked against the Site ID cell rather than trusted: the decoration is
 * rebuilt on commit and on load, but a row mid-edit can hold a site count the
 * strip has not caught up with, and splitting on a stale pairing would move a
 * job code onto the wrong site.
 *
 * A site the lookup does not know has no period of its own, so it follows the
 * ROW's period — the track the coordinator has the row filed under. It is the
 * only answer available, it keeps the site with the half it is already settling
 * with, and the coordinator can move it afterwards.
 *
 * @param {Object} row a grid row.
 * @param {string} kind 'expense' | 'fuel'.
 * @return {{ok: boolean, reason: string, groups: Array<Object>, sites: number}}
 *         Each group is `{ period, sites, codes, indices, site_id, job_code,
 *         money }`, where `money` is field -> the group's share.
 */
export function planPeriodSplit(row, kind) {
  const no = function (reason) {
    return { ok: false, reason: reason, groups: [], sites: 0 };
  };

  if (!row) return no('no_row');

  const sites = siteSegments(row.site_id);
  if (sites.length < 2) return no('single_site');

  const segments = row.__site_periods || [];
  if (segments.length !== sites.length) return no('not_resolved');

  const codes = jobCodeSegments(row.job_code);

  // Where a site's own period is unknown, it settles with the row.
  const rowPeriod = asPeriod(row.period);

  const buckets = {};
  const order = [];

  for (let i = 0; i < sites.length; i++) {
    const own = asPeriod(segments[i] && segments[i].period);
    const period = own || rowPeriod;

    // Nothing to file it under at all — neither the lookup nor the row has an
    // answer, so there is no split to plan yet.
    if (!period) return no('period_unknown');

    if (!buckets[period]) {
      buckets[period] = { period: period, sites: [], codes: [], indices: [] };
      order.push(period);
    }

    buckets[period].sites.push(sites[i]);
    // Positional pairing (6.4): site i ↔ code i, and a missing code stays blank
    // rather than pulling a later one into its place.
    buckets[period].codes.push(codes[i] === undefined ? '' : codes[i]);
    buckets[period].indices.push(i);
  }

  if (order.length < 2) return no('single_period');

  const moneyFields = SPLIT_MONEY_FIELDS[kind] || [];

  // One even share per SITE, then re-gathered per group — so a 3-site row that
  // splits 2 old / 1 new divides into thirds and not into halves, and the two
  // rows still add back up to the original exactly (6.4).
  const shares = {};
  moneyFields.forEach(function (field) {
    shares[field] = divideAmount(row[field], sites.length);
  });

  const groups = PERIOD_ORDER
    .filter(function (period) { return !!buckets[period]; })
    .map(function (period) {
      const bucket = buckets[period];
      const money = {};

      moneyFields.forEach(function (field) {
        money[field] = sumShares(shares[field], bucket.indices);
      });

      return {
        period: period,
        sites: bucket.sites,
        codes: bucket.codes,
        indices: bucket.indices,
        site_id: bucket.sites.join(SITE_SEPARATOR),
        job_code: joinCodes(bucket.codes),
        money: money
      };
    });

  return { ok: true, reason: '', groups: groups, sites: sites.length };
}

/**
 * Add up one group's per-site shares.
 *
 * A blank total stays blank, exactly as `divideAmount` leaves it: a fuel row with
 * no karta amount must not acquire a 0.00 on each half. "Not a field of this row"
 * and "zero money" are different things and the export prints them differently.
 *
 * @param {Array<number|null>} parts
 * @param {Array<number>} indices
 * @return {number|null}
 */
function sumShares(parts, indices) {
  let total = 0;
  let any = false;

  for (let i = 0; i < indices.length; i++) {
    const part = parts[indices[i]];
    if (part === null || part === undefined) continue;
    total += part;
    any = true;
  }

  return any ? round2(total) : null;
}

/**
 * Join a group's job codes back into one cell.
 *
 * All-blank collapses to an empty cell rather than to `//`, which would read as
 * two codes the lookup could not find and would flag the row for no reason.
 *
 * @param {Array<string>} codes
 * @return {string}
 */
function joinCodes(codes) {
  const joined = codes.join(SITE_SEPARATOR);
  return /[^/]/.test(joined) ? joined : '';
}
