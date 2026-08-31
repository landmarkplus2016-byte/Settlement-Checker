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
 * Five behaviours are worth knowing:
 *
 *   - **A site has SEVERAL job codes.** The tracking file raises a new job code
 *     against a site every time work is ordered there, so `K3602` carries both
 *     `ABD02` (07-Dec-2025) and `ABD12` (23-Sep-2025) — and both are `old`, so
 *     the period cannot tell them apart. Which one an entry means is decided by
 *     the day it is settling: see pickCandidate().
 *   - **The coordinator can overrule the choice**, and once he types a Job Code
 *     himself, autofill stops replacing it (`_jc_manual`) — the same bargain
 *     rule 14 strikes for the period. Changing the Site ID clears it, because a
 *     new site makes the old choice meaningless.
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
import { entryDate } from '../utils/dates.js';
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
 * @return {Object} UPPERCASED site_id -> Array<{site_id, job_code, task_date,
 *         period}>, newest task_date first. Mirrors getSiteJcMap() in Admin.gs.
 */
export function buildMap(sites) {
  const map = {};

  (sites || []).forEach(function (site) {
    const id = asText(site.site_id);
    const code = asText(site.job_code);
    if (!id || !code) return;

    const key = id.toUpperCase();
    if (!map[key]) map[key] = [];

    map[key].push({
      site_id: id,
      job_code: code,
      task_date: asText(site.task_date),
      period: asPeriod(site.period)
    });
  });

  Object.keys(map).forEach(function (key) { map[key].sort(byTaskDateDesc); });

  return map;
}

/**
 * Newest first, undated last — a blank date is unknown, not ancient. ISO dates
 * sort correctly as strings, which is why task_date is stored as one (2.3).
 */
function byTaskDateDesc(a, b) {
  if (!a.task_date && !b.task_date) return 0;
  if (!a.task_date) return 1;
  if (!b.task_date) return -1;
  return (a.task_date < b.task_date) ? 1 : ((a.task_date > b.task_date) ? -1 : 0);
}

/**
 * Choose which of a site's job codes an entry on a given day means.
 *
 * "The task that was open when the work happened": the latest task_date on or
 * before the entry's day. Two fallbacks, both for when that finds nothing —
 * every task is dated after the entry (take the earliest, the nearest thing to
 * it), or the row has no usable day yet (take the newest, the likeliest).
 *
 * Kept identical to pickSiteJcCandidate() in Admin.gs.
 *
 * @param {Array<Object>} candidates newest first.
 * @param {string} [entryIso] the entry's day as `YYYY-MM-DD`.
 * @return {Object|null}
 */
export function pickCandidate(candidates, entryIso) {
  const list = candidates || [];
  if (!list.length) return null;

  const day = asText(entryIso);
  if (day) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].task_date && list[i].task_date <= day) return list[i];
    }
    for (let j = list.length - 1; j >= 0; j--) {
      if (list[j].task_date) return list[j];
    }
  }

  return list[0];
}

/**
 * Every job code the lookup holds for one site.
 * @param {string} segment a single site id, not a `/`-joined cell.
 * @param {Object|null} map
 * @return {Array<Object>}
 */
