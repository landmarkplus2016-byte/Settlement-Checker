/**
 * gridAutofill.js — Site ID → Job Code + period (CLAUDE.md 6.6.3, rule 14).
 *
 * This is the old workbook's "JC Finder" folded into entry. The coordinator used
 * to look a site up in a separate sheet and copy its job code across by hand;
 * here, typing the Site ID fills the Job Code in as he leaves the cell.
 *
 * The part that matters more than the convenience is `period`. It is what routes
 * an entry to the OLD or the NEW Tracking# (6.2), and getting it from the lookup
 * rather than from a person is what stops a month's worth of rows quietly
 * settling against the wrong number. Rule 14: the lookup's answer is always the
 * default — and the coordinator may override it, which this file remembers.
 *
 * Three behaviours are worth knowing:
 *
 *   - **Matching ignores case.** Real site lists carry `k3799` beside `K3666`,
 *     and a coordinator typing `K3799` from paperwork must still find the row.
 *     The server matches the same way.
 *   - **A multi-site cell resolves per segment.** `377/442` produces
 *     `CABH783/CABH789` in the same order, because the per-site export pairs
 *     site *i* with job code *i* (6.4). An unknown segment leaves its position
 *     BLANK rather than collapsing the list, so that pairing survives.
 *   - **The first known segment decides the period.** A mixed cell has to settle
 *     against one Tracking# or the other, and the first site the lookup knows is
 *     the least surprising answer.
 */

import { api } from '../api.js';
import { splitMulti, text as asText, period as asPeriod } from '../utils/validate.js';

/**
 * The lookup, fetched once per session (6.6.3) and keyed by UPPERCASED site id.
 *
 * A session-long cache is right here because SiteJC is shared configuration that
 * changes when a manager edits it, not while a coordinator types. Re-reading it
 * per keystroke would put an Apps Script round trip in the middle of the edit
 * path, which is the one thing 6.5 exists to keep out of it.
 */
let cachedMap = null;

/** The in-flight fetch, so two grids mounting at once make one request. */
let pendingLoad = null;

/**
 * Fetch the Site → Job Code lookup, once.
 *
 * A failure is not fatal and is not retried in a loop: the grid simply goes
 * without autofill, every site reads as unknown, and the coordinator fills the
 * Job Code in by hand exactly as he did before this screen existed.
 *
 * @return {Promise<Object|null>} the map, or null when it could not be read.
 */
export async function loadSiteJcMap() {
  if (cachedMap) return cachedMap;
  if (pendingLoad) return pendingLoad;

  pendingLoad = api.call('list_site_jc', {})
    .then(function (data) {
      cachedMap = buildMap((data && data.sites) || []);
      pendingLoad = null;
      return cachedMap;
    })
    .catch(function (err) {
      console.warn('Site → Job Code lookup unavailable: ' + (err && err.serverMessage));
      pendingLoad = null;
      return null;
    });

  return pendingLoad;
}

/**
 * @param {Array<Object>} sites rows from `list_site_jc`.
 * @return {Object} UPPERCASED site_id -> { site_id, job_code, period }
 */
export function buildMap(sites) {
  const map = {};

  (sites || []).forEach(function (site) {
    const id = asText(site.site_id);
    if (!id) return;

    map[id.toUpperCase()] = {
      site_id: id,
      job_code: asText(site.job_code),
      period: asPeriod(site.period)
    };
  });

  return map;
}

/** @return {Object|null} the loaded map, or null before/without a successful load. */
export function siteJcMap() {
  return cachedMap;
}

/** Drop the cached lookup — after a manager edits it, or on sign-out. */
export function clearSiteJcCache() {
  cachedMap = null;
  pendingLoad = null;
}

/* ------------------------------------------------------------------ *
 * Resolving
 * ------------------------------------------------------------------ */

