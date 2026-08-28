/**
 * Sheets.gs — low-level row helpers.
 *
 * Every helper takes a Spreadsheet as its first argument, because the app opens
 * many spreadsheets: one shared config sheet plus one per coordinator. The only
 * sheet id that ever appears in code is CONFIG_SS_ID below, and it lives here in
 * the Apps Script — never in the frontend (CLAUDE.md rule 3 / 9.3).
 *
 * A coordinator's sheet id is read from the Users registry at request time by
 * Registry.resolveCoordinatorSheet(session). Never hardcode one here.
 */

/**
 * The 'Settlement Config DB' spreadsheet id.
 * Paste the id from the sheet's URL:
 *   https://docs.google.com/spreadsheets/d/<THIS PART>/edit
 */
var CONFIG_SS_ID = 'PASTE_CONFIG_SPREADSHEET_ID_HERE';

/* Per-execution caches. Apps Script gives each request a fresh global scope, so
 * these are naturally per-request — no invalidation needed across requests. */
var __ssCache = {};
var __headerCache = {};

/* ------------------------------------------------------------------ *
 * Opening spreadsheets
 * ------------------------------------------------------------------ */

/**
 * Open a spreadsheet by id, memoised for this request.
 * @param {string} id
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 * @throws {Object} appError('not_found') when the id is blank or unreachable.
 */
function openById(id) {
  var key = String(id || '').trim();
  if (!key) throw appError('not_found', 'missing_spreadsheet_id');
  if (__ssCache[key]) return __ssCache[key];

  var ss;
  try {
    ss = SpreadsheetApp.openById(key);
  } catch (err) {
    throw appError('not_found', 'spreadsheet_not_found');
  }
  if (!ss) throw appError('not_found', 'spreadsheet_not_found');

  __ssCache[key] = ss;
  return ss;
}

/**
 * The shared config spreadsheet.
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function openConfigSpreadsheet() {
  if (!CONFIG_SS_ID || CONFIG_SS_ID.indexOf('PASTE_') === 0) {
    throw appError('server_error', 'config_spreadsheet_id_not_set');
  }
  return openById(CONFIG_SS_ID);
}

/* ------------------------------------------------------------------ *
 * Sheets and headers
 * ------------------------------------------------------------------ */

/**
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} name tab name, e.g. 'Users'.
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 * @throws {Object} appError('not_found') when the tab is missing.
 */
function getSheet(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw appError('not_found', 'sheet_not_found: ' + name);
  return sheet;
}

/**
 * Row 1 of a tab, as trimmed column keys. Cached per spreadsheet + tab for the
 * life of the request, so repeated reads cost one getValues() call.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} name
 * @return {Array<string>}
 */
function getHeaders(ss, name) {
  var key = ss.getId() + '::' + name;
  if (__headerCache[key]) return __headerCache[key];

  var sheet = getSheet(ss, name);
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) throw appError('server_error', 'sheet_has_no_headers: ' + name);

  var raw = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var headers = raw.map(function (h) {
    return (h === null || h === undefined) ? '' : String(h).trim();
  });

  __headerCache[key] = headers;
  return headers;
}

/**
 * Zero-based index of a column key in a tab's header row.
 * @return {number} -1 when absent.
 */