export function candidatesFor(segment, map) {
  if (!map) return [];
  return map[asText(segment).toUpperCase()] || [];
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
 * @param {string} [entryIso] the day the entry is settling, `YYYY-MM-DD`.
 * @return {{segments: Array<string>, codes: Array<string>, job_code: string,
 *           period: string, unknown: Array<string>, known: number,
 *           options: Array<Object>, ambiguous: boolean}}
 *         `options` is the full candidate list for a SINGLE-site cell that has
 *         more than one job code — what the grid offers the coordinator to
 *         switch between. A multi-site cell offers none: there is no one column
 *         of alternatives when each segment has its own.
 */
export function resolveSite(cell, map, entryIso) {
  const segments = splitMulti(cell);
  const empty = {
    segments: segments, codes: [], job_code: '', period: '',
    unknown: [], known: 0, options: [], ambiguous: false
  };

  if (!segments.length || !map) return empty;

  const codes = [];
  const unknown = [];
  let period = '';
  let known = 0;
  let options = [];
  let ambiguous = false;

  segments.forEach(function (segment) {
    const candidates = candidatesFor(segment, map);
    const hit = pickCandidate(candidates, entryIso);

    if (!hit) {
      // The blank holds the position, so site i still lines up with code i (6.4).
      codes.push('');
      unknown.push(segment);
      return;
    }

    codes.push(hit.job_code);
    known++;
    if (candidates.length > 1) ambiguous = true;
    if (segments.length === 1 && candidates.length > 1) options = candidates;

    // First known segment wins the period.
    if (!period && hit.period) period = hit.period;
  });

  return {
    segments: segments,
    codes: codes,
    job_code: codes.join('/'),
    period: period,
    unknown: unknown,
    known: known,
    options: options,
    ambiguous: ambiguous
  };
}

/**
 * The day a grid row is settling, as `YYYY-MM-DD`.
 *
 * The row carries a month label and a day number; the year comes from the
 * settlement (2.2). All three are needed, and a half-typed row simply has no
 * date — which pickCandidate() handles rather than guessing at.
 *
 * @param {Object} row
 * @param {*} fiscalYear
 * @return {string}
 */
export function rowEntryDate(row, fiscalYear) {
  return entryDate(fiscalYear, row && row.month, row && row.day);
}

/**
 * Apply the lookup to one row, in place.
 *
 * Three refusals, all deliberate:
 *
 *   - When NOTHING resolved, the row is left completely alone. 6.3 says an
 *     unknown site warns and leaves `job_code`/`period` for the coordinator to
 *     set; overwriting what he typed with a blank would be the opposite of that,
 *     and it would also wipe a Job Code that arrived with a paste.
 *   - When the coordinator has set the period HIMSELF, autofill does not touch
 *     it again (rule 14). `_period_manual` is the flag, set by the grid's own
 *     period cell — see onPeriodCommit().
 *   - When he has chosen a Job Code himself, the same (`_jc_manual`). A site
 *     with several job codes is a question only he can answer, so once he has
 *     answered it, moving the day underneath him must not silently re-answer it.
 *
 * `__jc_options` is hung off the row for the grid to render the picker from. It
 * is view state, not data: the double underscore keeps it out of the draft
 * mirror and the save payload.
 *
 * @param {Object} row a grid row, mutated.
 * @param {Object|null} map
 * @param {string} [entryIso] the day the row is settling.
 * @return {{changed: Array<string>, unknown: Array<string>, known: number,
 *           options: Array<Object>}}
 */
export function autofillRow(row, map, entryIso) {
  const result = resolveSite(row.site_id, map, entryIso);
  const changed = [];

  row.__jc_options = result.options;

  if (result.known > 0) {
    if (!row._jc_manual && asText(row.job_code) !== result.job_code) {
      row.job_code = result.job_code;
      changed.push('job_code');
    }

    if (!row._period_manual && result.period && asPeriod(row.period) !== result.period) {
      row.period = result.period;
      changed.push('period');
    }
  }

  return {
    changed: changed,
    unknown: result.unknown,
    known: result.known,
    options: result.options
  };
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

/**
 * The same bargain for the Job Code: a code typed or picked by hand is his, and
 * clearing the cell hands it back to the lookup.
 *
 * @param {Object} row
 * @param {*} value
 */
export function onJobCodeCommit(row, value) {
  row._jc_manual = asText(value) !== '';
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
 * Four fields matter here, not one. The Site ID resolves the row; the Job Code
 * and the period record that he answered for himself; and `month` / `day` move
 * the date the job code is chosen BY, so they re-resolve it — which is what
 * makes "site first, day after" (the order people actually type in) land on the
 * same job code as the other way round.
 *
 * @param {Object} options
 * @param {Function} options.getMap returns the current map (may be null).
 * @param {Function} [options.getFiscalYear] the settlement's fiscal year, for
 *        turning the row's month + day into a date.
 * @param {Function} [options.onResolved] called as (row, result) after a site
 *        cell resolves — the page uses it to say what happened.
 * @return {Function} (row, field, value, controller)
 */
export function makeAutofillHook(options = {}) {
  const getMap = options.getMap || siteJcMap;
  const getFiscalYear = options.getFiscalYear || function () { return ''; };

  const resolve = function (row, controller, announce) {
    const result = autofillRow(row, getMap(), rowEntryDate(row, getFiscalYear()));

    // Push the changed values into their cells WITHOUT a re-render, so the
    // caret stays wherever the coordinator just moved it (5.3). syncRow also
    // repaints the row's job-code picker from the `__jc_options` just set.
    if (controller && controller.syncRow) controller.syncRow(row, result.changed);

    if (announce && typeof options.onResolved === 'function') options.onResolved(row, result);
  };

  return function (row, field, value, controller) {
    if (field === 'period') {
      onPeriodCommit(row, value);
      return;
    }

    if (field === 'job_code') {
      onJobCodeCommit(row, value);
      return;
    }

    if (field === 'site_id') {
      // A new site makes any hand-picked job code meaningless.
      row._jc_manual = false;
      resolve(row, controller, true);
      return;
    }

    // A date change re-picks the job code, quietly — the coordinator is editing
    // a day, and a toast about sites he has already entered would be noise.
    if (field === 'month' || field === 'day') resolve(row, controller, false);
  };
}
