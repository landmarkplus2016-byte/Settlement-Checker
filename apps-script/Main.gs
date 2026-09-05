/**
 * Main.gs — the single Web App endpoint.
 *
 * One deployment, one doPost, action-dispatched (CLAUDE.md 3.1):
 *   { "action": "confirm_track", "token": "<uuid>", "payload": { ... } }
 *
 * The ACTIONS table below is the whole routing surface. Adding an action means
 * adding one line here plus its handler in the file that owns it. `auth: true`
 * is the default posture — session validation runs before the handler for every
 * action except ping, get_config and login (3.8).
 */

/**
 * Health check. Deployed as "Execute as: Me", access "Anyone".
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function doGet(e) {
  return okResponse({ service: 'Settlement Checker API', version: '1.0' });
}

/**
 * The API. Always answers with the response envelope — a throw anywhere below
 * becomes a typed error, or server_error when it is not one of ours.
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  try {
    var body = parseRequestBody(e);

    var action = normalizeKey(body.action);
    if (!action) return errResponse('validation_failed', 'missing_action');

    var token = normalizeKey(body.token);
    var payload = body.payload || {};

    return dispatch(action, token, payload);

  } catch (err) {
    return errorToResponse(err);
  }
}

/**
 * The routing table. Every handler is called as handler(session, payload) and
 * returns plain data; dispatch() wraps it in the success envelope. `session` is
 * null for the three public actions.
 */
var ACTIONS = {

  /* --- public: no token (3.1 / 3.3) --- */
  ping: {
    auth: false,
    handler: function (session, payload) { return { pong: true, at: nowIso() }; }
  },
  get_config: {
    auth: false,
    handler: function (session, payload) { return handleGetConfig(); }
  },
  login: {
    auth: false,
    handler: function (session, payload) { return handleLogin(payload); }
  },

  /* --- authenticated --- */
  logout: {
    auth: true,
    handler: function (session, payload) { return handleLogout(session); }
  },
  update_config: {
    auth: true,
    handler: function (session, payload) { return handleUpdateConfig(session, payload); }
  },

  /*
   * Admin (3.4) — all manager-only, enforced by requireManager() inside each
   * handler in Admin.gs rather than here, so the guard travels with the code
   * that does the writing (rule 5).
   *
   * reset_user_password is the one exception and is NOT manager-only at any
   * level: the handler distinguishes changing your own password (any role — the
   * forced-reset flow of 4.3) from changing someone else's (manager-only).
   */

  /* people / the coordinator registry */
  list_users: {
    auth: true,
    handler: function (session, payload) { return handleListUsers(session, payload); }
  },
  create_user: {
    auth: true,
    handler: function (session, payload) { return handleCreateUser(session, payload); }
  },
  update_user: {
    auth: true,
    handler: function (session, payload) { return handleUpdateUser(session, payload); }
  },
  reset_user_password: {
    auth: true,
    handler: function (session, payload) { return handleResetUserPassword(session, payload); }
  },
  deactivate_user: {
    auth: true,
    handler: function (session, payload) { return handleDeactivateUser(session, payload); }
  },

  /* teams */
  list_teams: {
    auth: true,
    handler: function (session, payload) { return handleListTeams(session, payload); }
  },
  create_team: {
    auth: true,
    handler: function (session, payload) { return handleCreateTeam(session, payload); }
  },
  update_team: {
    auth: true,
    handler: function (session, payload) { return handleUpdateTeam(session, payload); }
  },

  /* the Site -> Job Code lookup */
  list_site_jc: {
    auth: true,
    handler: function (session, payload) { return handleListSiteJc(session, payload); }
  },
  upsert_site_jc: {
    auth: true,
    handler: function (session, payload) { return handleUpsertSiteJc(session, payload); }
  },
  bulk_import_site_jc: {
    auth: true,
    handler: function (session, payload) { return handleBulkImportSiteJc(session, payload); }
  },
  delete_site_jc: {
    auth: true,
    handler: function (session, payload) { return handleDeleteSiteJc(session, payload); }
  },

  /* dropdown reference data */
  list_lists: {
    auth: true,
    handler: function (session, payload) { return handleListLists(session, payload); }
  },
  update_lists: {
    auth: true,
    handler: function (session, payload) { return handleUpdateLists(session, payload); }
  },

  /*
   * Coordinator (3.5) — all seven resolve the target spreadsheet from the
   * SESSION and reject a non-coordinator, inside the handler (Coordinator.gs's
   * coordinatorContext). The guard travels with the code that opens the sheet,
   * so no route can be added here that skips it.
   */
  get_my_settlements: {
    auth: true,
    handler: function (session, payload) { return handleGetMySettlements(session, payload); }
  },
  create_settlement: {
    auth: true,
    handler: function (session, payload) { return handleCreateSettlement(session, payload); }
  },
  update_settlement: {
    auth: true,
    handler: function (session, payload) { return handleUpdateSettlement(session, payload); }
  },
  delete_settlement: {
    auth: true,
    handler: function (session, payload) { return handleDeleteSettlement(session, payload); }
  },
  list_entries: {
    auth: true,
    handler: function (session, payload) { return handleListEntries(session, payload); }
  },
  save_entries: {
    auth: true,
    handler: function (session, payload) { return handleSaveEntries(session, payload); }
  },
  delete_entry: {
    auth: true,
    handler: function (session, payload) { return handleDeleteEntry(session, payload); }
  },
  delete_entries: {
    auth: true,
    handler: function (session, payload) { return handleDeleteEntries(session, payload); }
  },
  confirm_track: {
    auth: true,
    handler: function (session, payload) { return handleConfirmTrack(session, payload); }
  },

  /*
   * Manager (3.6) — consolidated across every coordinator. All four are
   * manager-only, enforced inside Manager.gs by requireManager() and by
   * resolveCoordinatorSheetAsManager(), which is the ONE path that reaches
   * another user's sheet. The guard travels with the code that opens the
   * spreadsheet, so no route added here can bypass it (rule 5).
   */
  list_pending: {
    auth: true,
    handler: function (session, payload) { return handleListPending(session, payload); }
  },
  approve_entry: {
    auth: true,
    handler: function (session, payload) { return handleApproveEntry(session, payload); }
  },
  return_entry: {
    auth: true,
    handler: function (session, payload) { return handleReturnEntry(session, payload); }
  },
  approve_batch: {
    auth: true,
    handler: function (session, payload) { return handleApproveBatch(session, payload); }
  },

  /*
   * Export (3.7) — manager-only, enforced inside Export.gs. `export_query` only
   * reads; `export_commit` is the atomic claim that stamps rows `exported` and
   * is the ONLY writer of that status anywhere in the app (rule 16).
   */
  export_query: {
    auth: true,
    handler: function (session, payload) { return handleExportQuery(session, payload); }
  },
  export_commit: {
    auth: true,
    handler: function (session, payload) { return handleExportCommit(session, payload); }
  },

  /*
   * Not in 3.7's list of two. 7.3 requires the Export screen to show the log of
   * what has already gone out, and no action in 3.7 can read it — this is the
   * read for that screen, and nothing else. See handleListExportLog().
   */
  list_export_log: {
    auth: true,
    handler: function (session, payload) { return handleListExportLog(session, payload); }
  },

  /*
   * Also not in 3.7's two. The per-site report (6.4) is built AFTER a batch has
   * been exported, from that batch's own rows — this is the read that fetches
   * them. It writes nothing and can claim nothing; `export_commit` is still the
   * only writer of `exported` (rule 16). See handleExportBatchRows().
   */
  export_batch_rows: {
    auth: true,
    handler: function (session, payload) { return handleExportBatchRows(session, payload); }
  }
};