function getColumnIndex(ss, name, column) {
  return getHeaders(ss, name).indexOf(column);
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/**
 * Every data row of a tab as a plain object keyed by the header row.
 * Each object carries a non-column `_row` — its 1-based sheet row index — so a
 * caller that already scanned can write back without a second search. Strip it
 * before putting a row in an API response.
 * Fully blank rows are skipped.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} name
 * @return {Array<Object>}
 */
function readAllRows(ss, name) {
  var sheet = getSheet(ss, name);
  var headers = getHeaders(ss, name);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var rows = [];

  for (var r = 0; r < values.length; r++) {
    var raw = values[r];
    var isBlank = true;
    var obj = {};

    for (var c = 0; c < headers.length; c++) {
      var headerKey = headers[c];
      if (!headerKey) continue;
      var val = raw[c];
      if (val !== '' && val !== null && val !== undefined) isBlank = false;
      obj[headerKey] = val;
    }

    if (isBlank) continue;
    obj._row = r + 2;
    rows.push(obj);
  }

  return rows;
}

/**
 * First row whose `keyCol` equals `keyVal`. Comparison is on trimmed strings, so
 * a numeric-looking key ('377') matches whether Sheets stored it as text or a
 * number. Case-sensitive: the one place we match ids case-insensitively is the
 * SiteJC lookup, and that belongs in the SiteJC handler, not here.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} name
 * @param {string} keyCol
 * @param {*} keyVal
 * @return {Object|null}
 */
function readRowByKey(ss, name, keyCol, keyVal) {
  var headers = getHeaders(ss, name);
  if (headers.indexOf(keyCol) === -1) {
    throw appError('server_error', 'unknown_column: ' + name + '.' + keyCol);
  }

  var target = normalizeKey(keyVal);
  var rows = readAllRows(ss, name);

  for (var i = 0; i < rows.length; i++) {
    if (normalizeKey(rows[i][keyCol]) === target) return rows[i];
  }
  return null;
}

/** Trimmed string form of a key value, used for all key comparisons. */
function normalizeKey(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/**
 * Append one row, mapping `obj`'s keys onto the header row. Keys not present in
 * the header are ignored; headers not present in `obj` are written blank.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} name
 * @param {Object} obj
 * @return {Object} the written row, including its `_row` index.
 */
function appendRow(ss, name, obj) {
  var sheet = getSheet(ss, name);
  var headers = getHeaders(ss, name);
  var source = obj || {};

  var line = headers.map(function (headerKey) {
    if (!headerKey) return '';
    var val = source[headerKey];
    return (val === null || val === undefined) ? '' : val;
  });

  var rowIndex = sheet.getLastRow() + 1;
  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([line]);

  var written = {};
  for (var c = 0; c < headers.length; c++) {
    if (headers[c]) written[headers[c]] = line[c];
  }
  written._row = rowIndex;
  return written;
}

/**
 * Patch one row in place. Only keys that exist in the header row are applied;
 * every other cell keeps its current value. The whole row is written back in a
 * single setValues() call.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} name
 * @param {string} keyCol
 * @param {*} keyVal
 * @param {Object} updates
 * @return {Object|null} the updated row (with `_row`), or null when no row matched.
 */
function updateRowByKey(ss, name, keyCol, keyVal, updates) {
  var row = readRowByKey(ss, name, keyCol, keyVal);
  if (!row) return null;

  var sheet = getSheet(ss, name);
  var headers = getHeaders(ss, name);
  var patch = updates || {};

  var line = headers.map(function (headerKey) {
    if (!headerKey) return '';
    var val = Object.prototype.hasOwnProperty.call(patch, headerKey)
      ? patch[headerKey]
      : row[headerKey];
    return (val === null || val === undefined) ? '' : val;
  });

  sheet.getRange(row._row, 1, 1, headers.length).setValues([line]);

  var written = {};
  for (var c = 0; c < headers.length; c++) {
    if (headers[c]) written[headers[c]] = line[c];
  }
  written._row = row._row;
  return written;
}

/**
 * Remove one row entirely. The app hard-deletes exactly two things: an expired
 * Sessions row and a `draft` entry via delete_entry (CLAUDE.md 9.3). Everything
 * else is deactivated or status-changed, never deleted.
 *
 * @return {boolean} true when a row was removed.
 */
function deleteRowByKey(ss, name, keyCol, keyVal) {
  var row = readRowByKey(ss, name, keyCol, keyVal);
  if (!row) return false;

  getSheet(ss, name).deleteRow(row._row);
  return true;
}

/**
 * Grow a tab so `lastNeededRow` exists before setValues() addresses it.
 * getRange() throws rather than expanding when it runs past the sheet's declared
 * row count, and a freshly-made tab is often only 1000 rows — well under a real
 * month of entries or a full SiteJC import.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} lastNeededRow 1-based.
 */
function ensureRowCapacity(sheet, lastNeededRow) {
  var have = sheet.getMaxRows();
  if (lastNeededRow > have) sheet.insertRowsAfter(have, lastNeededRow - have);
}

/* ------------------------------------------------------------------ *
 * Batched read-modify-write
 * ------------------------------------------------------------------ */

/**
 * Read a whole tab into memory for a batched read-modify-write.
 *
 * updateRowByKey() re-reads the entire tab on every call, which is fine for the
 * one-row admin writes but quadratic for the things that touch many rows at
 * once: a grid save of 200 entries, a confirm that stamps a whole track, the
 * export's atomic claim. Those read the block ONCE, mutate it in memory, and
 * write it back in a single setValues().
 *
 * Usage:
 *   var block = openRowBlock(ss, 'Expenses');
 *   var rows = block.rows();                    // objects carrying `_offset`
 *   block.patch(rows[3]._offset, { status: 'confirmed' });
 *   block.append({ entry_id: 'E-000124', ... });
 *   block.flush();                              // two setValues() calls, at most
 *
 * The block is a SNAPSHOT. Anything that must not interleave with another
 * request — allocating ids, claiming rows — has to hold the script lock around
 * the open-mutate-flush cycle, exactly as withScriptLock() provides.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} name tab name.
 * @return {Object} the block handle.
 */
function openRowBlock(ss, name) {
  var sheet = getSheet(ss, name);
  var headers = getHeaders(ss, name);
  var width = headers.length;
  var lastRow = sheet.getLastRow();

  var data = (lastRow >= 2) ? sheet.getRange(2, 1, lastRow - 1, width).getValues() : [];

  var col = {};
  for (var c = 0; c < headers.length; c++) {
    if (headers[c]) col[headers[c]] = c;
  }

  var appends = [];
  var touched = false;

  return {
    headers: headers,
    data: data,

    /**
     * @param {string} key column name.
     * @return {number} zero-based index, or -1 when the tab has no such column.
     */
    columnOf: function (key) {
      return Object.prototype.hasOwnProperty.call(col, key) ? col[key] : -1;
    },

    /**
     * Every non-blank row as an object keyed by header, carrying `_offset` (its
     * index in the block, for patch()) and `_row` (its 1-based sheet row).
     * @return {Array<Object>}
     */
    rows: function () {
      var out = [];

      for (var r = 0; r < data.length; r++) {
        var line = data[r];
        var blank = true;
        var obj = {};

        for (var i = 0; i < headers.length; i++) {
          var key = headers[i];
          if (!key) continue;

          var value = line[i];
          if (value !== '' && value !== null && value !== undefined) blank = false;
          obj[key] = value;
        }

        if (blank) continue;

        obj._offset = r;
        obj._row = r + 2;
        out.push(obj);
      }

      return out;
    },

    /**
     * Patch one row in memory. Keys the tab does not have are ignored, so a
     * caller may hand over a superset of columns without checking first.
     *
     * @param {number} offset from a row's `_offset`.
     * @param {Object} updates
     */
    patch: function (offset, updates) {
      if (!data[offset]) return;

      var keys = Object.keys(updates || {});
      for (var i = 0; i < keys.length; i++) {
        var index = this.columnOf(keys[i]);
        if (index === -1) continue;

        var value = updates[keys[i]];
        data[offset][index] = (value === null || value === undefined) ? '' : value;
      }

      touched = true;
    },

    /**
     * Queue a new row for the bottom of the tab.
     * @param {Object} obj keyed by column name; missing columns are written blank.
     */
    append: function (obj) {
      var line = [];
      var source = obj || {};

      for (var i = 0; i < headers.length; i++) {
        var key = headers[i];
        var value = key ? source[key] : '';
        line.push((value === null || value === undefined) ? '' : value);
      }

      appends.push(line);
      touched = true;
    },

    /** @return {number} how many rows are queued for appending. */
    appendCount: function () { return appends.length; },

    /**
     * Write everything back. Nothing happens if nothing was changed.
     * @return {{updated: number, appended: number}}
     */
    flush: function () {
      if (!touched) return { updated: 0, appended: 0 };

      if (data.length) {
        sheet.getRange(2, 1, data.length, width).setValues(data);
      }

      if (appends.length) {
        ensureRowCapacity(sheet, lastRow + appends.length);
        sheet.getRange(lastRow + 1, 1, appends.length, width).setValues(appends);
      }

      return { updated: data.length, appended: appends.length };
    }
  };
}
