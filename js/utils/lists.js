/**
 * lists.js — matching a cell against its reference list (CLAUDE.md 6.6.4).
 *
 * Six grid columns are not free text: month, project, category, area, driver and
 * team all come from `Lists` or `Teams` (2.1). The grid renders them as selects
 * where it knows the options, which stops a coordinator TYPING a wrong one — but
 * a value can still reach a row without going through a select:
 *
 *   - a paste from Excel writes whatever the spreadsheet held (6.6.1), and a
 *     workbook that says `AUG` where the list says `Aug` is the ordinary case,
 *     not the exotic one;
 *   - the option lists load separately from the entries, so a row can be built
 *     before the client has anything to check it against;
 *   - a row typed months ago carries whatever it carried.
 *
 * The old behaviour was to keep such a value verbatim and quietly add it to the
 * select as an extra option, which made a mis-cased month indistinguishable from
 * a real one at a glance and put it into the export's Month column exactly as
 * typed. Worse for `team`: the export filter matches team by value, so a team
 * that does not match the Teams tab is a row that never appears in any file.
 *
 * So a value is matched against the list the way people read it — ignoring case,
 * leading and trailing space, and doubled spaces inside — and where it matches,
 * the LIST's spelling wins. `AUG` becomes `Aug`. What matches nothing is left
 * exactly as typed and warned about (`unknown_list_value` in validate.js): a
 * value nobody can resolve is a decision for the coordinator, and silently
 * blanking a cell is never the right answer to a typo.
 *
 * Deliberately NOT fuzzy. `listKey` folds whitespace and case and nothing else —
 * no dropped punctuation, no edit distance. `POC-3` and `POC3` stay two different
 * things, because guessing which one was meant is how the wrong job code ends up
 * on a finance file. The server applies the same rule in Coordinator.gs, which is
 * what makes it hold for every route into a sheet and not just this one.
 */

/**
 * The comparison form of a list value.
 *
 * Case-folded, ends trimmed, runs of whitespace collapsed to one space — the
 * three ways the same option is written by two different people. Everything else
 * is left alone.
 *
 * @param {*} value
 * @return {string} '' for blank.
 */
export function listKey(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The list's own spelling of `value`.
 *
 * @param {*} value the cell as it stands.
 * @param {Array<string>} options the reference list.
 * @return {string} the matching option, or '' when the list does not hold it
 *         (which includes the case of having no list at all).
 */
export function canonicalListValue(value, options) {
  const key = listKey(value);
  if (!key) return '';

  const list = options || [];
  for (let i = 0; i < list.length; i++) {
    if (listKey(list[i]) === key) return list[i];
  }

  return '';
}

/**
 * Is this cell something the list recognises?
 *
 * Two things count as "yes" without matching anything: a BLANK cell, which is
 * either fine or already flagged as a missing required field, and an EMPTY list,
 * which means the client never loaded the reference data and has no standing to
 * judge (the same reasoning validate.js applies to a missing Site→JC lookup).
 *
 * @param {*} value
 * @param {Array<string>} options
 * @return {boolean}
 */
export function isKnownListValue(value, options) {
  if (!options || !options.length) return true;
  if (listKey(value) === '') return true;

  return canonicalListValue(value, options) !== '';
}