/**
 * Route one action.
 *
 * Order matters: an unrecognised action is rejected as unknown_action *before*
 * the token is looked at, so a typo does not come back as an auth failure. The
 * action list is public API surface, not a secret.
 *
 * @param {string} action
 * @param {string} token session token; ignored for public actions.
 * @param {Object} payload
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function dispatch(action, token, payload) {
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
    return errResponse('validation_failed', 'unknown_action');
  }

  var route = ACTIONS[action];
  var session = route.auth ? validateSession(token) : null;

  return okResponse(route.handler(session, payload));
}

/**
 * Read the POST body as JSON. The frontend posts text/plain to avoid a CORS
 * preflight, so never rely on e.postData.type.
 *
 * @param {Object} e the doPost event.
 * @return {Object}
 * @throws {Object} appError('validation_failed', 'malformed_json')
 */
function parseRequestBody(e) {
  var raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
  if (!String(raw).trim()) throw appError('validation_failed', 'malformed_json');

  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw appError('validation_failed', 'malformed_json');
  }

  if (!parsed || typeof parsed !== 'object' || parsed instanceof Array) {
    throw appError('validation_failed', 'malformed_json');
  }
  return parsed;
}

/**
 * Turn a thrown value into a response. Anything carrying one of the fixed error
 * codes — appError(), or a bare {code:'forbidden'} — keeps that code, message
 * and field_errors. Anything else (a genuine bug, a Sheets failure) is reported
 * as server_error with its stack logged, not returned.
 *
 * @param {*} err
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function errorToResponse(err) {
  if (err && err.code && ERROR_CODES.indexOf(err.code) !== -1) {
    return errResponse(err.code, err.message, err.field_errors);
  }

  var detail = (err && err.stack) ? err.stack : String(err);
  console.error('Unhandled error: ' + detail);
  return errResponse('server_error', 'server_error');
}
