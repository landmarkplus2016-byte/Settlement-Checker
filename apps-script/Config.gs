/**
 * Config.gs — the shared Config tab (CLAUDE.md 2.1) and the two config actions
 * (3.3).
 *
 * get_config is the one authenticated-by-nobody action besides login: the app
 * calls it before the login screen to learn its own name and language. It must
 * therefore never return anything an anonymous caller shouldn't see — only the
 * four keys listed below.
 */

/** Fallbacks when a key is missing from the Config tab. */
var CONFIG_DEFAULTS = {
  app_name: 'Settlement Checker',
  company_name: '',
  primary_language: 'en',
  session_expiry_hours: 12,
  fiscal_new_from_year: 2026
};

/** The only keys update_config may write (3.3). Anything else is rejected. */
var CONFIG_WRITABLE_KEYS = [
  'app_name',
  'company_name',
  'primary_language',
  'session_expiry_hours',
  'fiscal_new_from_year'
];

/** The only keys get_config may return. Public — assume an anonymous reader. */
var CONFIG_PUBLIC_KEYS = [
  'app_name',
  'company_name',
  'primary_language',
  'session_expiry_hours'
];

/* Per-request cache (CLAUDE.md 2.4). */
var __configMapCache = null;

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/**
 * The Config tab as a flat { key: value } object, cached for this request.
 * Raw values — no defaults applied, no coercion. Use the typed getters below.
 * @return {Object}
 */
function getConfigMap() {
  if (__configMapCache) return __configMapCache;

  var rows = readAllRows(openConfigSpreadsheet(), 'Config');
  var map = {};

  for (var i = 0; i < rows.length; i++) {
    var key = normalizeKey(rows[i].key);
    if (!key) continue;
    map[key] = rows[i].value;
  }

  __configMapCache = map;
  return map;
}

/** Drop the cached Config map after a write. */
function invalidateConfigMap() {
  __configMapCache = null;
}

/**
 * A config value as a trimmed string, falling back to CONFIG_DEFAULTS.
 * @param {string} key
 * @return {string}
 */
function getConfigString(key) {
  var raw = getConfigMap()[key];
  var val = (raw === null || raw === undefined) ? '' : String(raw).trim();
  if (val !== '') return val;
  var fallback = CONFIG_DEFAULTS[key];
  return (fallback === undefined || fallback === null) ? '' : String(fallback);
}

/**
 * Session lifetime in hours (CLAUDE.md 4.1). A missing, non-numeric or
 * out-of-range value falls back to 12 rather than producing a session that
 * never expires.
 * @return {number}
 */
function getSessionExpiryHours() {
  var n = parseInt(getConfigMap().session_expiry_hours, 10);
  if (!isFinite(n) || n < 1 || n > 720) return CONFIG_DEFAULTS.session_expiry_hours;
  return n;
}

/**
 * The year from which an unknown site defaults to the `new` period. Only used
 * when a site is absent from the SiteJC lookup (CLAUDE.md 2.1).
 * @return {number}
 */
function getFiscalNewFromYear() {
  var n = parseInt(getConfigMap().fiscal_new_from_year, 10);
  if (!isFinite(n) || n < 2000 || n > 2100) return CONFIG_DEFAULTS.fiscal_new_from_year;
  return n;
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

/**
 * `get_config` — no token (3.3). Returns the four public keys and nothing else.
 * @return {Object}
 */
function handleGetConfig() {
  return {
    app_name: getConfigString('app_name'),
    company_name: getConfigString('company_name'),
    primary_language: (getConfigString('primary_language') === 'ar') ? 'ar' : 'en',
    session_expiry_hours: getSessionExpiryHours()
  };
}

/**
 * `update_config` — manager-only, whitelisted keys (3.3).
 * Payload is a flat map of key -> value, or { updates: { key: value } }.
 *
 * @param {Object} session auth context from validateSession().
 * @param {Object} payload
 * @return {Object} { updated: [keys], config: {whitelisted values} }
 */
function handleUpdateConfig(session, payload) {
  requireManager(session);

  var body = payload || {};
  var updates = (body.updates && typeof body.updates === 'object' && !(body.updates instanceof Array))
    ? body.updates
    : body;

  var keys = Object.keys(updates);
  if (!keys.length) throw appError('validation_failed', 'no_updates');

  // Validate everything before writing anything, so a bad key cannot leave a
  // half-applied config behind.
  var fieldErrors = {};
  var clean = {};

  for (var i = 0; i < keys.length; i++) {
    var key = normalizeKey(keys[i]);
    if (CONFIG_WRITABLE_KEYS.indexOf(key) === -1) {
      fieldErrors[keys[i]] = 'unknown_config_key';
      continue;
    }
    try {
      clean[key] = validateConfigValue(key, updates[keys[i]]);
    } catch (err) {
      fieldErrors[key] = (err && err.message) ? err.message : 'invalid_value';
    }
  }

  if (Object.keys(fieldErrors).length) {
    throw appError('validation_failed', 'invalid_config', fieldErrors);
  }

  var ss = openConfigSpreadsheet();
  var applied = Object.keys(clean);
  var stamp = nowIso();

  for (var k = 0; k < applied.length; k++) {
    var name = applied[k];
    // updated_at / updated_by are dropped silently if the Config tab has no such
    // columns — the schema in 2.1 is key/value only.
    var patch = { value: clean[name], updated_at: stamp, updated_by: session.user_id };

    var existing = readRowByKey(ss, 'Config', 'key', name);
    if (existing) {
      updateRowByKey(ss, 'Config', 'key', name, patch);
    } else {
      patch.key = name;
      appendRow(ss, 'Config', patch);
    }
  }

  invalidateConfigMap();

  return {
    updated: applied,
    config: {
      app_name: getConfigString('app_name'),
      company_name: getConfigString('company_name'),
      primary_language: (getConfigString('primary_language') === 'ar') ? 'ar' : 'en',
      session_expiry_hours: getSessionExpiryHours(),
      fiscal_new_from_year: getFiscalNewFromYear()
    }
  };
}

/**
 * Coerce and range-check one config value.
 * @param {string} key a member of CONFIG_WRITABLE_KEYS.
 * @param {*} value
 * @return {string|number} the value to store.
 * @throws {Error} with a snake_case reason used as the field error.
 */
function validateConfigValue(key, value) {
  var str = (value === null || value === undefined) ? '' : String(value).trim();

  switch (key) {
    case 'app_name':
    case 'company_name':
      if (key === 'app_name' && str === '') throw new Error('required');
      if (str.length > 100) throw new Error('too_long');
      return str;

    case 'primary_language':
      if (str !== 'en' && str !== 'ar') throw new Error('must_be_en_or_ar');
      return str;

    case 'session_expiry_hours':
      var hours = parseInt(str, 10);
      if (!isFinite(hours) || String(hours) !== str) throw new Error('must_be_integer');
      if (hours < 1 || hours > 720) throw new Error('out_of_range');
      return hours;

    case 'fiscal_new_from_year':
      var year = parseInt(str, 10);
      if (!isFinite(year) || String(year) !== str) throw new Error('must_be_integer');
      if (year < 2000 || year > 2100) throw new Error('out_of_range');
      return year;

    default:
      throw new Error('unknown_config_key');
  }
}