/**
 * Resolve one Site ID cell against the lookup.
 *
 * @param {*} cell the raw site_id value; may be `/`-joined.
 * @param {Object|null} map from siteJcMap().
 * @return {{segments: Array<string>, codes: Array<string>, job_code: string,
 *           period: string, unknown: Array<string>, known: number}}
 */
export function resolveSite(cell, map) {
  const segments = splitMulti(cell);
  const empty = { segments: segments, codes: [], job_code: '', period: '', unknown: [], known: 0 };

  if (!segments.length || !map) return empty;

  const codes = [];
  const unknown = [];
  let period = '';
  let known = 0;

  segments.forEach(function (segment) {
    const hit = map[segment.toUpperCase()];

    if (!hit) {
      // The blank holds the position, so site i still lines up with code i (6.4).
      codes.push('');
      unknown.push(segment);
      return;
    }

    codes.push(hit.job_code);
    known++;

    // First known segment wins the period.
    if (!period && hit.period) period = hit.period;
  });

  return {
    segments: segments,
    codes: codes,
    job_code: codes.join('/'),
    period: period,
    unknown: unknown,
    known: known
  };
}

/**
 * Apply the lookup to one row, in place.
 *
 * Two refusals, both deliberate:
 *
 *   - When NOTHING resolved, the row is left completely alone. 6.3 says an
 *     unknown site warns and leaves `job_code`/`period` for the coordinator to
 *     set; overwriting what he typed with a blank would be the opposite of that,
 *     and it would also wipe a Job Code that arrived with a paste.
 *   - When the coordinator has set the period HIMSELF, autofill does not touch
 *     it again (rule 14). `_period_manual` is the flag, and it is set by the
 *     grid's own period cell — see onPeriodCommit().
 *
 * @param {Object} row a grid row, mutated.
 * @param {Object|null} map
 * @return {{changed: Array<string>, unknown: Array<string>, known: number}}
 */
export function autofillRow(row, map) {
  const result = resolveSite(row.site_id, map);
  const changed = [];

  if (result.known > 0) {
    if (asText(row.job_code) !== result.job_code) {
      row.job_code = result.job_code;
      changed.push('job_code');
    }

    if (!row._period_manual && result.period && asPeriod(row.period) !== result.period) {
      row.period = result.period;
      changed.push('period');
    }
  }

  return { changed: changed, unknown: result.unknown, known: result.known };
}

/**
 * Remember that a period was chosen by hand, so autofill stops overriding it
 * (rule 14). Clearing the cell hands control back to the lookup.
 *
 * @param {Object} row
 * @param {*} value the period the coordinator picked.
 */
export function onPeriodCommit(row, value) {
  row._period_manual = asPeriod(value) !== '';
}

/* ------------------------------------------------------------------ *
 * The grid hook
 * ------------------------------------------------------------------ */

/**
 * Build the `onCellCommit` handler grid.js calls after every committed edit.
 *
 * Hung off `change` rather than `input` on purpose: a lookup per keystroke would
 * resolve `K`, `K1`, `K12`… and flicker the Job Code cell all the way through a
 * site id the coordinator has not finished typing.
 *
 * @param {Object} options
 * @param {Function} options.getMap returns the current map (may be null).
 * @param {Function} [options.onResolved] called as (row, result) after a site
 *        cell resolves — the page uses it to say what happened.
 * @return {Function} (row, field, value, controller)
 */
export function makeAutofillHook(options = {}) {
  const getMap = options.getMap || siteJcMap;

  return function (row, field, value, controller) {
    if (field === 'period') {
      onPeriodCommit(row, value);
      return;
    }

    if (field !== 'site_id') return;

    const result = autofillRow(row, getMap());

    // Push the changed values into their cells WITHOUT a re-render, so the
    // caret stays wherever the coordinator just moved it (5.3).
    if (result.changed.length && controller && controller.syncRow) {
      controller.syncRow(row, result.changed);
    }

    if (typeof options.onResolved === 'function') options.onResolved(row, result);
  };
}
