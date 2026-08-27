/**
 * Utils.gs — response envelope, time, ids, and value coercion.
 *
 * Nothing in this file touches a Spreadsheet. See Sheets.gs for that.
 * Response envelope is fixed by CLAUDE.md 3.1:
 *   { "ok": true,  "data": { ... } }
 *   { "ok": false, "error": "<code>", "message": "...", "field_errors": null }
 */

/** The only error codes the API is allowed to return (CLAUDE.md 3.1). */
var ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'server_error'
];

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

/**
 * Serialise any object as a JSON web-app response.
 * @param {Object} obj
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Success envelope.
 * @param {Object} data payload returned to the client (defaults to {}).
 */
function okResponse(data) {
  return jsonResponse({ ok: true, data: (data === undefined || data === null) ? {} : data });
}

/**
 * Failure envelope. An unknown code is coerced to 'server_error' so the client
 * never has to handle a code that is not in the fixed list.
 * @param {string} code one of ERROR_CODES.
 * @param {string} message human-readable detail (also used as the machine reason,
 *                 e.g. 'unknown_action', 'malformed_json').
 * @param {Object=} fieldErrors optional map of field -> message.
 */
function errResponse(code, message, fieldErrors) {
  var safeCode = (ERROR_CODES.indexOf(code) === -1) ? 'server_error' : code;
  return jsonResponse({
    ok: false,
    error: safeCode,
    message: message || safeCode,
    field_errors: fieldErrors || null
  });
}

/**
 * Build a typed error to throw from a handler. Main.gs turns anything carrying a
 * recognised `code` back into the matching errResponse; anything else becomes
 * server_error.
 * @param {string} code one of ERROR_CODES.
 * @param {string} message
 * @param {Object=} fieldErrors
 * @return {Object}
 */
function appError(code, message, fieldErrors) {
  return {
    code: code,
    message: message || code,
    field_errors: fieldErrors || null,
    isAppError: true
  };
}

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

/** @return {string} current instant as an ISO-8601 UTC string. */
function nowIso() {
  return new Date().toISOString();
}

/** @return {string} today in the script's timezone as 'YYYY-MM-DD'. */
function todayIso() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** @return {string} a lowercase UUID, used for session tokens. */
function generateUuid() {
  return Utilities.getUuid();
}

/* ------------------------------------------------------------------ *
 * Coercion
 * ------------------------------------------------------------------ */

/**
 * Sheets stores booleans as the strings TRUE/FALSE, but a checkbox cell reads
 * back as a real boolean. Everything else is false.
 * @param {*} v
 * @return {boolean}
 */
function normalizeBoolean(v) {
  if (v === true) return true;
  if (typeof v === 'string' && v.trim().toUpperCase() === 'TRUE') return true;
  return false;
}

/**
 * Coerce a cell value to 'YYYY-MM-DD', or '' when it is not a date.
 * Handles: Date objects (what Sheets normally hands back), spreadsheet date
 * serials (days since 1899-12-30, seen when a column is read as a number), and
 * ISO / ISO-datetime strings.
 * @param {*} v
 * @return {string}
 */
function normalizeIsoDate(v) {
  if (v === null || v === undefined || v === '') return '';

  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  if (typeof v === 'number' && isFinite(v)) {
    // Spreadsheet serial: day 0 is 1899-12-30. Compute in UTC so the calendar
    // day the sheet shows is the calendar day we return.
    var ms = Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000;
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  }

  var s = String(v).trim();
  if (s === '') return '';

  // Already 'YYYY-MM-DD' (possibly with a time part) — take the date half.
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];

  var parsed = new Date(s);
  if (isNaN(parsed.getTime())) return '';
  return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * Coerce a cell value to a Date, keeping the time of day — the datetime
 * counterpart of normalizeIsoDate(), needed for `expires_at` comparisons.
 * Handles Date objects, spreadsheet serials (fractional day = time), and
 * ISO / ISO-datetime strings.
 * @param {*} v
 * @return {Date|null} null when the value is blank or unparseable.
 */
function parseTimestamp(v) {
  if (v === null || v === undefined || v === '') return null;

  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? null : v;
  }

  if (typeof v === 'number' && isFinite(v)) {
    var d = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000));
    return isNaN(d.getTime()) ? null : d;
  }

  var parsed = new Date(String(v).trim());
  return isNaN(parsed.getTime()) ? null : parsed;
}

/* ------------------------------------------------------------------ *
 * Concurrency
 * ------------------------------------------------------------------ */

/**
 * Run `fn` while holding the script lock, so two requests cannot interleave a
 * read-then-write. Used for anything that allocates an id or claims rows —
 * login's single-session swap now, export_commit's atomic claim later.
 *
 * @param {function():*} fn
 * @param {number=} timeoutMs how long to wait for the lock (default 20000).
 * @return {*} whatever fn returns.
 * @throws {Object} appError('conflict','busy') when the lock cannot be taken.
 */
function withScriptLock(fn, timeoutMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(timeoutMs || 20000)) {
    throw appError('conflict', 'busy');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ *
 * Ids
 * ------------------------------------------------------------------ */

/**
 * Next id in a prefixed, zero-padded series (CLAUDE.md 2.3 / 3.8).
 *   nextId('U-',  ['U-001','U-004'])        -> 'U-005'
 *   nextId('E-',  ['E-000123'])             -> 'E-000124'
 *   nextId('T-',  [])                       -> 'T-001'
 *
 * The width is taken from the widest existing numeric part, so a series keeps the
 * padding it started with. `pad` overrides that (and sets it for an empty series).
 * Ids that do not match the prefix, or whose tail is not numeric, are ignored.
 *
 * @param {string} prefix e.g. 'U-', 'E-'.
 * @param {Array<string>} existingIds
 * @param {number=} pad optional fixed width for the numeric part (default 3, or
 *        the widest width already present).
 * @return {string}
 */
function nextId(prefix, existingIds, pad) {
  var max = 0;
  var width = 0;
  var ids = existingIds || [];

  for (var i = 0; i < ids.length; i++) {
    var raw = (ids[i] === null || ids[i] === undefined) ? '' : String(ids[i]).trim();
    if (raw.indexOf(prefix) !== 0) continue;

    var tail = raw.substring(prefix.length);
    if (!/^\d+$/.test(tail)) continue;

    var n = parseInt(tail, 10);
    if (n > max) max = n;
    if (tail.length > width) width = tail.length;
  }

  var finalWidth = pad || width || 3;
  var next = String(max + 1);
  while (next.length < finalWidth) next = '0' + next;

  return prefix + next;
}
