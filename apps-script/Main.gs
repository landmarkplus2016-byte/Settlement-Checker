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
 *
 * Later stages fill in the coordinator (3.5), manager (3.6), export (3.7) and
 * admin (3.4) actions here.
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
   * Admin (3.4). Only this one is live — the change-password screen needs it
   * (4.3). Stage 5.1 adds the other ten alongside it.
   *
   * Not manager-only at this level: the handler distinguishes changing your own
   * password from changing someone else's. See Admin.gs.
   */
  reset_user_password: {
    auth: true,
    handler: function (session, payload) { return handleResetUserPassword(session, payload); }
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
