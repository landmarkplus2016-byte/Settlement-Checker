/**
 * en.js — English strings (CLAUDE.md 8.1).
 *
 * Keys are snake_case and every key here has a twin in ar.js. Nothing visible
 * is ever written straight into JS (rule 22).
 *
 * Stage 3 seeds the chrome, the setup screen, login and the error codes. Later
 * stages append their own sections.
 */

export const en = {

  /* --- chrome --- */
  app_name: 'Settlement Checker',
  brand_name: 'Settlement',
  brand_tagline: 'Expense & Fuel · Ops',
  brand_mark: 'SC',

  nav_dashboard: 'Dashboard',
  nav_approvals: 'Approvals',
  nav_export: 'Export',
  nav_admin: 'Admin',
  nav_teams: 'Teams',
  nav_sitejc: 'Site → Job Code',
  nav_people: 'People',
  nav_lists: 'Lists',

  sign_out: 'Sign out',
  language: 'Language',
  lang_en: 'EN',
  lang_ar: 'AR',

  role_coordinator: 'Coordinator',
  role_manager: 'Manager',

  /* --- common --- */
  loading: 'Loading…',
  retry: 'Try again',
  cancel: 'Cancel',
  save: 'Save',
  close: 'Close',
  back: 'Back',

  /* --- first-run: the Apps Script URL (rule 2) --- */
  setup_title: 'Connect this device',
  setup_subtitle: 'Paste the Apps Script Web App URL. It is stored on this device only and is never part of the app.',
  setup_url_label: 'Apps Script Web App URL',
  setup_url_placeholder: 'https://script.google.com/macros/s/…/exec',
  setup_connect: 'Connect',
  setup_connecting: 'Connecting…',
  setup_url_required: 'Enter the Web App URL.',
  setup_url_invalid: 'That does not look like an Apps Script Web App URL.',
  setup_change_url: 'Change server URL',

  /* --- boot failure --- */
  boot_failed_title: 'Cannot reach the server',
  boot_failed_subtitle: 'The app could not load its configuration. Check the connection and the Web App URL, then try again.',

  /* --- login --- */
  login_title: 'Sign in',
  login_subtitle: 'Use your Settlement Checker account.',
  login_username: 'Username',
  login_username_placeholder: 'your.username',
  login_password: 'Password',
  login_submit: 'Sign in',
  login_working: 'Signing in…',
  login_username_required: 'Enter your username.',
  login_password_required: 'Enter your password.',
  login_welcome_back: 'Welcome back, {name}.',

  /* --- placeholders until Stage 4 builds the real shells --- */
  dashboard_title: 'Dashboard',
  signed_in_as: 'Signed in as {name}',
  placeholder_coordinator_dashboard: 'Your settlements will appear here. The coordinator dashboard and the entry grid arrive in the next stage.',
  placeholder_manager_dashboard: 'Consolidated coordinator activity will appear here. Approvals, export and admin arrive in the next stage.',
  change_password_title: 'Change your password',
  not_found_title: 'Page not found',
  not_found_subtitle: 'That screen does not exist.',
  go_to_dashboard: 'Go to dashboard',

  /* --- change password (4.3) --- */
  change_password_subtitle: 'Choose a new password for your account.',
  change_password_forced_subtitle: 'Set your own password before you continue.',
  change_password_forced_notice: 'Your account was given a temporary password. Choose your own to carry on.',
  change_password_new: 'New password',
  change_password_confirm: 'Confirm new password',
  change_password_hint: 'At least {min} characters.',
  change_password_submit: 'Set password',
  change_password_working: 'Saving…',
  change_password_required: 'Enter a new password.',
  change_password_too_short: 'Use at least {min} characters.',
  change_password_mismatch: 'The two passwords do not match.',
  change_password_success: 'Your password has been changed.',

  /* --- errors: by envelope code (CLAUDE.md 3.1) --- */
  err_validation_failed: 'Some of the information sent was not valid.',
  err_unauthenticated: 'Your session has ended. Please sign in again.',
  err_forbidden: 'You are not allowed to do that.',
  err_not_found: 'That item could not be found.',
  err_conflict: 'Someone else changed this first. Reload and try again.',
  err_server_error: 'The server had a problem. Try again in a moment.',
  err_network_error: 'No answer from the server. Check your connection.',
  err_script_url_missing: 'This device is not connected to a server yet.',
  err_unknown: 'Something went wrong.',

  /* --- errors: by server message, more specific than the code above --- */
  err_msg_invalid_credentials: 'Wrong username or password.',
  err_msg_invalid_login_payload: 'Enter your username and password.',
  err_msg_session_expired: 'Your session expired. Please sign in again.',
  err_msg_invalid_token: 'Your session is no longer valid. Please sign in again.',
  err_msg_missing_token: 'Please sign in again.',
  err_msg_user_inactive: 'This account has been deactivated.',
  err_msg_user_not_found: 'This account no longer exists.',
  err_msg_password_unchanged: 'That is your current password. Choose a different one.',
  err_msg_invalid_password: 'Enter a new password.',
  err_msg_invalid_password_hash: 'The password could not be sent securely. Reload the page and try again.',
  err_msg_manager_only: 'Only a manager can do that.',
  err_msg_unknown_action: 'This version of the app is out of date. Reload the page.',
  err_msg_malformed_json: 'The request could not be read by the server.',
  err_msg_malformed_response: 'The server sent an answer the app could not read.',
  err_msg_insecure_context: 'Passwords can only be hashed over HTTPS. Open the app over https://.'
};
